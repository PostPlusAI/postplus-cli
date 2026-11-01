import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseLibraryCommand, runLibraryCommand } from './library-commands.js';

test('permanent deletion cannot be confused with reversible archive', async () => {
  await assert.rejects(
    parseLibraryCommand(['delete', 'file-id', '--revision', '3']),
    /confirm-permanent/,
  );
  assert.deepEqual(
    await parseLibraryCommand(['archive', 'file-id', '--revision', '3']),
    {
      action: 'change_asset',
      change: {
        action: 'archive',
        asset_id: 'file-id',
        revision: 3,
        value: true,
      },
    },
  );
  assert.deepEqual(
    await parseLibraryCommand([
      'delete',
      'file-id',
      '--revision',
      '3',
      '--confirm-permanent',
    ]),
    {
      action: 'change_asset',
      change: {
        action: 'delete',
        asset_id: 'file-id',
        revision: 3,
        confirm_permanent: true,
      },
    },
  );
});
test('saving known brand facts never adopts them or invents missing fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'postplus-library-'));
  try {
    const file = path.join(directory, 'brand.json');
    await writeFile(file, JSON.stringify({ name: 'Known name' }));
    assert.deepEqual(
      await parseLibraryCommand([
        'brand-save',
        'stable-id',
        '--revision',
        '0',
        '--file',
        file,
      ]),
      {
        action: 'save_brand',
        brand_id: 'stable-id',
        expected_revision: 0,
        content: { name: 'Known name' },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(
    parseLibraryCommand(['brand-adopt', 'stable-id', '--revision', '1']),
    /request-id/,
  );
});
test('search retains opaque page identity and bounded filters for the common backend', async () => {
  const parsed = await parseLibraryCommand([
    'assets',
    '--query',
    'summer',
    '--cursor',
    'opaque',
    '--type',
    'image',
    '--favorites',
    '--json',
  ]);
  const query = parsed.query as Record<string, unknown>;
  assert.equal(query.cursor, 'opaque');
  assert.equal(query.favorite, true);
  assert.equal(query.type, 'image');
  await assert.rejects(
    parseLibraryCommand(['assets', '--revision', '2']),
    /Unexpected/,
  );
});
test('an uncertain response is reported once without creating another version', async () => {
  let calls = 0,
    output = '';
  const body = await parseLibraryCommand([
    'brand-adopt',
    'brand-id',
    '--revision',
    '2',
    '--request-id',
    'original-request',
  ]);
  const code = await runLibraryCommand(
    [
      'brand-adopt',
      'brand-id',
      '--revision',
      '2',
      '--request-id',
      'original-request',
    ],
    {
      request: async (actual) => {
        calls++;
        assert.deepEqual(actual, body);
        throw new TypeError('fetch failed');
      },
      output: (text) => (output += text),
    },
  );
  assert.equal(code, 2);
  assert.equal(calls, 1);
  assert.match(output, /exact same request/);
});
test('server conflicts keep their concrete error and are not retried', async () => {
  let calls = 0,
    output = '';
  const code = await runLibraryCommand(
    ['rename', 'asset-id', '--revision', '1', '--name', 'New name'],
    {
      request: async () => {
        calls++;
        return Response.json(
          {
            code: 'library_revision_conflict',
            error: 'Read the latest asset.',
          },
          { status: 409 },
        );
      },
      output: (text) => (output += text),
    },
  );
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.match(output, /library_revision_conflict/);
});
test('help never authenticates, reads content or transfers files', async () => {
  let output = '';
  assert.equal(
    await runLibraryCommand(
      ['brand-save', '--file', 'does-not-exist', '--help'],
      {
        request: async () => {
          throw new Error('unexpected auth');
        },
        output: (text) => (output += text),
      },
    ),
    0,
  );
  assert.match(output, /brand-adopt/);
});
test('website collection returns a review proposal through the same library action', async () => {
  assert.deepEqual(
    await parseLibraryCommand([
      'brand-website',
      '--url',
      'https://postplus.io',
    ]),
    { action: 'preview_brand_website', website: 'https://postplus.io' },
  );
});
test('saved Web outputs recover only by their original task identity',async()=>{
  assert.deepEqual(await parseLibraryCommand(['recover-task','original-task','--json']),{action:'recover_task_outputs',task_id:'original-task'});
});
test('authentication and compatibility failures retain the outer command recovery', async () => {
  const failure = new Error('Authentication requires sign-in');
  let output = '';
  await assert.rejects(
    runLibraryCommand(['brands'], {
      request: async () => {
        throw failure;
      },
      output: (text) => (output += text),
    }),
    (error) => error === failure,
  );
  assert.equal(output, '');
});
