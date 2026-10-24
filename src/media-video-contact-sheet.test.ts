import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { runHostedDomainCommand } from './hosted-domain-commands.js';
import { resumeVideoCheckpoint } from './media-video-command.js';
import { prepareVideoContactSheet } from './media-video-contact-sheet.js';
import { inspectVideoFile } from './media-video-file.js';

const exec = promisify(execFile);
async function fixture(t: TestContext, shifted = false) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "postplus video's evidence-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "source's clip.mp4");
  await exec('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:r=10:d=2.4',
    '-vf',
    shifted
      ? "select='eq(n,0)+eq(n,3)+eq(n,11)+eq(n,18)',setpts=PTS+5/TB"
      : "drawbox=w=iw:h=ih:color=red:t=fill:enable='between(t,0.4,0.5)'",
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    filePath,
  ]);
  return { directory, filePath };
}

test('actual decoded evidence keeps cadence, a between-second flash, ending and all sheet pages', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filePath);
  const result = await prepareVideoContactSheet({
    ...f,
    parentDirectory: f.directory,
  });
  const times = result.frames.map((frame) => frame.timestampSeconds);
  for (const expected of [0, 0.4, 0.6, 1, 2, 2.3])
    assert.ok(
      times.includes(expected),
      `${expected}s must be represented: ${times}`,
    );
  assert.ok(
    result.frames
      .find((frame) => frame.timestampSeconds === 0.4)!
      .reasons.includes('scene-change-candidate'),
  );
  assert.ok(result.frames.at(-1)!.reasons.includes('ending'));
  assert.equal(result.status, 'prepared');
  assert.equal(result.analysis, 'agent-required');
  assert.equal(result.audio, 'no-audio-stream');
  assert.equal(result.cloudCommand, null);
  assert.equal(result.contactSheets.at(-1)!.lastFrame, result.frames.length);
  for (const image of [...result.frames, ...result.contactSheets]) {
    const bytes = await readFile(image.filePath);
    assert.deepEqual(bytes.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  }
  assert.deepEqual(
    JSON.parse(await readFile(result.manifestPath, 'utf8')),
    result,
  );
  assert.deepEqual(
    await readFile(f.filePath),
    original,
    'user footage must remain byte-for-byte unchanged',
  );
});

test('local refinement limits coverage to the requested interval and uses decoded, not requested times', async (t) => {
  const f = await fixture(t);
  const result = await prepareVideoContactSheet({
    ...f,
    parentDirectory: f.directory,
    range: { startSeconds: 0.35, endSeconds: 0.75, frameIntervalSeconds: 0.1 },
  });
  assert.deepEqual(
    result.frames.map((frame) => frame.timestampSeconds),
    [0.4, 0.5, 0.6, 0.7],
  );
  assert.equal(result.frames.at(-1)!.timestampSeconds, 0.7);
  assert.ok(result.frames.at(-1)!.reasons.includes('ending'));
});

test('variable frame spacing and a nonzero source start retain real presentation time', async (t) => {
  const f = await fixture(t, true);
  const result = await prepareVideoContactSheet({
    ...f,
    parentDirectory: f.directory,
  });
  assert.equal(result.sourceStartTimestampSeconds, 5);
  assert.deepEqual(
    result.frames.map((frame) => frame.timestampSeconds),
    [0, 1.1, 1.8],
  );
  assert.deepEqual(
    result.frames.map((frame) => frame.sourceTimestampSeconds),
    [5, 6.1, 6.8],
  );
});

test('default CLI flow prepares images without login, upload, inference or any HTTP', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.directory, 'empty-config');
  const output = path.join(f.directory, 'contact-sheet.json');
  const originalFetch = globalThis.fetch;
  const originalConfig = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = config;
  globalThis.fetch = async () =>
    assert.fail('local visual analysis must not make an HTTP request');
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = originalConfig;
  });
  assert.equal(
    await runHostedDomainCommand('media', [
      'analyze',
      'video-analysis',
      '--video',
      f.filePath,
      '--output',
      output,
    ]),
    0,
  );
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.kind, 'video-contact-sheet');
  await assert.rejects(readdir(config), { code: 'ENOENT' });
});

