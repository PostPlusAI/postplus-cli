import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChannelToolRequest,
  parseChannelToolCommand,
  shouldPollChannelTool,
} from './channel-tool-commands.js';

test('completed tool read retains its immediate data when --wait is used', () => {
  assert.equal(
    shouldPollChannelTool(true, {
      output: {
        execution: { resultStatus: 'succeeded' },
        result: { data: { rows: [1] } },
      },
    }),
    false,
  );
  assert.equal(
    shouldPollChannelTool(true, {
      output: { execution: { resultStatus: 'pending' } },
    }),
    true,
  );
});

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
    targetId: undefined,
    inputFile: '/tmp/tool-input.json',
    operationId: 'operation-123',
    wait: true,
  });
  assert.deepEqual(
    buildChannelToolRequest(parsed, { customer_id: '1234567890' }),
    {
      capability: 'marketing-channels',
      operation: 'execute-tool',
      operationId: 'operation-123',
      tool: 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
      connectionId: '11111111-1111-4111-8111-111111111111',
      target: { kind: 'connection' },
      arguments: { customer_id: '1234567890' },
    },
  );
  assert.throws(
    () => buildChannelToolRequest(parsed, ['not-an-object']),
    /JSON object/,
  );
  const exactTarget = parseChannelToolCommand([
    'run',
    'METAADS_LIST_LEADS',
    '--connection',
    '11111111-1111-4111-8111-111111111111',
    '--input-file',
    '/tmp/tool-input.json',
    '--target-id',
    'lead-form-123',
  ]);
  assert.equal(exactTarget.operation, 'run');
  if (exactTarget.operation === 'run') {
    assert.deepEqual(
      buildChannelToolRequest(exactTarget, {
        source_object_id: 'lead-form-123',
      }).target,
      { kind: 'external_id', id: 'lead-form-123' },
    );
  }
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
