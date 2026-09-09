import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { runCommand } from './command-runner.js';
import {
  fetchHostedRunDetail,
  formatHostedRunDetailReport,
} from './hosted-account-commands.js';
import { runMediaFileCommand } from './hosted-domain-commands.js';
import {
  createMediaFileFingerprint,
  downloadHostedMediaFile,
  uploadHostedMediaFile,
} from './hosted-media-transfer.js';
import { setLocalSession } from './local-state.js';

let directory: string;
let originalConfig: string | undefined;
let originalFetch: typeof fetch;
const signedUpload = {
  method: 'TUS' as const,
  url: 'https://storage.test/upload',
  requiredHeaders: { 'x-signature': 'private-signature' },
  metadata: { bucketName: 'uploads', objectName: 'account/input.bin' },
  chunkSizeBytes: 4,
  expiresInSeconds: 3600,
};
const ref = 'postplus-media://uploads/account/input.bin';
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'postplus-transfer-contract-'));
  originalConfig = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = path.join(directory, 'config');
  originalFetch = globalThis.fetch;
  await setLocalSession({
    accountId: 'account',
    apiBaseUrl: 'https://postplus.test',
    cliSessionToken: 'test-token',
    sessionExpiresAt: null,
    userEmail: null,
    userId: 'user',
  });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
  else process.env.POSTPLUS_CONFIG_DIR = originalConfig;
  await rm(directory, { recursive: true, force: true });
});
async function interruptedUpload() {
  const absolutePath = path.join(directory, 'input.bin');
  await writeFile(absolutePath, '0123456789');
  const fingerprint = await createMediaFileFingerprint(absolutePath);
  const input = {
    mediaReference: ref,
    owner: 'account@environment',
    absolutePath,
    fingerprint,
    operationId: 'fixed-operation',
    signedUpload,
  };
  await assert.rejects(
    uploadHostedMediaFile({
      ...input,
      options: {
        maxAttempts: 1,
        fetchFn: (async (_url, init) => {
          if (init?.method === 'POST')
            return new Response(null, {
              status: 201,
              headers: { location: '/session' },
            });
          throw new Error('network interrupted');
        }) as typeof fetch,
      },
    }),
  );
  return input;
}
test('TUS binds source SHA, account, environment and object before any storage resume request', async () => {
  const input = await interruptedUpload();
  let calls = 0;
  const options = {
    fetchFn: (async () => {
      calls++;
      throw new Error('must not request');
    }) as typeof fetch,
  };
  for (const change of [
    { owner: 'other-account@environment' },
    {
      signedUpload: {
        ...signedUpload,
        metadata: { ...signedUpload.metadata, objectName: 'other-object' },
      },
    },
    {
      signedUpload: {
        ...signedUpload,
        url: 'https://other-storage.test/upload',
      },
    },
  ]) {
    await assert.rejects(
      uploadHostedMediaFile({ ...input, ...change, options }),
      /checkpoint does not match/,
    );
  }
  const previous = await stat(input.absolutePath);
  await writeFile(input.absolutePath, 'abcdefghij');
  await utimes(input.absolutePath, previous.atime, previous.mtime);
  await assert.rejects(
    uploadHostedMediaFile({ ...input, options }),
    /changed|match/,
  );
  // Recomputed fingerprint still cannot disguise changed content under the same operation.
  await assert.rejects(
    uploadHostedMediaFile({
      ...input,
      fingerprint: await createMediaFileFingerprint(input.absolutePath),
      options,
    }),
    /checkpoint does not match/,
  );
  assert.equal(calls, 0);
});
test('corrupt TUS checkpoint fails closed before HEAD or replacement POST', async () => {
  const input = await interruptedUpload();
  const id = createHash('sha256').update(input.operationId).digest('hex');
  await writeFile(
    path.join(
      process.env.POSTPLUS_CONFIG_DIR!,
      'media-transfers',
      `${id}.json`,
    ),
    '{"schemaVersion":"unknown","entries":{}}',
  );
  await assert.rejects(
    uploadHostedMediaFile({
      ...input,
      options: {
        fetchFn: (async () => assert.fail('must not request')) as typeof fetch,
      },
    }),
    /checkpoint/i,
  );
});
test('TUS rejects cross-origin Location without forwarding its signature', async () => {
  const absolutePath = path.join(directory, 'input.bin');
  await writeFile(absolutePath, '0123456789');
  let calls = 0;
  await assert.rejects(
    uploadHostedMediaFile({
      mediaReference: ref,
      owner: 'account',
      absolutePath,
      fingerprint: await createMediaFileFingerprint(absolutePath),
      operationId: 'cross-origin',
      signedUpload,
      options: {
        fetchFn: (async (url, init) => {
          calls++;
          assert.equal(String(url), signedUpload.url);
          assert.equal(init?.redirect, 'error');
          return new Response(null, {
            status: 201,
            headers: {
              location: 'https://attacker.test/session?secret=secret-location',
            },
          });
        }) as typeof fetch,
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /origin/);
      assert.doesNotMatch(String(error), /private-signature|secret-location/);
      return true;
    },
  );
  assert.equal(calls, 1);
});
test('CLI upload prints its generated operation and resumes only that operation from HEAD', async () => {
  const file = path.join(directory, 'input.bin');
  await writeFile(file, '0123456789');
  const operations: string[] = [];
  const methods: string[] = [];
  const offsets: number[] = [];
  let remoteOffset = 0;
  let rejectPatch = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://postplus.test/')) {
      const body = JSON.parse(String(init?.body));
      operations.push(body.operationId);
      assert.match(body.file.fingerprint.contentSha256, /^[a-f0-9]{64}$/);
      return Response.json({
        output: {
          signedUpload,
          mediaReference: ref,
          storageReference: {
            bucket: 'uploads',
            storagePath: 'account/input.bin',
            name: 'input.bin',
            mimeType: 'application/octet-stream',
            sizeBytes: 10,
          },
        },
      });
    }
    methods.push(init!.method!);
    if (init?.method === 'POST')
      return new Response(null, {
        status: 201,
        headers: { location: '/session' },
      });
    if (init?.method === 'HEAD')
      return new Response(null, {
        headers: {
          'upload-length': '10',
          'upload-offset': String(remoteOffset),
        },
      });
    const offset = Number(new Headers(init?.headers).get('upload-offset'));
    offsets.push(offset);
    for await (const chunk of init!.body as NodeJS.ReadableStream)
      remoteOffset += Buffer.byteLength(chunk);
    if (rejectPatch) {
      rejectPatch = false;
      return new Response(null, { status: 400 });
    }
    return new Response(null, {
      status: 204,
      headers: { 'upload-offset': String(remoteOffset) },
    });
  };
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await assert.rejects(runMediaFileCommand(['upload', '--input-file', file]));
    assert.ok(stderr.includes(operations[0]!));
    assert.match(
      stderr,
      /Resume the original upload: postplus .*--hosted-operation-id/,
    );
    assert.doesNotMatch(stderr, /private-signature/);
    await runMediaFileCommand([
      'upload',
      '--input-file',
      file,
      '--hosted-operation-id',
      operations[0]!,
      '--output',
      path.join(directory, 'result.json'),
    ]);
    assert.deepEqual(operations, [operations[0], operations[0]]);
    assert.deepEqual(methods, ['POST', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
    assert.deepEqual(offsets, [0, 4, 8]);
    await runMediaFileCommand([
      'upload',
      '--input-file',
      file,
      '--hosted-operation-id',
      operations[0]!,
      '--output',
      path.join(directory, 'result.json'),
    ]);
    assert.deepEqual(methods, ['POST', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
    assert.match(stderr, /already complete; no bytes transferred/);
    const id = createHash('sha256').update(operations[0]!).digest('hex');
    const record = await readFile(
      path.join(
        process.env.POSTPLUS_CONFIG_DIR!,
        'media-transfers',
        `${id}.json`,
      ),
      'utf8',
    );
    assert.doesNotMatch(
      record,
      /private-signature|uploadUrl|storage.test\/session/,
    );
    assert.equal(JSON.parse(record).completed.mediaReference, ref);
    await writeFile(file, 'abcdefghij');
    await assert.rejects(
      runMediaFileCommand([
        'upload',
        '--input-file',
        file,
        '--hosted-operation-id',
        operations[0]!,
      ]),
      /checkpoint does not match/,
    );
    assert.deepEqual(methods, ['POST', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
  } finally {
    process.stderr.write = originalWrite;
  }
});
test('hosted-lib upload uses current-call retries without reading or writing CLI checkpoints', async () => {
  const file = path.join(directory, 'input.bin');
  await writeFile(file, '0123');
  const before = await readdir(process.env.POSTPLUS_CONFIG_DIR!);
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://library.test/'))
      return Response.json({ output: { signedUpload, mediaReference: ref } });
    if (init?.method === 'POST')
      return new Response(null, {
        status: 201,
        headers: { location: '/session' },
      });
    for await (const _ of init!.body as NodeJS.ReadableStream) {
      /* consume body */
    }
    return new Response(null, {
      status: 204,
      headers: { 'upload-offset': '4' },
    });
  };
  await runMediaFileCommand(['upload', '--input-file', file], {
    auth: {
      apiBaseUrl: 'https://library.test',
      cliSessionToken: 'injected-token',
    },
    skillsReleaseId: null,
  });
  assert.deepEqual(await readdir(process.env.POSTPLUS_CONFIG_DIR!), before);
});
function interruptedBytes() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('0123'));
        setTimeout(() => controller.error(new Error('interrupted')), 5);
      },
    }),
    {
      headers: {
        'content-length': '10',
        'accept-ranges': 'bytes',
        etag: '"stable"',
      },
    },
  );
}
test('CLI reference download accepts fresh signatures but rejects another reference under the same operation', async () => {
  const output = path.join(directory, 'output.bin');
  let signs = 0;
  let downloads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://postplus.test/')) {
      signs++;
      return Response.json({
        output: { signedUrl: `https://download.test/media?signature=${signs}` },
      });
    }
    downloads++;
    if (downloads === 1) return interruptedBytes();
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=4-');
    return new Response('456789', {
      status: 206,
      headers: { 'content-range': 'bytes 4-9/10', etag: '"stable"' },
    });
  };
  const args = [
    'download',
    '--reference',
    ref,
    '--hosted-operation-id',
    'download-op',
    '--output-file',
    output,
    '--output',
    path.join(directory, 'result.json'),
  ];
  await assert.rejects(runMediaFileCommand(args), /resumeAvailable=true/);
  await assert.rejects(
    runMediaFileCommand(
      args.map((arg) => (arg === ref ? `${ref}.other` : arg)),
    ),
    /checkpoint/,
  );
  assert.equal(downloads, 1);
  await runMediaFileCommand(args);
  assert.equal(downloads, 2);
  assert.ok(signs >= 2);
  assert.equal(await readFile(output, 'utf8'), '0123456789');
});
test('download idle timer cancels stalled bodies and weak validators never promise resume', async () => {
  let cancelled = false;
  await assert.rejects(
    downloadHostedMediaFile({
      debug: false,
      absoluteOutput: path.join(directory, 'stalled.bin'),
      operationId: 'stalled',
      sourceIdentity: 'https://download.test/source',
      url: 'https://download.test/source',
      request: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('0123'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              'content-length': '10',
              'accept-ranges': 'bytes',
              etag: 'W/"weak"',
            },
          },
        ),
      options: { idleTimeoutMs: 20 },
    }),
    /idle_timeout.*resumeAvailable=false/,
  );
  assert.equal(cancelled, true);
  assert.ok(!(await readdir(directory)).some((name) => name.includes('.part')));
});
test('runs expose only top-level stage and numeric progress while preserving unknown costs', async () => {
  globalThis.fetch = async () =>
    Response.json({
      id: 'run',
      status: 'completed',
      capability: 'video-analysis',
      stage: 'analyzing',
      progress: {
        bytes: 4,
        elapsedMs: 2,
        stage: 'completed',
        totalBytes: '10',
        attempt: null,
      },
      error: {
        stage: 'failed',
        retryable: false,
        userAction: 'query original task',
      },
      finalizedCredits: null,
      reservedCredits: null,
    });
  const report = await fetchHostedRunDetail('run');
  assert.equal(report.stage, 'analyzing');
  assert.deepEqual(report.progress, { bytes: 4, elapsedMs: 2 });
  assert.equal(report.finalizedCredits, null);
  assert.equal(report.reservedCredits, null);
  assert.deepEqual(report.error, {
    stage: 'failed',
    retryable: false,
    userAction: 'query original task',
  });
  const output = formatHostedRunDetailReport(report);
  assert.match(output, /stage=analyzing bytes=4 elapsedMs=2/);
  assert.match(output, /Finalized: unknown/);
  assert.doesNotMatch(
    output,
    /stage=completed|attempt=0|totalBytes=0|Finalized: 0/,
  );
});

