import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { PostPlusFailure, toFailureFact } from './failure-contract.js';
import { runHostedDomainCommand } from './hosted-domain-commands.js';
import { setLocalSession, withPostPlusUpdateLock } from './local-state.js';
import { prepareMediaRunCheckpoint } from './media-run-checkpoint.js';
import { generateUpdateStatusReport } from './update-check.js';

async function isolateConfig(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'postplus-state-parse-'));
  const previous = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('truncated update cache fails with diagnostics before checking npm or remote releases', async (t) => {
  const root = await isolateConfig(t);
  const cache = join(root, 'update-check.json');
  let requests = 0;
  const unexpected = async (): Promise<never> => {
    requests++;
    throw new Error('must not access external state');
  };
  for (const raw of ['{"checkedAt":', 'private-business-content', 'null']) {
    await writeFile(cache, raw);
    await assert.rejects(generateUpdateStatusReport({}, {
      fetchFn: unexpected,
      runCommand: unexpected,
    }), (error: unknown) => {
      assert.ok(error instanceof PostPlusFailure);
      const fact = toFailureFact(error);
      assert.equal(fact.code, 'postplus_update_cache_invalid');
      assert.equal(fact.stage, 'update-cache-read');
      assert.equal(fact.service, 'filesystem');
      assert.equal(fact.retryable, false);
      assert.match(fact.action, /Preserve update-check.json/);
      assert.equal(fact.cause[1]?.name, 'SyntaxError');
      assert.doesNotMatch(JSON.stringify(fact), /private-business-content/);
      return true;
    });
    assert.equal(await readFile(cache, 'utf8'), raw);
  }
  assert.equal(requests, 0);
});

test('unreadable update cache retains its filesystem cause without deleting local state', async (t) => {
  const root = await isolateConfig(t);
  await mkdir(join(root, 'update-check.json'));
  await assert.rejects(generateUpdateStatusReport(), (error: unknown) => {
    assert.ok(error instanceof PostPlusFailure);
    const fact = toFailureFact(error);
    assert.equal(fact.code, 'postplus_update_cache_read_failed');
    assert.equal(fact.service, 'filesystem');
    assert.equal(fact.cause[1]?.code, 'EISDIR');
    return true;
  });
});

test('truncated media checkpoint blocks poll and same-operation preparation without paid resubmission', async (t) => {
  await isolateConfig(t);
  await setLocalSession({
    accountId: 'account_1', apiBaseUrl: 'https://postplus.test',
    cliSessionToken: 'fixture-token', sessionExpiresAt: null, userId: 'user_1',
  });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('must not submit or poll');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const checkpoint = await prepareMediaRunCheckpoint('media-generation', 'original-operation', null, undefined);
  assert.ok(checkpoint);
  const raw = '{"operationId":"original-operation","private-business-content":';
  await writeFile(checkpoint.filePath, raw);
  for (const run of [
    () => runHostedDomainCommand('media', ['poll', '--resume-from', checkpoint.filePath]),
    () => prepareMediaRunCheckpoint('media-generation', 'original-operation', null, undefined),
  ]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof PostPlusFailure);
      const fact = toFailureFact(error);
      assert.equal(fact.code, 'postplus_media_checkpoint_invalid');
      assert.equal(fact.stage, 'media-checkpoint-read');
      assert.equal(fact.service, 'filesystem');
      assert.equal(fact.retryable, false);
      assert.equal(fact.resumeAvailable, false);
      assert.match(fact.action, /do not delete it or submit a replacement task/);
      assert.equal(fact.cause[1]?.name, 'SyntaxError');
      assert.doesNotMatch(JSON.stringify(fact), /private-business-content|fixture-token/);
      return true;
    });
    assert.equal(await readFile(checkpoint.filePath, 'utf8'), raw);
  }
  assert.equal(requests, 0);
});


test('an active installation lock returns one structured blocking fact without running mutation', async (t) => {
  const root = await isolateConfig(t);
  const lock = join(root, '.postplus-skills-update.lock');
  await mkdir(lock);
  const owner = JSON.stringify({ pid: process.pid, operationStarted: true });
  await writeFile(join(lock, 'owner.json'), owner);
  let ran = false;
  await assert.rejects(withPostPlusUpdateLock(async () => { ran = true; }, {
    installationRoot: root, lockName: '.postplus-skills-update.lock', timeoutMs: 1, pollMs: 1,
  }), (error) => {
    const fact = toFailureFact(error);
    assert.equal(fact.code, 'postplus_update_in_progress');
    assert.equal(fact.stage, 'installation-lock');
    assert.equal(fact.retryable, false);
    assert.match(fact.action, /Wait for the active update/);
    return true;
  });
  assert.equal(ran, false);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), owner);
});