test('packaged CLI also handles a local file with no connected account', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.directory, 'evidence.json');
  const { stdout } = await exec(
    process.execPath,
    [
      'build/index.js',
      'media',
      'analyze',
      'video-analysis',
      '--video',
      f.filePath,
      '--json',
      '--output',
      output,
    ],
    {
      env: {
        ...process.env,
        POSTPLUS_CONFIG_DIR: path.join(f.directory, 'empty'),
        POSTPLUS_API_BASE_URL: 'https://must-not-be-used.invalid',
      },
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'prepared');
  assert.equal(result.frames.at(-1).timestampSeconds, 2.3);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
});

test('invalid ranges and cropped cloud requests fail before acquisition or network', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    assert.fail('invalid input must not make an HTTP request');
  try {
    for (const flags of [
      ['--frame-interval-seconds', '0'],
      ['--start-seconds', '-1'],
      ['--end-seconds', 'NaN'],
      ['--start-seconds', '2', '--end-seconds', '1'],
      ['--cloud', '--start-seconds', '1'],
    ]) {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          'https://must-not-be-used.invalid/video.mp4',
          ...flags,
        ]),
        /--.*(?:must|requires)/u,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing local tools fail honestly instead of offering a cloud fallback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    prepareVideoContactSheet({
      ...f,
      parentDirectory: f.directory,
      run: async () => {
        calls++;
        throw Object.assign(new Error('missing ffmpeg'), { code: 'ENOENT' });
      },
    }),
    (error: unknown) => {
      const failure = error as {
        code: string;
        details: { stage: string; action: string };
      };
      assert.equal(
        failure.code,
        'postplus_media_contact_sheet_dependency_missing',
      );
      assert.equal(failure.details.stage, 'local_contact_sheet');
      assert.match(
        failure.details.action,
        /Do not replace this failure with paid analysis/u,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual((await readdir(f.directory)).sort(), ["source's clip.mp4"]);
});

test('an empty refinement range never produces a successful evidence manifest', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.directory, 'failed');
  await mkdir(output);
  await assert.rejects(
    prepareVideoContactSheet({
      ...f,
      parentDirectory: output,
      range: { startSeconds: 10, endSeconds: 11 },
    }),
    { code: 'postplus_media_contact_sheet_failed' },
  );
  for (const child of await readdir(output))
    await assert.rejects(
      readFile(path.join(output, child, 'contact-sheet.json')),
      { code: 'ENOENT' },
    );
});

test('decoder errors are failures even when the media process exits zero with some frames', async (t) => {
  const f = await fixture(t);
  const metadata = await inspectVideoFile(f.filePath);
  await assert.rejects(
    prepareVideoContactSheet({
      ...f,
      metadata,
      parentDirectory: f.directory,
      toolsChecked: true,
      run: async () => ({
        stdout: JSON.stringify({
          frames: [{ best_effort_timestamp_time: '0' }],
        }),
        stderr: 'Invalid NAL unit: frame decoding failed',
      }),
    }),
    { code: 'postplus_media_contact_sheet_failed' },
  );
});

test('resuming source preparation completes the original contact-sheet request without cloud work', async (t) => {
  const f = await fixture(t);
  const metadata = await inspectVideoFile(f.filePath);
  const output = path.join(f.directory, 'resumed-evidence.json');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    assert.fail('downloaded evidence must never recollect or submit inference');
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  assert.equal(
    await resumeVideoCheckpoint({
      checkpoint: {
        filePath: path.join(f.directory, 'source-checkpoint.json'),
        resumeCommand: 'resume original source',
        record: {
          schemaVersion: 1,
          accountId: 'fixture',
          apiOrigin: 'https://unused.invalid',
          capability: 'video-analysis',
          operationId: 'original-source-operation',
          videoRequest: {
            source: f.filePath,
            skill: 'media-analysis',
            downloadOnly: true,
            contactSheet: {
              startSeconds: 0.35,
              endSeconds: 0.75,
              frameIntervalSeconds: 0.1,
            },
          },
          videoTransfer: {
            source: f.filePath,
            phase: 'downloaded',
            filePath: f.filePath,
            metadata,
          },
        },
      },
      outputPath: output,
      json: false,
      analyze: async () =>
        assert.fail(
          'a local visual checkpoint must not become a cloud analysis',
        ),
    }),
    0,
  );
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.kind, 'video-contact-sheet');
  assert.deepEqual(
    result.frames.map(
      (frame: { timestampSeconds: number }) => frame.timestampSeconds,
    ),
    [0.4, 0.5, 0.6, 0.7],
  );
});
