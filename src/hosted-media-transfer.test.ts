import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { runCommand } from './command-runner.js';
import {
  fetchHostedRunDetail,
  formatHostedRunDetailReport,
} from './hosted-account-commands.js';
import {
  runHostedDomainCommand,
  runMediaFileCommand,
} from './hosted-domain-commands.js';
import {
  createMediaFileFingerprint,
  downloadHostedMediaFile,
  resumeHostedMediaUpload,
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
    assert.deepEqual(operations, [operations[0]]);
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

function cleanupResponse(init: ResponseInit, rejectCleanup = false) {
  return new Response(
    new ReadableStream({
      cancel() {
        return rejectCleanup
          ? Promise.reject(new Error('cleanup failed'))
          : new Promise<void>(() => {});
      },
    }),
    init,
  );
}
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('response cleanup exceeded test deadline')),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
for (const scenario of ['http', 'range', 'size', 'checkpoint'] as const) {
  test(`download ${scenario} rejection does not await unbounded response cleanup`, async () => {
    const output = path.join(directory, 'cleanup.bin');
    const response =
      scenario === 'http'
        ? cleanupResponse({ status: 503 })
        : scenario === 'range'
          ? cleanupResponse({
              status: 206,
              headers: { 'content-range': 'bytes 2-3/10' },
            })
          : scenario === 'size'
            ? cleanupResponse({
                headers: { 'content-length': String(201 * 1024 * 1024) },
              })
            : cleanupResponse({
                headers: {
                  'content-length': '10',
                  'accept-ranges': 'bytes',
                  etag: '"stable"',
                },
              });
    await assert.rejects(
      bounded(
        downloadHostedMediaFile({
          debug: false,
          absoluteOutput: output,
          operationId: `cleanup-${scenario}`,
          sourceIdentity: 'https://download.test/source',
          url: 'https://download.test/source',
          request: async () => {
            if (scenario === 'checkpoint')
              await mkdir(
                path.join(
                  directory,
                  '.cleanup.bin.postplus-download.part.json',
                ),
              );
            return response;
          },
        }),
      ),
      scenario === 'http'
        ? /HTTP 503/
        : scenario === 'range'
          ? /integrity_mismatch/
          : scenario === 'size'
            ? /size_limit/
            : /Unable to persist/,
    );
  });
}
for (const scenario of [
  'put',
  'post',
  'head',
  'patch',
  'post-success',
] as const) {
  test(`upload ${scenario} preserves its result without awaiting response cleanup`, async () => {
    const original =
      scenario === 'head' ? await interruptedUpload() : undefined;
    const file = original?.absolutePath ?? path.join(directory, 'cleanup.bin');
    if (!original) await writeFile(file, '0123');
    const input = original ?? {
      owner: 'account',
      mediaReference: ref,
      absolutePath: file,
      fingerprint: await createMediaFileFingerprint(file),
      operationId: `cleanup-${scenario}`,
      signedUpload,
    };
    const work = uploadHostedMediaFile({
      ...input,
      signedUpload:
        scenario === 'put'
          ? { method: 'PUT', url: signedUpload.url, requiredHeaders: {} }
          : signedUpload,
      options: {
        maxAttempts: 1,
        fetchFn: (async (_url, init) => {
          if (
            scenario === 'put' ||
            scenario === 'post' ||
            (scenario === 'head' && init?.method === 'HEAD') ||
            (scenario === 'patch' && init?.method === 'PATCH')
          )
            return cleanupResponse({ status: 503 });
          if (init?.method === 'POST')
            return scenario === 'post-success'
              ? cleanupResponse({
                  status: 201,
                  headers: { location: '/session' },
                })
              : new Response(null, {
                  status: 201,
                  headers: { location: '/session' },
                });
          for await (const _ of init!.body as NodeJS.ReadableStream) {
          }
          return new Response(null, {
            status: 204,
            headers: { 'upload-offset': '4' },
          });
        }) as typeof fetch,
      },
    });
    if (scenario === 'post-success')
      assert.equal((await bounded(work)).sizeBytes, 4);
    else await assert.rejects(bounded(work), /HTTP 503/);
  });
}
test('failed cleanup promise does not replace the original HTTP error', async () => {
  await assert.rejects(
    downloadHostedMediaFile({
      debug: false,
      absoluteOutput: path.join(directory, 'reject.bin'),
      operationId: 'reject-cleanup',
      sourceIdentity: 'https://download.test/source',
      url: 'https://download.test/source',
      request: async () => cleanupResponse({ status: 403 }, true),
    }),
    /HTTP 403/,
  );
});
test('complete validated download survives failed rename and commits on retry without fetching again', async () => {
  const output = path.join(directory, 'rename.bin');
  await mkdir(output);
  let requests = 0;
  let validations = 0;
  const input = {
    debug: false,
    absoluteOutput: output,
    operationId: 'rename-operation',
    sourceIdentity: 'https://download.test/source',
    url: 'https://download.test/source',
    validate: async (file: string) => {
      validations++;
      assert.equal(await readFile(file, 'utf8'), '0123');
    },
    request: async () => {
      requests++;
      return new Response('0123', {
        headers: {
          'content-length': '4',
          'accept-ranges': 'bytes',
          etag: '"stable"',
        },
      });
    },
  };
  await assert.rejects(
    downloadHostedMediaFile(input),
    /Retry the same command to commit/,
  );
  await rm(output, { recursive: true });
  assert.equal(await downloadHostedMediaFile(input), 4);
  assert.equal(requests, 1);
  assert.equal(validations, 2);
  assert.equal(await readFile(output, 'utf8'), '0123');
});

