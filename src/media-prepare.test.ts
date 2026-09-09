import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  inspectLocalImage,
  prepareImageSequence,
} from './media-image-download.js';
import {
  type ImageSequence,
  extractInstagramPageProduct,
  parseInstagramImageSequence,
  parseTikTokImageSequence,
} from './media-image-source.js';
import { prepareMediaSource, runMediaPrepareCommand } from './media-prepare.js';
import {
  assertImageSourceUrl,
  isPublicImageSourceAddress,
} from './media-source-http.js';

const id = '7672407417698684192';
const shortcode = 'Dc9T8U2iQ7u';
const image = (name: string) => ({
  imageURL: {
    urlList: [`https://p16.tiktokcdn.com/${name}?signature=private`],
  },
  imageWidth: 8,
  imageHeight: 6,
});
const page = (images: unknown[]) =>
  `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: { id, imagePost: { images } } } } } })}</script>`;
const sjs = (value: unknown) =>
  `<script type="application/json" data-sjs>${JSON.stringify(value)}</script>`;
const ig = (product: unknown) => ({
  xig_polaris_media: { if_not_gated_logged_out: product },
});
const seq = (count = 2): ImageSequence => ({
  completenessBasis: 'returned-list',
  declaredCount: null,
  images: Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    url: 'https://p16.tiktokcdn.com/same?signature=private',
    width: 8,
    height: 6,
  })),
});
type PartialImageFailure = Error & {
  code: string;
  stage: string;
  imageIndex: number;
  retryable: boolean;
  partialEvidence: Omit<
    Awaited<ReturnType<typeof prepareImageSequence>>,
    'manifestPath'
  > & {
    status: 'partial';
    failedImageIndex: number | null;
    manifestPath?: string;
    manifestError?: string;
  };
};

test('retries only transient headers once, keeping successful pages and exact URLs', async (t) => {
  const p = await temp(t);
  const bytes = await png();
  const sequence = seq();
  sequence.images[1]!.url = 'https://p16.tiktokcdn.com/second';
  const calls: string[] = [];
  const result = await prepareImageSequence({
    sequence,
    sourceIdentifier: 'tiktok:123',
    parentDirectory: p,
    signal: new AbortController().signal,
    fetchImage: async (url) => {
      calls.push(url);
      if (calls.length === 2)
        return new Response('temporarily unavailable', { status: 503 });
      return new Response(new Uint8Array(bytes));
    },
  });
  assert.equal(result.images.length, 2);
  assert.equal('status' in result, false);
  assert.deepEqual(
    JSON.parse(await readFile(result.manifestPath, 'utf8')),
    result,
  );
  assert.deepEqual(calls, [
    sequence.images[0]!.url,
    sequence.images[1]!.url,
    sequence.images[1]!.url,
  ]);
});
const png = async () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    'base64',
  );
async function temp(t: TestContext) {
  const p = await mkdtemp(path.join(tmpdir(), 'postplus-prepare-test-'));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}

test('SJS extraction keeps exact identity, supports video detection, rejects ambiguous or untrusted data', () => {
  for (const media_type of [2, 8]) {
    const product = { code: shortcode, media_type };
    assert.deepEqual(
      extractInstagramPageProduct(sjs({ nested: [ig(product)] }), shortcode),
      product,
    );
    for (const html of [
      sjs([ig(product), ig(product)]),
      sjs(JSON.stringify(ig(product))),
      sjs(ig({ ...product, code: 'other' })),
      `<script>${JSON.stringify(ig(product))}</script>`,
    ])
      assert.throws(() => extractInstagramPageProduct(html, shortcode));
  }
  let deep: unknown = ig({ code: shortcode });
  for (let i = 0; i < 70; i++) deep = { child: deep };
  for (const html of [
    sjs(deep),
    sjs(Array(50001).fill(null)),
    sjs({}) + ' '.repeat(4 * 1024 * 1024),
  ])
    assert.throws(() => extractInstagramPageProduct(html, shortcode));
});

