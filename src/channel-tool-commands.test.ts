import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChannelToolRequest,
  lostChannelToolSubmission,
  parseChannelToolCommand,
  runChannelToolCommand,
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

test('the sole run verb can inspect an existing operation without resubmitting it', () => {
  assert.deepEqual(parseChannelToolCommand(['run', '--status', 'op-123']), {
    operation: 'status',
    operationId: 'op-123',
  });
  assert.throws(
    () => parseChannelToolCommand(['run', '--status', 'op-123', '--wait']),
    /--status/,
  );
});

test('lost hosted submit response points to the original operation only', () => {
  assert.deepEqual(lostChannelToolSubmission('op-123'), {
    operationId: 'op-123',
    execution: { resultStatus: 'unknown' },
    next: 'Query postplus channels tools run --status op-123; never resubmit this write with a new operation ID.',
  });
});

test('CLI tool run submits one pinned envelope and status only inspects the original run', async () => {
  const bodies: unknown[] = [];
  const messages: string[] = [];
  const dependencies = {
    readInput: async () => '{"customer_id":"1234567890"}',
    submit: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return { output: { execution: { resultStatus: 'succeeded' } } };
    },
    output: (value: string) => messages.push(value),
    diagnostic: (value: string) => messages.push(value),
  };
  const args = [
    'run',
    'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    '--connection',
    '11111111-1111-4111-8111-111111111111',
    '--input-file',
    '/tmp/unused-fixture.json',
    '--operation-id',
    'op-123',
  ];
  assert.equal(await runChannelToolCommand(args, dependencies), 0);
  assert.deepEqual(bodies[0], {
    capability: 'marketing-channels',
    operation: 'execute-tool',
    operationId: 'op-123',
    tool: 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS',
    connectionId: '11111111-1111-4111-8111-111111111111',
    target: { kind: 'connection' },
    arguments: { customer_id: '1234567890' },
  });
  assert.equal(
    await runChannelToolCommand(['run', '--status', 'op-123'], dependencies),
    0,
  );
  assert.deepEqual(bodies[1], {
    capability: 'marketing-channels',
    operation: 'status',
    operationId: 'op-123',
  });
  assert.equal(bodies.length, 2);
});

test('CLI media map sends owned references through the same tool envelope', async () => {
  const bodies: unknown[] = [];
  const result = await runChannelToolCommand(
    [
      'run',
      'TIKTOK_UPLOAD_VIDEO',
      '--connection',
      '11111111-1111-4111-8111-111111111111',
      '--input-file',
      '/tmp/input.json',
      '--media-map-file',
      '/tmp/media.json',
      '--operation-id',
      'op-media',
    ],
    {
      readInput: async (path) =>
        path.endsWith('media.json')
          ? '{"file_to_upload":"postplus-media://uploads/users/alice/clip.mp4"}'
          : '{"caption":"test"}',
      submit: async ({ body }) => {
        bodies.push(body);
        return { output: { execution: { resultStatus: 'succeeded' } } };
      },
      output: () => {},
      diagnostic: () => {},
    },
  );
  assert.equal(result, 0);
  assert.deepEqual(bodies[0], {
    capability: 'marketing-channels',
    operation: 'execute-tool',
    operationId: 'op-media',
    tool: 'TIKTOK_UPLOAD_VIDEO',
    connectionId: '11111111-1111-4111-8111-111111111111',
    target: { kind: 'connection' },
    arguments: { caption: 'test' },
    mediaReferences: {
      file_to_upload: 'postplus-media://uploads/users/alice/clip.mp4',
    },
  });
});

test('CLI lost write response returns unknown without retrying provider submission', async () => {
  let attempts = 0;
  const messages: string[] = [];
  const code = await runChannelToolCommand(
    [
      'run',
      'GOOGLEADS_MUTATE_CAMPAIGNS',
      '--connection',
      '11111111-1111-4111-8111-111111111111',
      '--input-file',
      '/tmp/unused-fixture.json',
      '--operation-id',
      'op-lost',
    ],
    {
      readInput: async () =>
        '{"operations":[{"remove":"customers/123/campaigns/456"}]}',
      submit: async () => {
        attempts++;
        throw new Error('simulated response loss');
      },
      output: (value) => messages.push(value),
      diagnostic: (value) => messages.push(value),
    },
  );
  assert.equal(code, 2);
  assert.equal(attempts, 1);
  assert.match(messages.join(''), /run --status op-lost/);
  assert.match(messages.join(''), /"resultStatus": "unknown"/);
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
    targetPath: undefined,
    inputFile: '/tmp/tool-input.json',
    mediaMapFile: undefined,
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
    '--target-path',
    'source_object_id',
  ]);
  assert.equal(exactTarget.operation, 'run');
  if (exactTarget.operation === 'run') {
    assert.deepEqual(
      buildChannelToolRequest(exactTarget, {
        source_object_id: 'lead-form-123',
      }).target,
      { kind: 'external_id', id: 'lead-form-123', path: 'source_object_id' },
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
  assert.throws(
    () =>
      parseChannelToolCommand([
        'run',
        'METAADS_LIST_LEADS',
        '--connection',
        'c',
        '--input-file',
        '/tmp/a',
        '--target-id',
        'lead-form-123',
      ]),
    /--target-path/,
  );
});
