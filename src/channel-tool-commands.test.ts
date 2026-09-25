import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChannelToolCommand } from './channel-tool-commands.js';

test('tool catalog queries preserve toolkit and search text', () => {
  assert.deepEqual(
    parseChannelToolCommand([
      'list',
      '--toolkit',
      'googleads',
      '--query',
      'campaign budget',
    ]),
    {
      operation: 'list',
      pathName:
        '/api/postplus-cli/channels/tools?toolkit=googleads&query=campaign+budget',
    },
  );
  assert.deepEqual(
    parseChannelToolCommand(['show', 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS']),
    {
      operation: 'show',
      pathName:
        '/api/postplus-cli/channels/tools?tool=GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    },
  );
});

test('tool run requires a personal connection and JSON input file', () => {
  const parsed = parseChannelToolCommand([
    'run',
    'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    '--connection',
    '11111111-1111-4111-8111-111111111111',
    '--input-file',
    '/tmp/tool-input.json',
    '--operation-id',
    'operation-123',
    '--wait',
  ]);
  assert.deepEqual(parsed, {
    operation: 'run',
    tool: 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    connectionId: '11111111-1111-4111-8111-111111111111',
    inputFile: '/tmp/tool-input.json',
    operationId: 'operation-123',
    wait: true,
  });
  assert.throws(
    () =>
      parseChannelToolCommand([
        'run',
        'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
        '--connection',
        'x',
      ]),
    /input-file/,
  );
  assert.throws(
    () => parseChannelToolCommand(['list', '--surprise', 'yes']),
    /Unknown/,
  );
});
