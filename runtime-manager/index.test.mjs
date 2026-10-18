import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setup } from './index.mjs';
import { installRelease } from './installation.mjs';
import { TAR_EXECUTABLE } from './distribution.mjs';
import { formatFailure, toFailureFact, writeFailure } from '../build/failure-contract.js';
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'postplus-runtime-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('failed update preparation preserves the active record and old program', async t => {
  const root = await fixture(t);
  const active = 'old-active-record\n';
  await writeFile(join(root, 'active'), active);
  // Repair permits a corrupt old record, but still cannot replace it until
  // the newly approved artifacts have been fully prepared and verified.
  const bytes = Buffer.from('invalid tar');
  const artifact = { url: 'https://example.test/node.tar.gz', directory: 'node', sha256: createHash('sha256').update(bytes).digest('hex') };
  const release = { schemaVersion: 1, releaseId: 'fixture', cliVersion: '0.2.21', skillsReleaseId: 'skills-fixture',
    cli: artifact, node: { version: '24.21.0', artifacts: { [`${process.platform}-${process.arch}`]: artifact } } };
  await writeFile(join(root, 'old-program'), 'old executable retained');
  await assert.rejects(installRelease({ root, release, operation: 'update', repair: true,
    fetchFn: async () => new Response(bytes), run: async () => assert.fail('verification must not start') }), error => {
    const fact = toFailureFact(error);
    assert.equal(fact.component, 'node');
    assert.equal(fact.operation, 'update');
    assert.equal(fact.stage, 'artifact-extract');
    assert.equal(fact.targetVersion, '24.21.0');
    return true;
  });
  assert.equal(await readFile(join(root, 'active'), 'utf8'), active);
  assert.equal(await readFile(join(root, 'old-program'), 'utf8'), 'old executable retained');
});

test('skill setup wrapper forwards structured child diagnostics while preserving its public code', async t => {
  const root = await fixture(t);
  async function archive(name, files) {
    const source = join(root, name);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(source, name, path, '..'), { recursive: true });
      if (content === null) await copyFile(process.execPath, join(source, name, path));
      else await writeFile(join(source, name, path), content);
    }
    const path = join(root, `${name}.tar.gz`);
    await exec(TAR_EXECUTABLE, ['-czf', path, '-C', source, name]);
    return { path, artifact: { url: `https://example.test/${name}.tar.gz`, directory: name,
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') } };
  }
  const node = await archive('node', { [process.platform === 'win32' ? 'node.exe' : 'bin/node']: null });
  const child = { ok: false, error: { code: 'postplus_cloud_transport_failed', stage: 'artifact-request', service: 'external-http',
    component: 'skills', operation: 'update', version: 'skills-fixture', platform: `${process.platform}-${process.arch}`,
    currentVersion: 'skills-old', targetVersion: 'skills-fixture', retryable: false,
    recovery: { attempted: true, exhausted: true, nextActionAfterUserResolution: 'Continue the original task after resolving the network failure.' },
    action: 'Stop automatic recovery. Resolve the network failure.', message: 'Skill download failed.',
    originalUrl: 'https://user:password@skills.test/catalog?token=private', failureUrl: 'https://cdn.test/catalog?sig=private',
    httpStatus: 503, elapsedMs: 31, timeoutMs: 300000,
    cause: [{ name: 'Error', code: 'ENOTFOUND', message: 'lookup failed /Users/private-owner/cache token=private' }] } };
  const cli = await archive('cli', {
    'package.json': JSON.stringify({ name: '@postplus/cli', version: '0.2.21' }),
    'bundled-skills/skills-manifest.json': JSON.stringify({ releaseId: 'skills-fixture' }),
    'runtime-manager/index.mjs': 'export {};',
    'build/index.js': `if(process.argv.includes('--version')) console.log('0.2.21'); else {console.log(${JSON.stringify(JSON.stringify(child))});process.exitCode=9;}`,
  });
  const release = { schemaVersion: 1, releaseId: 'fixture', cliVersion: '0.2.21', skillsReleaseId: 'skills-fixture',
    cli: cli.artifact, node: { version: process.versions.node, artifacts: { [`${process.platform}-${process.arch}`]: node.artifact } } };
  await assert.rejects(setup({ root: join(root, 'installed'), release, command: 'update', nodeArchive: node.path, cliArchive: cli.path,
    fetchFn: async () => assert.fail('local archives must not fetch') }), error => {
    const fact = toFailureFact(error);
    assert.equal(fact.code, 'postplus_skills_setup_incomplete');
    assert.equal(fact.stage, 'skills-installation');
    assert.equal(fact.failureStage, 'artifact-request');
    assert.match(fact.action, /Stop automatic recovery\. Resolve the network failure\./);
    assert.equal(fact.recovery.exhausted, true);
    assert.equal(fact.recovery.nextActionAfterUserResolution, child.error.recovery.nextActionAfterUserResolution);
    assert.match(formatFailure(fact), /Stop automatic recovery\. Resolve the network failure\./);
    assert.equal(fact.httpStatus, 503);
    assert.equal(fact.elapsedMs, 31);
    assert.equal(fact.timeoutMs, 300000);
    assert.ok(fact.cause.some(item => item.code === 'ENOTFOUND'));
    assert.match(formatFailure(fact), /artifact-request/);
    assert.doesNotMatch(JSON.stringify(fact) + formatFailure(fact), /user:password|token=private|sig=private|private-owner/);
    const output = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = chunk => { output.push(String(chunk)); return true; };
    try { writeFailure(error, { json: true }); }
    finally { process.stdout.write = originalWrite; }
    const envelope = JSON.parse(output.join(''));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.failureStage, 'artifact-request');
    assert.equal(envelope.error.component, 'skills');
    assert.equal(envelope.error.version, 'skills-fixture');
    assert.equal(envelope.error.operation, 'update');
    assert.match(envelope.error.action, /Resolve the network failure/);
    assert.equal(envelope.error.recovery.exhausted, true);
    assert.equal(output.length, 1);
    return true;
  });
  assert.match(await readFile(join(root, 'installed/active'), 'utf8'), /postplus-installation-v1/);
});
