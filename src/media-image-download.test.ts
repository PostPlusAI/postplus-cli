import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectLocalImage,
  prepareImageSequence,
} from './media-image-download.js';

test('CLI media preparation does not add runtime dependencies or drop shipped entry files', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ])
    assert.deepEqual(Object.keys(pkg[field] ?? {}), []);
  for (const file of [
    'media-prepare',
    'media-image-download',
    'media-image-source',
    'media-source-http',
  ])
    assert.ok(pkg.files.includes(`build/${file}.js`));
});

test('local image checks never rewrite input or claim actual decoding, and reject symlinks', async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'postplus-image-boundary-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'broken.jpeg');
  const bytes = Buffer.from('ffd8ffe0', 'hex');
  await writeFile(filename, bytes);
  const result = await inspectLocalImage(filename);
  assert.equal(result.readability, 'agent-required');
  assert.equal(result.mime, 'image/jpeg');
  assert.equal('width' in result, false);
  assert.equal('height' in result, false);
  assert.deepEqual(await readFile(filename), bytes);
  const link = path.join(directory, 'link.jpeg');
  await symlink(filename, link);
  await assert.rejects(inspectLocalImage(link), {
    code: 'media_image_invalid_file',
  });
});

for (const headers of [
  { 'content-length': '-1' },
  { 'content-length': '0' },
  { 'content-length': 'garbage' },
  { 'content-encoding': 'gzip' },
  { 'content-length': '9' },
]) {
  test(`invalid/incomplete image transfer fails once and cleans up: ${JSON.stringify(headers)}`, async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'postplus-image-transfer-'),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(
      prepareImageSequence({
        parentDirectory: directory,
        sequence: {
          completenessBasis: 'declared-count',
          declaredCount: 1,
          images: [
            {
              index: 1,
              url: 'https://p16.tiktokcdn.com/a',
              width: null,
              height: null,
            },
          ],
        },
        sourceIdentifier: 'tiktok:123',
        signal: new AbortController().signal,
        fetchImage: async () => {
          calls++;
          return new Response(new Uint8Array([255, 216, 255, 224]), {
            headers,
          });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^media_image_(invalid_transfer|incomplete_download)$/u,
        );
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), []);
  });
}