test('native source guards reject private addresses and credential/port/foreign URLs', () => {
  for (const href of [
    'http://www.instagram.com/p/a',
    'https://user:secret@www.instagram.com/p/a',
    'https://www.instagram.com:444/p/a',
    'https://instagram.com.attacker.test/a',
    'https://127.0.0.1/a',
  ])
    assert.throws(() => assertImageSourceUrl(href));
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.1.1',
    '198.18.1.2',
    '::1',
    '::ffff:7f00:1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicImageSourceAddress(address), false, address);
  assert.equal(isPublicImageSourceAddress('8.8.8.8'), true);
});

test('video routes do not fetch/download locally, local image signature is checked read-only', async (t) => {
  const p = await temp(t);
  const file = path.join(p, 'original.png');
  const bytes = await png();
  await writeFile(file, bytes);
  const result = await prepareMediaSource(file);
  assert.equal(result.kind, 'image');
  assert.equal('readability' in result && result.readability, 'agent-required');
  assert.deepEqual(await readFile(file), bytes);
  for (const source of [
    'https://www.tiktok.com/@test/video/123',
    'https://www.instagram.com/reels/abc/',
    'https://media.example/video.mp4',
  ])
    assert.deepEqual(
      await prepareMediaSource(source, {
        fetchSource: async () => assert.fail('video fetch forbidden'),
      }),
      { kind: 'video-input', useOriginalSource: true },
    );
});

test('TikTok raw link becomes ordered local images: one page, one fetch per occurrence, no signed URL output', async (t) => {
  const p = await temp(t);
  const bytes = await png();
  let pages = 0,
    downloads = 0;
  const result = await prepareMediaSource(
    `https://www.tiktok.com/@codexlabs.ai/photo/${id}?tracking=unused`,
    {
      parentDirectory: p,
      fetchSource: async (url) => {
        if (url.startsWith('https://www.tiktok.com/')) {
          pages++;
          assert.equal(new URL(url).search, '');
          return new Response(page([image('z'), image('a'), image('z')]));
        }
        downloads++;
        return new Response(new Uint8Array(bytes));
      },
    },
  );
  assert.equal(result.kind, 'ordered-images');
  assert.equal(pages, 1);
  assert.equal(downloads, 3);
  if (result.kind !== 'ordered-images') assert.fail();
  assert.deepEqual(
    result.images.map((i) => i.index),
    [1, 2, 3],
  );
  assert.doesNotMatch(JSON.stringify(result), /signature|https:/u);
  assert.match(result.images[0]!.filePath, /\.png$/u);
});

test('Instagram exact public page uses anonymous session only, no GraphQL or account cookies', async (t) => {
  const p = await temp(t);
  const bytes = await png();
  const requests: string[] = [];
  const product = {
    code: shortcode,
    media_type: 8,
    carousel_media_count: 1,
    carousel_media: [
      {
        media_type: 1,
        image_versions2: {
          candidates: [
            { url: 'https://scontent.cdninstagram.com/a', width: 8, height: 6 },
          ],
        },
      },
    ],
  };
  const result = await prepareMediaSource(
    `https://www.instagram.com/p/${shortcode}/?stkn=private`,
    {
      parentDirectory: p,
      fetchSource: async (url, _signal, headers) => {
        requests.push(url);
        assert.doesNotMatch(headers?.Cookie ?? '', /sessionid/u);
        if (url === 'https://www.instagram.com/')
          return new Response('home', {
            headers: { 'set-cookie': 'csrftoken=anonymous; Path=/' },
          });
        if (url.includes('get_ruling_for_content'))
          return new Response('{"status":"ok"}');
        if (url.includes('/p/')) return new Response(sjs(ig(product)));
        return new Response(new Uint8Array(bytes));
      },
    },
  );
  assert.equal(result.kind, 'ordered-images');
  assert.equal(requests.length, 4);
  assert.equal(
    requests.some((u) => u.includes('graphql') || u.includes('stkn=')),
    false,
  );
  assert.equal(
    parseInstagramImageSequence(product, shortcode).declaredCount,
    1,
  );
});

