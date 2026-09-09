import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext, after, before } from 'node:test';

import { runCommand } from './command-runner.js';
import {
  VIDEO_MAX_BYTES,
  downloadVideoBytes,
  inspectVideoFile,
  prepareDownloadedVideo,
  readMediaRefreshTarget,
} from './media-video-file.js';

let fixtureDirectory: string;
let video: Buffer;
let audio: Buffer;
before(async () => {
  fixtureDirectory = await mkdtemp(
    path.join(tmpdir(), 'postplus-video-fixtures-'),
  );
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48:r=10:d=0.6',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path.join(fixtureDirectory, 'silent.mp4'),
  ]);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=0.6',
    '-vn',
    '-c:a',
    'aac',
    path.join(fixtureDirectory, 'audio.m4a'),
  ]);
  video = await readFile(path.join(fixtureDirectory, 'silent.mp4'));
  audio = await readFile(path.join(fixtureDirectory, 'audio.m4a'));
});
after(async () => {
  if (fixtureDirectory)
    await rm(fixtureDirectory, { recursive: true, force: true });
});
async function temp(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'postplus-video-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const html = (value: string) =>
  new Response(value, { headers: { 'content-type': 'text/html' } });
const bytes = (value: Uint8Array) =>
  new Response(value, {
    headers: { 'content-type': 'application/octet-stream' },
  });
const refresh = (url: string) =>
  `<meta http-equiv="refresh" content="0;url=${url}">`;

test('meta refresh resolves relative targets, attribute order and encoded query separators', () => {
  assert.equal(
    readMediaRefreshTarget(
      '<META content="0.1; URL=\'/asset.mp4?a=1&amp;b=2\'" HTTP-EQUIV="Refresh">',
      'https://download.example/landing',
    ),
    'https://download.example/asset.mp4?a=1&b=2',
  );
  for (const content of [
    '',
    '<script>location="https://cdn.example/v"</script>',
    refresh('https://a.example/v') + refresh('https://b.example/v'),
  ])
    assert.throws(
      () => readMediaRefreshTarget(content, 'https://download.example'),
      /media_video_html_without_media_redirect/,
    );
});
test('source and HTML redirects reject non-HTTPS or credential-bearing URLs before fetching', async (t) => {
  const directory = await temp(t);
  for (const url of [
    'http://cdn.example/v',
    'file:///tmp/video',
    'https://user:secret@cdn.example/v',
  ]) {
    await assert.rejects(
      () =>
        downloadVideoBytes(url, path.join(directory, 'v.mp4'), {
          fetchResponse: async () => {
            throw new Error('fetch must not run');
          },
        }),
      /media_video_invalid_download_url/,
    );
    assert.throws(
      () => readMediaRefreshTarget(refresh(url), 'https://example.test'),
      /media_video_invalid_download_url/,
    );
  }
});
test('HTML landing page downloads actual target bytes with original query and valid metadata', async (t) => {
  const directory = await temp(t);
  const calls: string[] = [];
  const result = await prepareDownloadedVideo({
    url: 'https://download.example/landing',
    directory,
    dependencies: {
      fetchResponse: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? html(refresh('/real.mp4?one=1&amp;two=2'))
          : bytes(video);
      },
    },
  });
  assert.deepEqual(calls, [
    'https://download.example/landing',
    'https://download.example/real.mp4?one=1&two=2',
  ]);
  assert.deepEqual(await readFile(result.filePath), video);
  assert.equal(
    result.metadata.sha256,
    createHash('sha256').update(video).digest('hex'),
  );
  assert.equal(result.metadata.width, 64);
  assert.equal(result.metadata.height, 48);
});
test('HTML loops and excessive chains terminate without writing a video', async (t) => {
  const directory = await temp(t);
  await assert.rejects(
    () =>
      downloadVideoBytes(
        'https://example.test/a',
        path.join(directory, 'loop'),
        { fetchResponse: async () => html(refresh('/a')) },
      ),
    /media_video_redirect_loop/,
  );
  let calls = 0;
  await assert.rejects(
    () =>
      downloadVideoBytes(
        'https://example.test/0',
        path.join(directory, 'chain'),
        { fetchResponse: async () => html(refresh(`/${++calls}`)) },
      ),
    /media_video_redirect_limit/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(await readdir(directory), []);
});
test('oversized HTML and non-media HTML cannot produce a prepared video', async (t) => {
  const directory = await temp(t);
  await assert.rejects(
    () =>
      downloadVideoBytes(
        'https://example.test/html',
        path.join(directory, 'large'),
        { fetchResponse: async () => html('x'.repeat(64 * 1024 + 1)) },
      ),
    /media_video_redirect_page_too_large/,
  );
  await assert.rejects(() =>
    prepareDownloadedVideo({
      url: 'https://example.test/not-video',
      directory,
      dependencies: {
        fetchResponse: async () =>
          new Response('<html>Not a video</html>', {
            headers: { 'content-type': 'video/mp4' },
          }),
      },
    }),
  );
});
test('truncation, empty bodies and advertised oversize fail without a partial artifact', async (t) => {
  const directory = await temp(t);
  for (const response of [
    new Response('short', { headers: { 'content-length': '50' } }),
    new Response(new Uint8Array()),
    new Response('unused', {
      headers: { 'content-length': String(VIDEO_MAX_BYTES + 1) },
    }),
  ]) {
    await assert.rejects(
      () =>
        downloadVideoBytes(
          'https://example.test/v',
          path.join(directory, 'v'),
          { fetchResponse: async () => response },
        ),
      /media_video_(download_incomplete|too_large)/,
    );
    assert.deepEqual(await readdir(directory), []);
  }
});
test('streaming size limit is enforced when Content-Length is missing', async (t) => {
  const directory = await temp(t);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(VIDEO_MAX_BYTES + 1));
      controller.close();
    },
  });
  await assert.rejects(
    () =>
      downloadVideoBytes('https://example.test/v', path.join(directory, 'v'), {
        fetchResponse: async () => new Response(body),
      }),
    /media_video_too_large/,
  );
  assert.deepEqual(await readdir(directory), []);
});
test('HTTP and stream failure preserve an existing file and remove transient files', async (t) => {
  const directory = await temp(t);
  const output = path.join(directory, 'existing.mp4');
  await writeFile(output, video);
  for (const response of [
    new Response('denied', { status: 403 }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection lost'));
        },
      }),
    ),
  ]) {
    await assert.rejects(() =>
      downloadVideoBytes('https://example.test/v', output, {
        fetchResponse: async () => response,
      }),
    );
    assert.deepEqual(await readFile(output), video);
    assert.deepEqual(await readdir(directory), ['existing.mp4']);
  }
});
test('valid silent video stays silent and requires no audio request', async (t) => {
  const directory = await temp(t);
  let calls = 0;
  const result = await prepareDownloadedVideo({
    url: 'https://example.test/v',
    directory,
    dependencies: {
      fetchResponse: async () => {
        calls++;
        return bytes(video);
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.metadata.hasVideo, true);
  assert.equal(result.metadata.hasAudio, false);
  assert.equal(result.metadata.audioCodec, null);
  assert.ok(result.metadata.durationSeconds >= 0.5);
});
test('separate audio and video merge into a decodable audio/video file', async (t) => {
  const directory = await temp(t);
  const result = await prepareDownloadedVideo({
    url: 'https://example.test/video',
    audioUrl: 'https://example.test/audio',
    directory,
    dependencies: {
      fetchResponse: async (url) =>
        bytes(url.endsWith('/audio') ? audio : video),
    },
  });
  assert.equal(result.metadata.hasAudio, true);
  assert.equal(result.metadata.audioCodec, 'aac');
  assert.equal(result.metadata.videoCodec, 'h264');
  assert.ok(result.metadata.durationSeconds >= 0.5);
  assert.equal(result.metadata.bytes, (await stat(result.filePath)).size);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-i',
    result.filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-f',
    'null',
    '-',
  ]);
});
test('retrying a split-track merge replaces only the validated result and cleans interrupted output', async (t) => {
  const directory = await temp(t);
  const existing = path.join(directory, 'source.mp4');
  await writeFile(existing, 'previous interrupted merge');
  const input = {
    url: 'https://example.test/video',
    audioUrl: 'https://example.test/audio',
    directory,
    dependencies: {
      fetchResponse: async (url: string) =>
        bytes(url.endsWith('/audio') ? audio : video),
    },
  };
  await assert.rejects(
    prepareDownloadedVideo({
      ...input,
      dependencies: {
        ...input.dependencies,
        run: async (command, args, options) => {
          if (command === 'ffmpeg') {
            await writeFile(args[args.length - 1]!, 'interrupted');
            throw new Error('merge interrupted');
          }
          return runCommand(command, args, options);
        },
      },
    }),
    /merge interrupted/u,
  );
  assert.equal(await readFile(existing, 'utf8'), 'previous interrupted merge');
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith('.merge-')),
    false,
  );
  const first = await prepareDownloadedVideo(input);
  const second = await prepareDownloadedVideo(input);
  assert.equal(first.filePath, existing);
  assert.equal(second.metadata.hasAudio, true);
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith('.merge-')),
    false,
  );
});

