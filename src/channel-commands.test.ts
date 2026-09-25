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