test('CLI video download follows the existing HTML bridge and probes before atomic output', async () => {
  const source = path.join(directory, 'source.mp4');
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
    source,
  ]);
  const video = await readFile(source);
  const requested: string[] = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return requested.length === 1
      ? new Response('<meta http-equiv="refresh" content="0;url=/actual">', {
          headers: { 'content-type': 'text/html' },
        })
      : new Response(video);
  };
  const output = path.join(directory, 'output.mp4');
  await runMediaFileCommand([
    'download',
    '--url',
    'https://download.test/landing',
    '--output-file',
    output,
    '--output',
    path.join(directory, 'result.json'),
  ]);
  assert.deepEqual(requested, [
    'https://download.test/landing',
    'https://download.test/actual',
  ]);
  assert.deepEqual(await readFile(output), video);
  globalThis.fetch = async () => new Response('invalid-video');
  const invalid = path.join(directory, 'invalid.mp4');
  await assert.rejects(
    runMediaFileCommand([
      'download',
      '--url',
      'https://download.test/invalid',
      '--output-file',
      invalid,
    ]),
    /ffprobe|Invalid data/,
  );
  await assert.rejects(stat(invalid), { code: 'ENOENT' });
});

test('PUT completed identity prevents retransmission and cross-account reuse', async () => {
  const file = path.join(directory, 'small.bin');
  await writeFile(file, '0123');
  let puts = 0;
  const input = {
    owner: 'account',
    mediaReference: ref,
    absolutePath: file,
    fingerprint: await createMediaFileFingerprint(file),
    operationId: 'small-op',
    signedUpload: {
      method: 'PUT' as const,
      url: 'https://storage.test/signed?token=private-put',
      requiredHeaders: {},
    },
    options: {
      fetchFn: (async (_url, init) => {
        puts++;
        for await (const _ of init!.body as NodeJS.ReadableStream) {
        }
        return new Response(null);
      }) as typeof fetch,
    },
  };
  assert.equal((await uploadHostedMediaFile(input)).reusedCompleted, false);
  assert.equal((await uploadHostedMediaFile(input)).reusedCompleted, true);
  await assert.rejects(
    uploadHostedMediaFile({ ...input, owner: 'other-account' }),
    /checkpoint does not match/,
  );
  assert.equal(puts, 1);
});
test('hosted-lib failed download leaves no persistent recovery checkpoint', async () => {
  const output = path.join(directory, 'library.bin');
  globalThis.fetch = async () => interruptedBytes();
  await assert.rejects(
    runMediaFileCommand(
      [
        'download',
        '--url',
        'https://download.test/source',
        '--output-file',
        output,
      ],
      {
        auth: {
          apiBaseUrl: 'https://library.test',
          cliSessionToken: 'injected-token',
        },
        skillsReleaseId: null,
      },
    ),
    /resumeAvailable=false/,
  );
  assert.ok(!(await readdir(directory)).some((name) => name.includes('.part')));
});