test('TUS completed-record failure preserves the original session for recovery', async () => {
  const file = path.join(directory, 'atomic.bin');
  await writeFile(file, '0123');
  const methods: string[] = [];
  const input = {
    owner: 'account',
    mediaReference: ref,
    absolutePath: file,
    fingerprint: await createMediaFileFingerprint(file),
    operationId: 'atomic-complete',
    signedUpload,
    options: {
      maxAttempts: 1,
      fetchFn: (async (_url, init) => {
        methods.push(init!.method!);
        if (init?.method === 'POST')
          return new Response(null, {
            status: 201,
            headers: { location: '/original-session' },
          });
        if (init?.method === 'HEAD')
          return new Response(null, {
            headers: { 'upload-offset': '4', 'upload-length': '4' },
          });
        for await (const _ of init!.body as NodeJS.ReadableStream) {
        }
        return new Response(null, {
          status: 204,
          headers: { 'upload-offset': '4' },
        });
      }) as typeof fetch,
    },
  };
  const originalRename = fsPromises.rename;
  let failCompleted = true;
  fsPromises.rename = async (from, to) => {
    if (
      failCompleted &&
      String(to).includes('media-transfers') &&
      JSON.parse(await readFile(from, 'utf8')).completed
    ) {
      failCompleted = false;
      throw new Error('injected completed-record persistence failure');
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(uploadHostedMediaFile(input), /Unable to persist/);
    await uploadHostedMediaFile(input);
    assert.deepEqual(methods, ['POST', 'PATCH', 'HEAD']);
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
});
test('checkpoint cleanup failure reports committed output without claiming a resumable partial', async () => {
  const output = path.join(directory, 'committed.bin');
  const originalRm = fsPromises.rm;
  let failCleanup = true;
  fsPromises.rm = async (target, options) => {
    if (
      failCleanup &&
      String(target).endsWith('.committed.bin.postplus-download.part.json')
    ) {
      failCleanup = false;
      throw new Error('injected checkpoint cleanup failure');
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      downloadHostedMediaFile({
        debug: false,
        absoluteOutput: output,
        operationId: 'cleanup-committed',
        sourceIdentity: 'https://download.test/source',
        url: 'https://download.test/source',
        request: async () =>
          new Response('0123', {
            headers: {
              'content-length': '4',
              'accept-ranges': 'bytes',
              etag: '"stable"',
            },
          }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /already committed/);
        assert.match(error.message, /resumeAvailable=false/);
        assert.doesNotMatch(error.message, /Retry the same command/);
        return true;
      },
    );
    assert.equal(await readFile(output, 'utf8'), '0123');
    await assert.rejects(
      stat(path.join(directory, '.committed.bin.postplus-download.part')),
      { code: 'ENOENT' },
    );
  } finally {
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
  }
});

test('completed CLI upload returns before a refusing signer and rejects changed owner or source', async () => {
  const file = path.join(directory, 'pre-sign.bin');
  await writeFile(file, '0123');
  let signs = 0;
  let puts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://postplus.test/')) {
      signs++;
      if (signs > 1) throw new Error('signer refuses existing object');
      return Response.json({
        output: {
          mediaReference: ref,
          signedUpload: {
            method: 'PUT',
            url: 'https://storage.test/upload',
            requiredHeaders: {},
          },
        },
      });
    }
    puts++;
    for await (const _ of init!.body as NodeJS.ReadableStream) {
    }
    return new Response(null);
  };
  const args = [
    'upload',
    '--input-file',
    file,
    '--hosted-operation-id',
    'pre-sign-op',
    '--output',
    path.join(directory, 'result.json'),
  ];
  await runMediaFileCommand(args);
  await runMediaFileCommand(args);
  assert.equal(signs, 1);
  assert.equal(puts, 1);
  await setLocalSession({
    accountId: 'wrong-account',
    apiBaseUrl: 'https://postplus.test',
    cliSessionToken: 'other-token',
    sessionExpiresAt: null,
    userEmail: null,
    userId: 'user',
  });
  await assert.rejects(runMediaFileCommand(args), /checkpoint does not match/);
  await writeFile(file, '5678');
  await assert.rejects(runMediaFileCommand(args), /checkpoint does not match/);
  assert.equal(signs, 1);
  assert.equal(puts, 1);
});
test('local media staging reuses completed identity before signing even without its staging cache', async () => {
  const file = path.join(directory, 'stage.png');
  await writeFile(file, 'png-bytes');
  let signs = 0;
  let puts = 0;
  let estimates = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://storage.test/')) {
      puts++;
      for await (const _ of init!.body as NodeJS.ReadableStream) {
      }
      return new Response(null);
    }
    const body = JSON.parse(String(init?.body));
    if (body.capability === 'media-file') {
      signs++;
      if (signs > 1) throw new Error('signer refuses existing object');
      return Response.json({
        output: {
          mediaReference: ref,
          signedUpload: {
            method: 'PUT',
            url: 'https://storage.test/upload',
            requiredHeaders: {},
          },
        },
      });
    }
    estimates++;
    assert.deepEqual(body.input.images, [ref]);
    return Response.json({ estimateOnly: true });
  };
  const args = [
    'estimate',
    'image-gpt-image-2-edit',
    '--prompt',
    'change color',
    '--reference-image',
    file,
    '--output',
    path.join(directory, 'estimate.json'),
  ];
  await runHostedDomainCommand('media', args);
  await rm(
    path.join(process.env.POSTPLUS_CONFIG_DIR!, 'media-staging-cache.json'),
  );
  await runHostedDomainCommand('media', args);
  assert.equal(signs, 1);
  assert.equal(puts, 1);
  assert.equal(estimates, 2);
});
test('real CLI process recovers final ACK loss from its original session while the signer refuses', async () => {
  const file = path.join(directory, 'process.bin');
  await writeFile(file, '0123');
  const trace = path.join(directory, 'trace.jsonl');
  const stub = `import {appendFileSync} from 'node:fs';
const log=(method)=>appendFileSync(${JSON.stringify(trace)}, JSON.stringify({method})+'\\n');
globalThis.fetch=async(url,init)=>{
 const method=init?.method??'GET';
 if(String(url).startsWith('https://postplus.test/')){
  log('sign');if(process.env.TRANSFER_PHASE==='resume')return Response.json({error:'resource already exists'},{status:502});
  return Response.json({output:{mediaReference:${JSON.stringify(ref)},signedUpload:${JSON.stringify(signedUpload)}}});
 }
 log(method);
 if(method==='POST')return new Response(null,{status:201,headers:{location:'/original-session'}});
 if(method==='HEAD')return new Response(null,{headers:{'upload-offset':'4','upload-length':'4'}});
 if(method==='PATCH'){
  if(process.env.TRANSFER_PHASE==='resume')throw new Error('must not send bytes again');
  for await(const chunk of init.body){} process.exit(9);
 }
 throw new Error('unexpected method');
};`;
  const args = [
    '--import',
    'tsx',
    '--import',
    `data:text/javascript,${encodeURIComponent(stub)}`,
    'src/index.ts',
    'media-file',
    'upload',
    '--input-file',
    file,
    '--hosted-operation-id',
    'process-operation',
    '--output',
    path.join(directory, 'result.json'),
  ];
  const first = spawnSync(process.execPath, args, {
    env: { ...process.env, TRANSFER_PHASE: 'initial' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(first.status, 9, first.stderr);
  const checkpointPath = path.join(
    process.env.POSTPLUS_CONFIG_DIR!,
    'media-transfers',
    createHash('sha256').update('process-operation').digest('hex') + '.json',
  );
  const pending = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const session = Object.values(pending.entries)[0] as {
    signedUpload: { requiredHeaders: Record<string, string> };
    expiresAt: number;
  };
  assert.equal(
    session.signedUpload.requiredHeaders['x-signature'],
    'private-signature',
  );
  assert.ok(session.expiresAt > Date.now());
  assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(checkpointPath))).mode & 0o777, 0o700);
  const second = spawnSync(process.execPath, args, {
    env: { ...process.env, TRANSFER_PHASE: 'resume' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).method),
    ['sign', 'POST', 'PATCH', 'HEAD'],
  );
  assert.equal(
    JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'))
      .output.mediaReference,
    ref,
  );
  assert.doesNotMatch(
    await readFile(checkpointPath, 'utf8'),
    /private-signature|signedUpload|uploadUrl/,
  );
  assert.doesNotMatch(first.stderr + second.stderr, /private-signature/);
});
test('expired or incomplete original TUS descriptors stop before signing or storage requests', async () => {
  const input = await interruptedUpload();
  const checkpointPath = path.join(
    process.env.POSTPLUS_CONFIG_DIR!,
    'media-transfers',
    createHash('sha256').update(input.operationId).digest('hex') + '.json',
  );
  const original = JSON.parse(await readFile(checkpointPath, 'utf8'));
  const expired = structuredClone(original);
  Object.values(expired.entries).forEach((entry) => {
    (entry as { expiresAt: number }).expiresAt = Date.now() - 1;
  });
  globalThis.fetch = async () => assert.fail('no request may run');
  await writeFile(checkpointPath, JSON.stringify(expired));
  await assert.rejects(resumeHostedMediaUpload(input), /session expired/);
  const incomplete = structuredClone(original);
  Object.values(incomplete.entries).forEach((entry) => {
    delete (entry as { signedUpload?: unknown }).signedUpload;
  });
  await writeFile(checkpointPath, JSON.stringify(incomplete));
  await assert.rejects(
    resumeHostedMediaUpload(input),
    /checkpoint file is unreadable/,
  );
});