for (const scenario of [
  'network',
  'source',
  'http',
  'invalid',
  'truncated',
  'declared-limit',
  'cancel',
  'stall',
] as const)
  test(`partial image collection retains only verified pages on ${scenario}`, async (t) => {
    const p = await temp(t);
    const bytes = await png();
    const sequence = seq();
    let calls = 0;
    const controller = new AbortController();
    const error = await prepareImageSequence({
      sequence,
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: controller.signal,
      fetchImage: async () => {
        if (calls++ === 0) return new Response(new Uint8Array(bytes));
        if (scenario === 'network')
          throw new Error('https://signed.example/?secret=private');
        if (scenario === 'source')
          throw new Error('media_source_non_public_address');
        if (scenario === 'http')
          return new Response('forbidden', { status: 403 });
        if (scenario === 'cancel') controller.abort();
        if (scenario === 'stall') {
          setTimeout(() => controller.abort(), 10);
          return new Response(new ReadableStream({}));
        }
        if (scenario === 'invalid') return new Response('<html>');
        return new Response(
          new Uint8Array(bytes),
          scenario === 'declared-limit'
            ? { headers: { 'content-length': String(21 * 1024 * 1024) } }
            : scenario === 'truncated'
              ? { headers: { 'content-length': String(bytes.length + 1) } }
              : undefined,
        );
      },
    }).then(
      () => assert.fail('the failed page must still reject the operation'),
      (error: PartialImageFailure) => error,
    );
    assert.equal(
      error.code,
      {
        network: 'media_image_download_failed',
        source: 'media_source_non_public_address',
        http: 'media_image_download_failed',
        invalid: 'media_image_unsupported',
        truncated: 'media_image_incomplete_download',
        'declared-limit': 'media_image_size_limit',
        cancel: 'media_image_cancelled',
        stall: 'media_image_cancelled',
      }[scenario],
    );
    assert.equal(error.imageIndex, 2);
    const partial = error.partialEvidence;
    assert.equal(partial.status, 'partial');
    assert.equal(partial.kind, 'ordered-images');
    assert.equal(partial.failedImageIndex, 2);
    assert.equal(partial.completenessBasis, 'returned-list');
    assert.equal(partial.declaredCount, null);
    assert.equal(partial.readability, 'agent-required');
    assert.equal(partial.totalBytes, bytes.length);
    assert.deepEqual(
      partial.images.map((image) => image.index),
      [1],
    );
    assert.deepEqual(await readFile(partial.images[0]!.filePath), bytes);
    assert.deepEqual(await readdir(partial.directory), [
      '001.png',
      'manifest.json',
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(partial.manifestPath!, 'utf8')),
      partial,
    );
    assert.doesNotMatch(
      JSON.stringify(error),
      /secret|private|signature|https:/u,
    );
    assert.equal(calls, 2);
  });

for (const scenario of ['http', 'invalid', 'cancel'] as const)
  test(`first image failure still removes the empty collection on ${scenario}`, async (t) => {
    const p = await temp(t);
    const controller = new AbortController();
    const error = await prepareImageSequence({
      sequence: seq(),
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: controller.signal,
      fetchImage: async () => {
        if (scenario === 'cancel') controller.abort();
        return new Response('<html>', {
          status: scenario === 'http' ? 403 : 200,
        });
      },
    }).then(
      () => assert.fail(),
      (error: PartialImageFailure) => error,
    );
    assert.equal('partialEvidence' in error, false);
    assert.equal(error.imageIndex, 1);
    assert.deepEqual(await readdir(p), []);
  });

