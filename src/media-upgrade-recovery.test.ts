import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { setLocalSession } from './local-state.js';

const exec = promisify(execFile);

// Real CLI processes and A's real update/replay runner; only provider HTTP and
// the installer are mocked. No test may reach a network or real installation.
for (const scenario of ['prepare-upload', 'analyze', 'status', 'unknown', 'corrupt', 'repeat', 'generation'] as const) {
  test(`A+C upgrade recovery preserves media identity: ${scenario}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'postplus-media-upgrade-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const oldConfig = process.env.POSTPLUS_CONFIG_DIR;
    process.env.POSTPLUS_CONFIG_DIR = config;
    try {
      await setLocalSession({
        accountId: 'account_1', accountName: 'Account',
        apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fixture-token',
        sessionExpiresAt: null, userEmail: 'fixture@example.com', userId: 'user_1',
      });
    } finally {
      if (oldConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
      else process.env.POSTPLUS_CONFIG_DIR = oldConfig;
    }
    const video = path.join(root, 'clip.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=blue:s=32x32:r=10', '-t', '0.2', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-y', video]);
    const statePath = path.join(root, 'state.json');
    await writeFile(statePath, JSON.stringify({ operations: [], uploads: 0, accepted: 0, updates: 0, rejected: false }));
    const mock = path.join(root, 'http-mock.mjs');
    await writeFile(mock, `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      const filename = ${JSON.stringify(statePath)};
      const scenario = ${JSON.stringify(scenario)};
      globalThis.fetch = async (url, init) => {
        const state = JSON.parse(readFileSync(filename, 'utf8'));
        const save = () => writeFileSync(filename, JSON.stringify(state));
        if (String(url).startsWith('https://generativelanguage.googleapis.com/upload/')) {
          const bytes = [];
          for await (const chunk of init.body) bytes.push(Buffer.from(chunk));
          assert.deepEqual(Buffer.concat(bytes), readFileSync(${JSON.stringify(video)}));
          state.uploads++; save();
          return Response.json({ file: { name: 'files/original-upload' } });
        }
        assert.equal(String(url), 'https://postplus.test/api/postplus-cli/hosted/capability');
        const body = JSON.parse(init.body);
        assert.equal(body.capability, scenario === 'generation' ? 'media-generation' : 'video-analysis');
        state.operations.push(body);
        if (body.operation === 'prepare-upload' || body.operation === 'analyze' || body.operation === 'request') {
          if (!state.operationId) state.operationId = body.operationId;
          assert.equal(body.operationId, state.operationId);
        }
        const phase = ['unknown', 'corrupt', 'repeat', 'generation'].includes(scenario) ? 'status' : scenario;
        if (body.operation === phase && (!state.rejected || scenario === 'repeat')) {
          state.rejected = true; save();
          return Response.json({ code: 'postplus_client_upgrade_required', error: 'Update required.',
            compatibility: { upgrade: { cli: { required: true }, restartAgentSession: false } }
          }, { status: 426 });
        }
        if (body.operation === 'prepare-upload') {
          save(); return Response.json({ output: {
            uploadUrl: 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=original',
            uploadToken: 'original-token', expiresAt: Date.now() + 60000,
          } });
        }
        if (body.operation === 'request') {
          state.accepted++; save();
          return Response.json({ output: { data: { id: 'original-run', status: 'accepted' } } });
        }
        if (body.operation === 'analyze') {
          assert.equal(body.input.video, 'postplus-video://original-token/files/original-upload');
          state.accepted++; save();
          if (scenario === 'unknown') throw new TypeError('Lost submit acknowledgement');
          return Response.json({ output: { data: { id: 'original-run', status: 'accepted', stage: 'analyzing' } } });
        }
        assert.equal(body.operation, 'status');
        if (body.handle) assert.equal(body.handle, 'original-run');
        else assert.equal(body.sourceOperationId, state.operationId);
        save(); return Response.json({ output: { data: {
          id: 'original-run', status: 'completed', stage: 'completed', markdown: '# Original report',
        } } });
      };
    `);
    const entry = path.resolve('src/index.ts');
    const shim = `
      const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const statePath = ${JSON.stringify(statePath)};
      const args = process.argv.slice(2);
      if (args[0] === 'update') {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state.updates++; writeFileSync(statePath, JSON.stringify(state));
        ${scenario === 'corrupt' ? `const dir = ${JSON.stringify(path.join(config, 'media-runs'))};
          writeFileSync(require('node:path').join(dir, readdirSync(dir)[0]), '{}');` : ''}
        console.log('Mock installer completed');
      } else {
        const result = spawnSync(${JSON.stringify(process.execPath)},
          ['--import', 'tsx', '--import', ${JSON.stringify(mock)}, ${JSON.stringify(entry)}, ...args],
          { env: process.env, stdio: 'inherit' });
        process.exitCode = result.status ?? 1;
      }
    `;
    const shimJs = path.join(bin, 'postplus.cjs');
    await writeFile(shimJs, shim);
    if (process.platform === 'win32') {
      await writeFile(path.join(bin, 'postplus.cmd'), `@"${process.execPath}" "${shimJs}" %*\r\n`);
    } else {
      await writeFile(path.join(bin, 'postplus'), `#!${process.execPath}\n${shim}`, { mode: 0o700 });
    }
    const output = path.join(root, 'original report.md');
    const env = { ...process.env, POSTPLUS_CONFIG_DIR: config,
      POSTPLUS_API_BASE_URL: 'https://postplus.test',
      POSTPLUS_CLIENT_RECOVERY_ATTEMPT: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const run = async (args: string[]) => {
      try {
        const result = await exec(process.execPath, ['--import', 'tsx', '--import', mock, entry, ...args], { env });
        return { ...result, code: 0 };
      } catch (error) {
        const result = error as { stdout: string; stderr: string; code: number };
        return { stdout: result.stdout, stderr: result.stderr, code: result.code };
      }
    };
    const original = scenario === 'generation'
      ? ['media', 'create', 'image-gpt-image-2-text', '--prompt', 'Original generation', '--wait', '--output', output, '--json']
      : ['media', 'analyze', 'video-analysis', '--video', video,
      '--prompt', 'Retain original intent & text', '--output', output, '--json'];
    let result = await run(original);
    const checkpointDir = path.join(config, 'media-runs');
    const files = await readdir(checkpointDir);
    assert.equal(files.length, 1, 'automatic replay must never create a second identity');
    const checkpointPath = path.join(checkpointDir, files[0]!);
    if (scenario === 'unknown') {
      assert.notEqual(result.code, 0);
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
      result = await run([...original, '--hosted-operation-id', checkpoint.operationId]);
    }
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.updates, 1);
    assert.equal(state.uploads, scenario === 'generation' ? 0 : 1);
    assert.equal(state.accepted, 1, 'one accepted analysis across update/recovery');
    assert.equal((await readdir(checkpointDir)).length, 1);
    if (scenario === 'corrupt' || scenario === 'repeat') {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, scenario === 'corrupt' ? /Invalid media recovery checkpoint/ : /not retried again/);
      assert.equal(result.stdout, '', 'installer output cannot contaminate JSON');
    } else {
      assert.equal(result.code, 0, result.stderr);
      if (scenario === 'generation') {
        assert.equal(JSON.parse(result.stdout).output.data.id, 'original-run');
        assert.equal(JSON.parse(await readFile(output, 'utf8')).output.data.status, 'completed');
      } else {
        assert.equal(JSON.parse(result.stdout), '# Original report');
        assert.equal(JSON.parse(await readFile(output, 'utf8')), '# Original report');
      }
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
      assert.equal(checkpoint.operationId, state.operationId);
      if (scenario === 'generation') assert.equal(checkpoint.handle, 'original-run');
      else {
        assert.equal(checkpoint.videoTransfer.uploadToken, 'original-token');
        assert.equal(checkpoint.videoTransfer.fileName, 'files/original-upload');
        assert.equal(checkpoint.videoRequest.prompt, 'Retain original intent & text');
      }
    }
    t.diagnostic(`exit=${result.code}; updates=${state.updates}; uploads=${state.uploads}; accepted=${state.accepted}; operations=${state.operations.map((o: { operation: string }) => o.operation).join(',')}`);
  });
}