test('an expected audio download containing video-only media cannot report success', async (t) => {
  const directory = await temp(t);
  await assert.rejects(
    () =>
      prepareDownloadedVideo({
        url: 'https://example.test/video',
        audioUrl: 'https://example.test/audio',
        directory,
        dependencies: { fetchResponse: async () => bytes(video) },
      }),
    /media_video_missing_expected_audio/,
  );
});
test('local inspection rejects empty, audio-only, HTML and malformed probe output', async (t) => {
  const directory = await temp(t);
  for (const content of [
    new Uint8Array(),
    audio,
    Buffer.from('<html>Not media</html>'),
  ]) {
    const file = path.join(directory, 'invalid.mp4');
    await writeFile(file, content);
    await assert.rejects(() => inspectVideoFile(file));
  }
  const file = path.join(directory, 'valid.mp4');
  await writeFile(file, video);
  for (const stdout of ['{}', '{"streams": [], "format": {"duration":"NaN"}}'])
    await assert.rejects(
      () => inspectVideoFile(file, async () => ({ stdout, stderr: '' })),
      /media_video_(invalid_probe_result|not_decodable_video)/,
    );
});

test('local size validation rejects directories and oversized sparse files before probing', async (t) => {
  const directory = await temp(t);
  const forbiddenProbe = async () => {
    throw new Error('probe must not run');
  };
  await assert.rejects(
    () => inspectVideoFile(directory, forbiddenProbe),
    /media_video_invalid_file_size/,
  );
  const file = path.join(directory, 'oversized.mp4');
  const handle = await open(file, 'w');
  try {
    await handle.truncate(VIDEO_MAX_BYTES + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(
    () => inspectVideoFile(file, forbiddenProbe),
    /media_video_invalid_file_size/,
  );
});

test('truncated MP4 bytes fail real probing instead of becoming a prepared video', async (t) => {
  const directory = await temp(t);
  await assert.rejects(() =>
    prepareDownloadedVideo({
      url: 'https://example.test/truncated',
      directory,
      dependencies: {
        fetchResponse: async () =>
          bytes(video.subarray(0, Math.floor(video.length / 2))),
      },
    }),
  );
});