for (const declaredCount of [null, 3])
  test(`partial evidence retains duplicate positions and original declared count ${declaredCount}`, async (t) => {
    const p = await temp(t);
    const bytes = await png();
    const sequence = seq(3);
    sequence.declaredCount = declaredCount;
    sequence.completenessBasis =
      declaredCount === null ? 'returned-list' : 'declared-count';
    let calls = 0;
    const error = await prepareImageSequence({
      sequence,
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: new AbortController().signal,
      fetchImage: async () =>
        ++calls === 3
          ? new Response('forbidden', { status: 403 })
          : new Response(new Uint8Array(bytes)),
    }).then(
      () => assert.fail(),
      (error: PartialImageFailure) => error,
    );
    const evidence = error.partialEvidence;
    assert.equal(evidence.declaredCount, declaredCount);
    assert.equal(evidence.completenessBasis, sequence.completenessBasis);
    assert.equal(evidence.failedImageIndex, 3);
    assert.equal(evidence.totalBytes, 2 * bytes.length);
    assert.deepEqual(
      evidence.images.map((entry) => entry.index),
      [1, 2],
    );
    assert.equal(evidence.images[0]!.sha256, evidence.images[1]!.sha256);
    assert.notEqual(evidence.images[0]!.filePath, evidence.images[1]!.filePath);
    for (const entry of evidence.images)
      assert.deepEqual(await readFile(entry.filePath), bytes);
    assert.deepEqual(await readdir(evidence.directory), [
      '001.png',
      '002.png',
      'manifest.json',
    ]);
  });

