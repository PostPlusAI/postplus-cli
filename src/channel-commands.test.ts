import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChannelCommand, runChannelsCommand } from './channel-commands.js';

test('channel shell sends only product identity and operation', () => {
  assert.deepEqual(parseChannelCommand(['connect', 'meta-ads', '--json']), {
    method: 'POST',
    pathName: '/api/postplus-cli/channels',
    body: { operation: 'connect', channel: 'meta-ads' },
  });
  assert.deepEqual(parseChannelCommand(['list']), {
    method: 'GET',
    pathName: '/api/postplus-cli/channels',
  });
  assert.match(parseChannelCommand(['show', 'a/b']).pathName, /a%2Fb/);
  assert.deepEqual(parseChannelCommand(['disconnect', 'local-id']).body, {
    operation: 'disconnect',
    connectionId: 'local-id',
  });
});

test('channel shell rejects arbitrary tools, provider overrides and extra targets', () => {
  for (const args of [
    ['execute', 'TOOL'],
    ['connect', 'meta-ads', '--user-id', 'other'],
    ['list', 'other'],
    ['disconnect'],
    ['connect', 'a', 'b'],
  ]) {
    assert.throws(() => parseChannelCommand(args));
  }
});

test('legacy channel action verbs fail before any hosted request', async () => {
  for (const verb of ['actions', 'run', 'run-status'])
    await assert.rejects(runChannelsCommand([verb]), /retired/);
});

test('connection mutations with lost responses report unknown without retrying', async () => {
  for (const verb of ['connect', 'disconnect']) {
    let calls = 0;
    const output: string[] = [];
    const code = await runChannelsCommand([verb, 'fixture'], {
      request: async () => { calls++; throw new TypeError('fetch failed'); },
      output: (text) => output.push(text),
    });
    assert.equal(code, 2);
    assert.equal(calls, 1);
    const result = JSON.parse(output[0]!);
    assert.equal(result.execution.resultStatus, 'unknown');
    assert.match(result.next, /channels list/);
  }
  await assert.rejects(runChannelsCommand(['list'], {
    request: async () => { throw new TypeError('fetch failed'); },
  }), /fetch failed/);
  await assert.rejects(runChannelsCommand(['connect', 'fixture'], {
    request: async () => { throw new Error('configuration failure'); },
  }), /configuration failure/);
});
