import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { setLocalSession } from './local-state.js';

const exec = promisify(execFile);

async function writeFixtureCommand(bin: string, name: string, executable: string, args: string[]) {
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, `${name}.cmd`),
      `@"${executable}" ${args.map((arg) => `"${arg}"`).join(' ')} %*\r\n`);
  } else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(path.join(bin, name),
      `#!/bin/sh\nexec ${[executable, ...args].map(quote).join(' ')} "$@"\n`,
      { mode: 0o700 });
  }
}

test('recovery fixture handles space paths and fails closed when its runtime is missing', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "postplus fixture's space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const laterBin = path.join(root, 'later-bin');
  await mkdir(bin);
  await mkdir(laterBin);
  const node = path.join(root, 'node with spaces');
  await symlink(process.execPath, node);
  const script = path.join(root, 'fixture script.cjs');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  await writeFixtureCommand(bin, 'postplus', node, [script]);
  await writeFixtureCommand(laterBin, 'postplus', process.execPath, ['-e',
    'console.log("UNEXPECTED later PATH command");']);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${laterBin}` };
  const args = ['update', 'space argument', "quote'argument", '$HOME;echo unsafe'];
  const result = await exec('postplus', args, { env });
  assert.deepEqual(JSON.parse(result.stdout), args);
  await rm(node);
  await assert.rejects(exec('postplus', args, { env }), (error: unknown) => {
    const failure = error as { code: number; stdout: string };
    assert.ok([126, 127].includes(failure.code), `Expected shell launch failure, got ${failure.code}`);
    assert.equal(failure.stdout, '', 'must not execute the later PATH command');
    return true;
  });
  await rm(path.join(bin, 'postplus'));
  await assert.rejects(exec('postplus', args, { env: { ...env, PATH: bin } }),
    { code: 'ENOENT' });
});

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
    // The wrong installation on PATH must never receive update or task replay.
    const wrongCliMarker = path.join(root, 'wrong-cli');
    await writeFixtureCommand(bin, 'postplus', process.execPath, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(wrongCliMarker)}, 'called'); process.exit(99)`]);
    const updateMock = path.join(root, 'update-mock.mjs');
    await writeFile(updateMock, `
      import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
      if (process.argv[2] === 'update') {
        const statePath = ${JSON.stringify(statePath)};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state.updates++; writeFileSync(statePath, JSON.stringify(state));
        ${scenario === 'corrupt' ? `const dir = ${JSON.stringify(path.join(config, 'media-runs'))};
          writeFileSync(dir + '/' + readdirSync(dir)[0], '{}');` : ''}
        console.log(JSON.stringify({ok:true})); process.exit(0);
      }
    `);
    // Only explicitly allowed tools enter the child PATH. A broken or missing
    // fixture must never resolve to the user's installed PostPlus CLI.
    for (const command of ['ffmpeg', 'ffprobe']) {
      const located = await exec(process.platform === 'win32' ? 'where.exe' : 'which', [command]);
      const executable = located.stdout.trim().split(/\r?\n/)[0]!;
      assert.ok(path.isAbsolute(executable), `Expected an absolute ${command} path`);
      await writeFixtureCommand(bin, command, executable, []);
    }
    const output = path.join(root, 'original report.md');
    const env = { ...process.env, POSTPLUS_CONFIG_DIR: config,
      POSTPLUS_API_BASE_URL: 'https://postplus.test',
      POSTPLUS_CLIENT_RECOVERY_ATTEMPT: '', PATH: bin,
      NODE_OPTIONS: `--import=${JSON.stringify(mock)} --import=${JSON.stringify(updateMock)}` };
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
    await assert.rejects(readFile(wrongCliMarker), {code:'ENOENT'});
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
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.ok, false);
      if (scenario === 'corrupt') assert.match(JSON.stringify(failure.error), /Invalid media recovery checkpoint/);
      else {
        assert.match(result.stderr, /not retried again/);
        assert.equal(failure.error.code, 'postplus_client_upgrade_failed');
        assert.match(failure.error.action, /do not run another update/);
        assert.doesNotMatch(failure.error.action, /Run postplus update/);
      }
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