for (const failImage of [true, false])
  test(`manifest write failure preserves inline verified evidence without a nonexistent path, failedImage=${failImage}`, async (t) => {
    const p = await temp(t);
    const bytes = await png();
    const originalWrite = fs.writeFile;
    let manifestWrites = 0;
    t.mock.method(fs, 'writeFile', async (filename, ...args) => {
      if (String(filename).endsWith('/manifest.json')) {
        manifestWrites++;
        await originalWrite(filename, '{'); // Simulate a short disk write.
        throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
      }
      return originalWrite(filename, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let calls = 0;
    const error = await prepareImageSequence({
      sequence: seq(),
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: new AbortController().signal,
      fetchImage: async () =>
        ++calls === 2 && failImage
          ? new Response('forbidden', { status: 403 })
          : new Response(new Uint8Array(bytes)),
    }).then(
      () => assert.fail(),
      (error: PartialImageFailure) => error,
    );
    assert.equal(
      error.code,
      failImage ? 'media_image_download_failed' : 'media_image_invalid_file',
    );
    const evidence = error.partialEvidence;
    assert.equal(evidence.status, 'partial');
    assert.equal('manifestPath' in evidence, false);
    assert.equal(evidence.manifestError, 'media_image_manifest_write_failed');
    assert.equal(evidence.failedImageIndex, failImage ? 2 : null);
    assert.equal(evidence.images.length, failImage ? 1 : 2);
    for (const entry of evidence.images)
      assert.deepEqual(await readFile(entry.filePath), bytes);
    assert.deepEqual(
      await readdir(evidence.directory),
      failImage ? ['001.png'] : ['001.png', '002.png'],
    );
    assert.equal(manifestWrites, 1);
  });

test('cancellation after manifest persistence updates it without claiming a failed image', async (t) => {
  const p = await temp(t);
  const bytes = await png();
  const controller = new AbortController();
  const originalWrite = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args) => {
    await originalWrite(...args);
    controller.abort();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const error = await prepareImageSequence({
    sequence: seq(),
    sourceIdentifier: 'tiktok:123',
    parentDirectory: p,
    signal: controller.signal,
    fetchImage: async () => new Response(new Uint8Array(bytes)),
  }).then(
    () => assert.fail(),
    (error: PartialImageFailure) => error,
  );
  assert.equal(error.code, 'media_image_cancelled');
  const evidence = error.partialEvidence;
  assert.equal(evidence.status, 'partial');
  assert.equal(evidence.failedImageIndex, null);
  assert.equal(evidence.images.length, 2);
  assert.deepEqual(
    JSON.parse(await readFile(evidence.manifestPath!, 'utf8')),
    evidence,
  );
});

test('CLI error JSON exposes verified partial images while retaining its error and exit 1', async (t) => {
  const p = await temp(t);
  const bytes = await png();
  let calls = 0;
  // Use the existing command dependency seam to deliver a real preparation
  // error; this checks error serialization independently of source transport.
  const failure = await prepareImageSequence({
    sequence: seq(),
    sourceIdentifier: 'tiktok:123',
    parentDirectory: p,
    signal: new AbortController().signal,
    fetchImage: async () =>
      new Response(++calls === 1 ? new Uint8Array(bytes) : '<html>'),
  }).then(
    () => assert.fail(),
    (error: PartialImageFailure) => error,
  );
  let output = '';
  t.mock.method(console, 'error', (value) => {
    output = String(value);
  });
  t.mock.method(console, 'log', () =>
    assert.fail('failed operation must not print success'),
  );
  const exit = await runMediaPrepareCommand(
    ['--source', 'https://media.example/video.mp4'],
    {
      prepareVideo: async () => {
        throw failure;
      },
    },
  );
  assert.equal(exit, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.code, 'media_image_unsupported');
  assert.equal(parsed.stage, failure.stage);
  assert.equal(parsed.imageIndex, 2);
  assert.equal(parsed.retryable, false);
  assert.deepEqual(parsed.partialEvidence, failure.partialEvidence);
  assert.doesNotMatch(output, /signature|private|https:/u);
  assert.deepEqual(
    await readFile(parsed.partialEvidence.images[0].filePath),
    bytes,
  );
});

test('untrusted streaming bytes cannot bypass size bound, formats may vary', async (t) => {
  const p = await temp(t);
  let cancelled = false;
  await assert.rejects(
    prepareImageSequence({
      sequence: seq(1),
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: new AbortController().signal,
      fetchImage: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    { code: 'media_image_size_limit' },
  );
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(p), []);
  const bytes = await png();
  // Signature-only JPEG deliberately cannot be decoded: readiness is for an
  // Agent to open, never a claim of readability or successful analysis.
  const jpeg = Buffer.from('ffd8ffe0', 'hex');
  let count = 0;
  const result = await prepareImageSequence({
    sequence: seq(),
    sourceIdentifier: 'tiktok:123',
    parentDirectory: p,
    signal: new AbortController().signal,
    fetchImage: async () =>
      new Response(new Uint8Array(count++ ? jpeg : bytes)),
  });
  assert.deepEqual(
    result.images.map((i) => i.mime),
    ['image/png', 'image/jpeg'],
  );
  assert.equal(result.readability, 'agent-required');
  assert.deepEqual(result.images[0]!.sourceDimensions, { width: 8, height: 6 });
  assert.equal('width' in result.images[0]!, false);
});

test('invalid order/count, mixed video and missing original fail before download', async (t) => {
  const p = await temp(t);
  const sequence = seq();
  sequence.images[1]!.index = 3;
  await assert.rejects(
    prepareImageSequence({
      sequence,
      sourceIdentifier: 'tiktok:123',
      parentDirectory: p,
      signal: new AbortController().signal,
      fetchImage: async () => assert.fail(),
    }),
  );
  assert.throws(() => parseTikTokImageSequence(page([image('a'), {}]), id));
  assert.throws(() =>
    parseInstagramImageSequence(
      { code: shortcode, media_type: 8, carousel_media: [{ media_type: 2 }] },
      shortcode,
    ),
  );
  assert.deepEqual(await readdir(p), []);
  const file = path.join(p, 'broken.png');
  await writeFile(file, 'not image');
  await assert.rejects(inspectLocalImage(file));
  assert.equal(await readFile(file, 'utf8'), 'not image');
});
