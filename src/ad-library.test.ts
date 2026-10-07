import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdLibraryCommand, runAdLibraryCommand } from './ad-library.js';

test('search combines single filters and encodes user input', () => {
  const result = parseAdLibraryCommand(['search', '--query', 'AI & notes', '--brand', 'plaud', '--visual-format', 'product-demo', '--product-type', 'hardware', '--status', 'unknown', '--limit', '50', '--offset', '10000']);
  const url = new URL(result.path, 'https://postplus.io');
  assert.equal(url.searchParams.get('query'), 'AI & notes');
  assert.equal(url.searchParams.get('visual-format'), 'product-demo');
  assert.equal(url.searchParams.get('brand'), 'plaud');
});

test('rejects unsupported flags, duplicate filters, and unbounded pagination before network', async () => {
  for (const args of [
    ['search', '--limit', '51'], ['search', '--limit', '0'], ['search', '--offset', '10001'],
    ['search', '--offset', '-1'], ['search', '--limit', '1.5'], ['search', '--brand'],
    ['search', '--status', 'all'], ['search', '--product-type', 'other'],
    ['search', '--brand', 'one', '--brand', 'two'], ['search', '--query', 'x'.repeat(201)],
    ['formats', '--query', 'test'], ['search', '--wait'], ['unknown'],
  ]) {
    await assert.rejects(runAdLibraryCommand(args, { request: async () => { assert.fail('must validate before network'); }, output: () => {} }));
  }
});

test('public GET calls only selected library endpoint without authentication, quote, or provider submission', async () => {
  for (const operation of ['search', 'formats', 'categories']) {
    let calls = 0;
    const code = await runAdLibraryCommand([operation, '--json'], {
      baseUrl: 'https://example.test', output: () => {},
      request: async (url, init) => {
        calls++;
        assert.equal(url.pathname, operation === 'search' ? '/api/ad-library' : `/api/ad-library/${operation}`);
        assert.equal(init.method, 'GET');
        assert.deepEqual(init.headers, { Accept: 'application/json' });
        assert.equal(init.body, undefined);
        assert.equal(init.redirect, 'error');
        return Response.json({ schemaVersion: 1, items: [], coverage: 'stored-snapshots' });
      },
    });
    assert.equal(code, 0); assert.equal(calls, 1);
  }
});

test('help is local and explains snapshot limits', async () => {
  let output = '';
  await runAdLibraryCommand(['--help'], { output: text => { output += text; }, request: async () => { assert.fail('help is local'); } });
  assert.match(output, /No login or credits/); assert.match(output, /not live Meta/);
});

test('network and response failures stop without fallback', async () => {
  for (const request of [async () => { throw new Error('network secret'); }, async () => new Response('', { status: 503 }), async () => Response.json({ items: [] })]) {
    await assert.rejects(runAdLibraryCommand(['search'], { baseUrl: 'https://example.test', output: () => assert.fail('failure must not print results'), request }), /Ad library request failed|Invalid ad library response/);
  }
});

test('preserves the complete response and saves optional JSON file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ad-library-test-'));
  try {
    const path = join(dir, 'result.json');
    const body = { schemaVersion: 1, items: [{ archive_id: '123', formats: [{ slug: 'demo', evidence: 'Product UI visible' }] }], total: 1, limit: 20, offset: 0, nextOffset: null, filters: {}, coverage: 'stored-snapshots' };
    let output = '';
    await runAdLibraryCommand(['search', '--output', path], { baseUrl: 'https://example.test', request: async () => Response.json(body), output: text => { output += text; } });
    assert.deepEqual(JSON.parse(output), body); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), body);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
