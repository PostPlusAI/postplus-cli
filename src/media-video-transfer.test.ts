import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { LocalVideoMetadata } from './media-video-file.js';
import {
  type PrepareVideoAnalysisInputOptions,
  type VideoTransferRequest,
  type VideoTransferState,
  prepareVideoAnalysisInput,
} from './media-video-transfer.js';

const payload = Buffer.from('abcdefghij');
const metadata: LocalVideoMetadata = {
  audioCodec: 'aac',
  bytes: 10,
  container: 'mp4',
  durationSeconds: 1,
  hasAudio: true,
  hasVideo: true,
  height: 48,
  width: 64,
  mimeType: 'video/mp4',
  sha256: 'fixture-hash',
  videoCodec: 'h264',
};
const uploadUrl =
  'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=secret-session';
const upload = {
  output: {
    uploadUrl,
    uploadToken: 'signed-ticket',
    expiresAt: Date.parse('2099-01-01T00:00:00Z'),
  },
};
const completed = {
  output: {
    status: 'completed',
    source: {
      kind: 'video',
      videoCandidates: [
        {
          url: 'https://cdn.example/video.mp4',
          audioUrl: 'https://cdn.example/audio.m4a',
        },
      ],
    },
    billing: { credits: 1 },
  },
};
const done = () => Response.json({ file: { name: 'files/test_file' } });
async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'postplus-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'local.mp4');
  await writeFile(filePath, payload);
  const snapshots: VideoTransferState[] = [];
  const requests: VideoTransferRequest[] = [];
  const progress: string[] = [];
  let saved: VideoTransferState | undefined;
  const options: PrepareVideoAnalysisInputOptions = {
    source: filePath,
    directory,
    operationId: 'parent-operation',
    saveState: async (state) => {
      saved = structuredClone(state);
      snapshots.push(saved);
    },
    request: async (body) => {
      requests.push(body);
      return upload;
    },
    onProgress: (message) => progress.push(message),
    dependencies: {
      inspect: async () => metadata,
      fetchResponse: async (_url, init) => {
        assert.equal(saved?.phase, 'uploading');
        assert.equal(saved.uploadUrl, uploadUrl);
        assert.equal(saved.uploadToken, 'signed-ticket');
        assert.equal(new Headers(init.headers).get('x-goog-api-key'), null);
        const chunks: Buffer[] = [];
        for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
          chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), payload);
        return done();
      },
    },
  };
  return {
    options,
    snapshots,
    requests,
    progress,
    filePath,
    state: () => saved!,
  };
}

test('local video persists upload credentials before sending bytes and returns retained evidence', async (t) => {
  const h = await setup(t);
  const result = await prepareVideoAnalysisInput(h.options);
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/test_file',
  );
  assert.equal(result.filePath, h.filePath);
  assert.equal(result.metadata, metadata);
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['prepare-upload'],
  );
  assert.deepEqual(
    h.snapshots.map((s) => s.phase),
    ['downloaded', 'upload-preparing', 'upload-ready', 'uploading', 'uploaded'],
  );
  assert.ok(!h.progress.join().includes('signed-ticket'));
  assert.ok(!h.progress.join().includes('secret-session'));
});

test('social source polls with one submission, keeps billing and downloads returned audio/video', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://www.youtube.com/shorts/123';
  let downloads = 0;
  h.options.dependencies!.sleep = async () => {};
  h.options.dependencies!.download = async (input) => {
    downloads++;
    assert.equal(input.url, 'https://cdn.example/video.mp4');
    assert.equal(input.audioUrl, 'https://cdn.example/audio.m4a');
    return { filePath: h.filePath, metadata };
  };
  h.options.request = async (body) => {
    h.requests.push(body);
    assert.equal(h.state().sourceSubmissionAttempted, true);
    if (body.operation === 'resolve-source')
      return { output: { status: 'processing', handle: 'source-handle' } };
    if (body.operation === 'source-status') {
      assert.equal(body.input.handle, 'source-handle');
      return completed;
    }
    return upload;
  };
  const result = await prepareVideoAnalysisInput(h.options);
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['resolve-source', 'source-status', 'prepare-upload'],
  );
  assert.equal(downloads, 1);
  assert.deepEqual(result.sourceBilling, { credits: 1 });
});

test('lost source acknowledgement resumes status without a second paid source submission', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://instagram.com/reels/example';
  h.options.request = async (body) => {
    h.requests.push(body);
    throw new Error('lost source ACK');
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_result_unknown',
  });
  const checkpoint = h.state();
  h.options.dependencies!.download = async () => ({
    filePath: h.filePath,
    metadata,
  });
  h.options.request = async (body) => {
    h.requests.push(body);
    return body.operation === 'source-status' ? completed : upload;
  };
  await prepareVideoAnalysisInput({ ...h.options, state: checkpoint });
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['resolve-source', 'source-status', 'prepare-upload'],
  );
});

test('source deadline saves recoverable state and resumes status with the same operation', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://facebook.com/reel/123';
  let now = 0;
  Object.assign(h.options.dependencies!, {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    waitTimeoutMs: 10,
    pollIntervalMs: 5,
  });
  h.options.request = async (body) => {
    h.requests.push(body);
    return { output: { status: 'processing', handle: 'pending' } };
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_pending',
    recoverable: true,
  });
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['resolve-source', 'source-status', 'source-status'],
  );
  assert.equal(h.state().sourceHandle, 'pending');
});

test('failed acquisition preserves consumed billing and unknown pages cannot become video files', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://example.com/post';
  h.options.request = async () => ({
    output: {
      status: 'failed',
      billing: { credits: 1 },
      error: { code: 'no_media' },
    },
  });
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_failed',
  });
  assert.deepEqual(h.state().sourceResult?.billing, { credits: 1 });
  h.options.request = async () => ({
    output: { status: 'completed', source: { kind: 'image-sequence' } },
  });
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_has_no_video',
  });
});

test('known direct video URL skips paid acquisition while unsupported schemes fail early', async (t) => {
  const h = await setup(t);
  h.options.dependencies!.download = async () => ({
    filePath: h.filePath,
    metadata,
  });
  await prepareVideoAnalysisInput({
    ...h.options,
    source: 'https://example.com/source.mp4?signature=private',
  });
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['prepare-upload'],
  );
  await assert.rejects(
    () =>
      prepareVideoAnalysisInput({
        ...h.options,
        source: 'http://example.com/post',
      }),
    { code: 'media_video_unsupported_source' },
  );
});

test('a lost upload ACK queries the same session and sends only remaining bytes', async (t) => {
  const h = await setup(t);
  h.options.dependencies!.fetchResponse = async () => {
    throw new Error('lost ACK secret-session');
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_upload_result_unknown',
    message: 'media_video_upload_result_unknown',
  });
  let calls = 0;
  h.options.dependencies!.fetchResponse = async (url, init) => {
    assert.equal(url, uploadUrl);
    const headers = new Headers(init.headers);
    if (++calls === 1) {
      assert.equal(headers.get('x-goog-upload-command'), 'query');
      return new Response(null, {
        headers: {
          'x-goog-upload-status': 'active',
          'x-goog-upload-size-received': '4',
        },
      });
    }
    assert.equal(headers.get('x-goog-upload-offset'), '4');
    assert.equal(headers.get('content-length'), '6');
    const chunks: Buffer[] = [];
    for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
      chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload.subarray(4));
    return done();
  };
  await prepareVideoAnalysisInput({ ...h.options, state: h.state() });
  assert.equal(calls, 2);
  assert.equal(h.requests.length, 1);
});

test('a final queried upload is reused, but final state without a file identity stays unknown', async (t) => {
  const h = await setup(t);
  const state: VideoTransferState = {
    source: h.filePath,
    filePath: h.filePath,
    metadata,
    phase: 'uploading',
    uploadUrl,
    uploadToken: 'signed-ticket',
  };
  h.options.dependencies!.fetchResponse = async () =>
    Response.json(
      { file: { name: 'files/recovered' } },
      { headers: { 'x-goog-upload-status': 'final' } },
    );
  assert.equal(
    (await prepareVideoAnalysisInput({ ...h.options, state })).videoReference,
    'postplus-video://signed-ticket/files/recovered',
  );
  h.options.dependencies!.fetchResponse = async () =>
    new Response(null, { headers: { 'x-goog-upload-status': 'final' } });
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    { code: 'media_video_upload_result_unknown' },
  );
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['recover-upload'],
  );
});

test('unacknowledged upload preparation may recreate one empty session on explicit resume only', async (t) => {
  const h = await setup(t);
  let preparations = 0;
  h.options.request = async () => {
    preparations++;
    throw new Error('lost prepare ACK');
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_upload_preparation_unknown',
  });
  assert.equal(h.state().uploadPreparationAttempts, 1);
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state: h.state() }),
    { code: 'media_video_upload_preparation_unknown' },
  );
  assert.equal(h.state().uploadPreparationAttempts, 2);
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state: h.state() }),
    { code: 'media_video_upload_preparation_unknown' },
  );
  assert.equal(preparations, 2);
});

test('failed persistence prevents subsequent provider side effects and upload bytes', async (t) => {
  const h = await setup(t);
  let bytesSent = false;
  h.options.saveState = async (state) => {
    if (state.phase === 'upload-ready') throw new Error('disk full');
  };
  h.options.dependencies!.fetchResponse = async () => {
    bytesSent = true;
    return done();
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), /disk full/);
  assert.equal(bytesSent, false);
  h.requests.length = 0;
  h.options.saveState = async () => {
    throw new Error('checkpoint unavailable');
  };
  await assert.rejects(
    () => prepareVideoAnalysisInput(h.options),
    /checkpoint unavailable/,
  );
  assert.equal(h.requests.length, 0);
});

test('changed local files and mismatched sources never resume an old upload', async (t) => {
  const h = await setup(t);
  const state: VideoTransferState = {
    source: h.filePath,
    phase: 'uploading',
    filePath: h.filePath,
    metadata,
    uploadUrl,
    uploadToken: 'ticket',
  };
  h.options.dependencies!.inspect = async () => ({
    ...metadata,
    sha256: 'changed',
  });
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    { code: 'media_video_local_file_changed' },
  );
  await assert.rejects(
    () =>
      prepareVideoAnalysisInput({
        ...h.options,
        state: { ...state, source: 'another-source' },
      }),
    { code: 'media_video_checkpoint_source_mismatch' },
  );
  assert.equal(h.requests.length, 0);
});

test('invalid offsets, expired sessions and non-Google upload addresses cannot send bytes', async (t) => {
  const h = await setup(t);
  const state: VideoTransferState = {
    source: h.filePath,
    phase: 'uploading',
    filePath: h.filePath,
    metadata,
    uploadUrl,
    uploadToken: 'ticket',
  };
  h.options.dependencies!.fetchResponse = async () =>
    new Response(null, {
      headers: {
        'x-goog-upload-status': 'active',
        'x-goog-upload-size-received': '11',
      },
    });
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    { code: 'media_video_upload_invalid_offset' },
  );
  await assert.rejects(
    () =>
      prepareVideoAnalysisInput({
        ...h.options,
        state: { ...state, expiresAt: Date.parse('2000-01-01') },
      }),
    { code: 'media_video_upload_session_expired' },
  );
  await assert.rejects(
    () =>
      prepareVideoAnalysisInput({
        ...h.options,
        state: { ...state, uploadUrl: 'https://unrelated.example/upload' },
      }),
    { code: 'media_video_invalid_upload_session' },
  );
});

test('download-only keeps usable local evidence without creating an upload or inference', async (t) => {
  const h = await setup(t);
  let uploaded = false;
  h.options.dependencies!.fetchResponse = async () => {
    uploaded = true;
    return done();
  };
  const result = await prepareVideoAnalysisInput({
    ...h.options,
    downloadOnly: true,
  });
  assert.equal(result.videoReference, null);
  assert.equal(result.filePath, h.filePath);
  assert.equal(h.state().phase, 'downloaded');
  assert.equal(h.requests.length, 0);
  assert.equal(uploaded, false);
});

test('download-only social acquisition retains billing and never purchases video analysis', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://facebook.com/ads/library/?id=123';
  h.options.request = async (body) => {
    h.requests.push(body);
    return completed;
  };
  h.options.dependencies!.download = async () => ({
    filePath: h.filePath,
    metadata,
  });
  const result = await prepareVideoAnalysisInput({
    ...h.options,
    downloadOnly: true,
  });
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['resolve-source'],
  );
  assert.deepEqual(result.sourceBilling, { credits: 1 });
  assert.equal(result.videoReference, null);
});

test('one empty-session recreation can finish without reacquiring the source', async (t) => {
  const h = await setup(t);
  let attempts = 0;
  h.options.request = async (body) => {
    h.requests.push(body);
    if (++attempts === 1) throw new Error('prepare ACK lost');
    return upload;
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_upload_preparation_unknown',
  });
  const result = await prepareVideoAnalysisInput({
    ...h.options,
    state: h.state(),
  });
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/test_file',
  );
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['prepare-upload', 'prepare-upload'],
  );
  assert.equal(h.state().uploadPreparationAttempts, 2);
});

test('completed transfer is reused without another upload or hosted request', async (t) => {
  const h = await setup(t);
  const first = await prepareVideoAnalysisInput(h.options);
  h.options.dependencies!.fetchResponse = async () => {
    throw new Error('must not upload');
  };
  h.options.request = async () => {
    throw new Error('must not call hosted');
  };
  const next = await prepareVideoAnalysisInput({
    ...h.options,
    state: h.state(),
  });
  assert.deepEqual(next, first);
});

test('final session without its ACK recovers identity through hosted metadata, without uploading again', async (t) => {
  const h = await setup(t);
  const state: VideoTransferState = {
    source: h.filePath,
    filePath: h.filePath,
    metadata,
    phase: 'uploading',
    uploadUrl,
    uploadToken: 'signed-ticket',
  };
  let queries = 0;
  h.options.dependencies!.fetchResponse = async (_url, init) => {
    queries++;
    assert.equal(
      new Headers(init.headers).get('x-goog-upload-command'),
      'query',
    );
    return new Response(null, { headers: { 'x-goog-upload-status': 'final' } });
  };
  h.options.request = async (body) => {
    h.requests.push(body);
    assert.equal(body.operation, 'recover-upload');
    assert.equal(body.operationId, h.options.operationId);
    assert.deepEqual(body.input, { uploadToken: 'signed-ticket' });
    assert.equal(h.state().phase, 'uploading');
    return { output: { status: 'completed', fileName: 'files/recovered-123' } };
  };
  const result = await prepareVideoAnalysisInput({ ...h.options, state });
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/recovered-123',
  );
  assert.equal(h.state().phase, 'uploaded');
  assert.equal(queries, 1);
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['recover-upload'],
  );
});

test('unknown recovery retains the same session and cannot create another upload or analysis', async (t) => {
  const h = await setup(t);
  const state: VideoTransferState = {
    source: h.filePath,
    filePath: h.filePath,
    metadata,
    phase: 'uploading',
    uploadUrl,
    uploadToken: 'signed-ticket',
  };
  h.options.dependencies!.fetchResponse = async () =>
    new Response(null, { headers: { 'x-goog-upload-status': 'final' } });
  h.options.request = async (body) => {
    h.requests.push(body);
    return { output: { status: 'unknown', reason: 'scan_limit' } };
  };
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    { code: 'media_video_upload_result_unknown', recoverable: true },
  );
  assert.equal(h.state().uploadUrl, uploadUrl);
  assert.equal(h.state().phase, 'uploading');
  assert.equal(h.state().fileName, undefined);
  assert.deepEqual(
    h.requests.map((r) => r.operation),
    ['recover-upload'],
  );
});

test('epoch upload expiry returned by hosted preparation survives the checkpoint', async (t) => {
  const h = await setup(t);
  await prepareVideoAnalysisInput(h.options);
  assert.equal(h.state().expiresAt, Date.parse('2099-01-01T00:00:00Z'));
});

test('local video uploads use the shared proxy preflight before any Google request', async (t) => {
  const h = await setup(t);
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  delete process.env.NODE_USE_ENV_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  globalThis.fetch = async () => {
    assert.fail('proxy preflight must fail before Google fetch');
  };
  delete h.options.dependencies!.fetchResponse;
  await assert.rejects(
    () => prepareVideoAnalysisInput(h.options),
    (error: unknown) => {
      const failure = error as {
        code: string;
        method: string;
        message: string;
      };
      assert.equal(failure.code, 'postplus_cli_cloud_transport_failed');
      assert.equal(failure.method, 'PREFLIGHT');
      assert.match(failure.message, /NODE_USE_ENV_PROXY=1/);
      assert.doesNotMatch(failure.message, /secret-session|signed-ticket/);
      return true;
    },
  );
  assert.equal(h.state().uploadUrl, uploadUrl);
});

class TestHostedProductRequestError extends Error {
  readonly name = 'HostedProductRequestError';
  constructor(
    readonly productError: {
      code: string;
      message: string;
      operationId: string;
    },
  ) {
    super(productError.message);
  }
}
class TestHostedQuoteConfirmationRequiredError extends Error {
  readonly name = 'HostedQuoteConfirmationRequiredError';
  constructor(readonly challenge: { operationId: string; token: string }) {
    super('Confirm this source acquisition quote.');
  }
}
const isHostedRequestError = (error: unknown) =>
  error instanceof TestHostedProductRequestError ||
  error instanceof TestHostedQuoteConfirmationRequiredError;

for (const kind of ['product', 'quote'] as const)
  test(`preserves the actual ${kind} error and original submission uncertainty for outer CLI handling`, async (t) => {
    const h = await setup(t);
    h.options.source = 'https://instagram.com/reels/example';
    h.options.isHostedRequestError = isHostedRequestError;
    const failure =
      kind === 'product'
        ? new TestHostedProductRequestError({
            code: 'postplus_cli_invalid_source',
            message: 'Use a supported post link.',
            operationId: h.options.operationId,
          })
        : new TestHostedQuoteConfirmationRequiredError({
            token: 'private-quote-token',
            operationId: h.options.operationId,
          });
    h.options.request = async (body) => {
      h.requests.push(body);
      throw failure;
    };
    await assert.rejects(
      () => prepareVideoAnalysisInput(h.options),
      (error) => error === failure,
    );
    assert.equal(h.state().sourceSubmissionAttempted, true);
    assert.deepEqual(
      h.requests.map((r) => r.operation),
      ['resolve-source'],
    );
    h.options.request = async (body) => {
      h.requests.push(body);
      return completed;
    };
    h.options.dependencies!.download = async () => ({
      filePath: h.filePath,
      metadata,
    });
    await prepareVideoAnalysisInput({
      ...h.options,
      state: h.state(),
      downloadOnly: true,
    });
    assert.deepEqual(
      h.requests.map((r) => r.operation),
      ['resolve-source', 'source-status'],
    );
    assert.ok(!h.progress.join().includes('private-quote-token'));
  });

test('failed source uses the outer public error projection after billing is safely persisted', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://facebook.com/reel/example';
  const privateMessage =
    'Provider rejected https://private.example/video?token=supplier-secret';
  const publicError = new TestHostedProductRequestError({
    code: 'media_source_decode_failed',
    message: 'The post did not include a readable video.',
    operationId: 'parent-operation:source',
  });
  h.options.request = async () => ({
    output: {
      status: 'failed',
      sourceOperationId: 'parent-operation:source',
      billing: { credits: 1 },
      error: { code: 'media_source_decode_failed', message: privateMessage },
    },
  });
  h.options.sourceFailureError = (failure) => {
    assert.equal(failure.error?.code, 'media_source_decode_failed');
    assert.equal(failure.error?.message, privateMessage);
    assert.equal(failure.sourceOperationId, 'parent-operation:source');
    assert.deepEqual(failure.billing, { credits: 1 });
    assert.deepEqual(h.state().sourceResult?.billing, { credits: 1 });
    return publicError;
  };
  await assert.rejects(
    () => prepareVideoAnalysisInput(h.options),
    (error) => error === publicError,
  );
  assert.doesNotMatch(publicError.message, /supplier-secret|private[.]example/);
  assert.equal(h.state().sourceSubmissionAttempted, true);
});

test('unrecognized or provider-private errors remain unknown instead of masquerading as product errors', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://example.com/post';
  h.options.isHostedRequestError = isHostedRequestError;
  h.options.request = async () => {
    throw Object.assign(new Error('private raw provider error'), {
      name: 'HostedProductRequestError',
    });
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_result_unknown',
    message: 'media_video_source_result_unknown',
    recoverable: true,
  });
  assert.equal(h.state().sourceSubmissionAttempted, true);
});

test('without a public projection callback terminal source private text is never printed', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://example.com/post';
  h.options.request = async () => ({
    output: {
      status: 'failed',
      error: {
        code: 'media_source_decode_failed',
        message: 'supplier-secret-private-text',
      },
    },
  });
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_failed',
    message: 'media_video_source_failed',
  });
});

test('upload preparation preserves a recognized product error instead of unknown', async (t) => {
  const h = await setup(t);
  h.options.isHostedRequestError = isHostedRequestError;
  const failure = new TestHostedProductRequestError({
    code: 'video_analysis_upload_invalid',
    message: 'Upload metadata is invalid.',
    operationId: h.options.operationId,
  });
  h.options.request = async () => {
    throw failure;
  };
  await assert.rejects(
    () => prepareVideoAnalysisInput(h.options),
    (error) => error === failure,
  );
  assert.equal(h.state().phase, 'upload-preparing');
});

test('upload recovery preserves a recognized authorization error without replacing its session', async (t) => {
  const h = await setup(t);
  h.options.isHostedRequestError = isHostedRequestError;
  const state: VideoTransferState = {
    source: h.filePath,
    filePath: h.filePath,
    metadata,
    phase: 'uploading',
    uploadUrl,
    uploadToken: 'signed-ticket',
  };
  const failure = new TestHostedProductRequestError({
    code: 'video_analysis_upload_invalid',
    message: 'The upload authorization expired.',
    operationId: h.options.operationId,
  });
  h.options.request = async () => {
    throw failure;
  };
  h.options.dependencies!.fetchResponse = async () =>
    new Response(null, { headers: { 'x-goog-upload-status': 'final' } });
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    (error) => error === failure,
  );
  assert.equal(h.state().phase, 'uploading');
  assert.equal(h.state().uploadUrl, uploadUrl);
});

test('a proven rejected source resumes the same operation and submits to the provider only once', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://instagram.com/reels/example';
  h.options.downloadOnly = true;
  const rejected = new TestHostedProductRequestError({
    code: 'insufficient_balance',
    message: 'Add credits before collecting this source.',
    operationId: h.options.operationId,
  });
  h.options.isSourceSubmissionRejected = (error) => error === rejected;
  let balanceReady = false;
  let providerCalls = 0;
  h.options.request = async (body) => {
    h.requests.push(body);
    assert.equal(body.operation, 'resolve-source');
    assert.equal(body.operationId, h.options.operationId);
    if (!balanceReady) throw rejected;
    providerCalls += 1;
    return completed;
  };
  h.options.dependencies!.download = async () => ({
    filePath: h.filePath,
    metadata,
  });
  await assert.rejects(
    () => prepareVideoAnalysisInput(h.options),
    (error) => {
      assert.equal(h.state().phase, 'initial');
      assert.equal(h.state().sourceSubmissionAttempted, undefined);
      assert.equal(h.state().sourceResult, undefined);
      assert.equal(h.state().sourceHandle, undefined);
      return error === rejected;
    },
  );
  assert.equal(providerCalls, 0);
  balanceReady = true;
  const result = await prepareVideoAnalysisInput({
    ...h.options,
    state: h.state(),
  });
  assert.equal(result.filePath, h.filePath);
  assert.deepEqual(result.sourceBilling, { credits: 1 });
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    h.requests.map((body) => body.operation),
    ['resolve-source', 'resolve-source'],
  );
});

test('a source-status rejection cannot clear an already submitted source or its billing', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://instagram.com/reels/example';
  const failure = new TestHostedProductRequestError({
    code: 'subscription_required',
    message: 'Restore the subscription to read this source.',
    operationId: h.options.operationId,
  });
  h.options.isHostedRequestError = isHostedRequestError;
  h.options.isSourceSubmissionRejected = () =>
    assert.fail('status cannot authorize another submission');
  const sourceResult = {
    status: 'processing',
    handle: 'existing-run',
    billing: { credits: 1 },
  };
  const state: VideoTransferState = {
    source: h.options.source,
    phase: 'source-pending',
    sourceSubmissionAttempted: true,
    sourceHandle: 'existing-run',
    sourceResult,
  };
  h.options.request = async (body) => {
    h.requests.push(body);
    throw failure;
  };
  await assert.rejects(
    () => prepareVideoAnalysisInput({ ...h.options, state }),
    (error) => error === failure,
  );
  assert.equal(h.state().phase, 'source-pending');
  assert.equal(h.state().sourceSubmissionAttempted, true);
  assert.equal(h.state().sourceHandle, 'existing-run');
  assert.deepEqual(h.state().sourceResult, sourceResult);
  assert.deepEqual(
    h.requests.map((body) => body.operation),
    ['source-status'],
  );
});

test('unknown source submission still resumes with status when no trusted rejection exists', async (t) => {
  const h = await setup(t);
  h.options.source = 'https://instagram.com/reels/example';
  const failure = new Error('lost acknowledgement');
  h.options.isSourceSubmissionRejected = (error) => {
    assert.equal(error, failure);
    return false;
  };
  h.options.request = async (body) => {
    h.requests.push(body);
    throw failure;
  };
  await assert.rejects(() => prepareVideoAnalysisInput(h.options), {
    code: 'media_video_source_result_unknown',
  });
  assert.equal(h.state().sourceSubmissionAttempted, true);
  h.options.request = async (body) => {
    h.requests.push(body);
    return completed;
  };
  h.options.dependencies!.download = async () => ({
    filePath: h.filePath,
    metadata,
  });
  await prepareVideoAnalysisInput({
    ...h.options,
    state: h.state(),
    downloadOnly: true,
  });
  assert.deepEqual(
    h.requests.map((body) => body.operation),
    ['resolve-source', 'source-status'],
  );
});

for (const identityInQuery of [true, false]) {
  test(`upload timeout internally recovers a final session (${identityInQuery ? 'query identity' : 'hosted identity'}) without resending bytes`, async (t) => {
    const h = await setup(t);
    const calls: string[] = [];
    const budgets: number[] = [];
    t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      budgets.push(ms);
      return new AbortController().signal;
    });
    h.options.dependencies!.fetchResponse = async (url, init) => {
      assert.equal(url, uploadUrl);
      const command = new Headers(init.headers).get('x-goog-upload-command')!;
      calls.push(command);
      assert.equal(h.state().phase, 'uploading');
      assert.equal(h.state().uploadToken, 'signed-ticket');
      if (command === 'upload, finalize') {
        for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) {
          /* consume bytes before lost ACK */
        }
        throw new DOMException('The operation timed out', 'TimeoutError');
      }
      assert.equal(init.body, undefined);
      return new Response(
        identityInQuery
          ? JSON.stringify({ file: { name: 'files/recovered' } })
          : null,
        {
          headers: { 'x-goog-upload-status': 'final' },
        },
      );
    };
    h.options.request = async (request) => {
      h.requests.push(request);
      if (request.operation === 'prepare-upload') return upload;
      assert.equal(request.operation, 'recover-upload');
      assert.equal(request.operationId, 'parent-operation');
      assert.deepEqual(request.input, { uploadToken: 'signed-ticket' });
      return { output: { status: 'completed', fileName: 'files/recovered' } };
    };
    const result = await prepareVideoAnalysisInput(h.options);
    assert.equal(
      result.videoReference,
      'postplus-video://signed-ticket/files/recovered',
    );
    assert.equal(h.state().phase, 'uploaded');
    assert.deepEqual(calls, ['upload, finalize', 'query']);
    assert.deepEqual(budgets, [300_000, 30_000]);
    assert.deepEqual(
      h.requests.map((r) => r.operation),
      identityInQuery
        ? ['prepare-upload']
        : ['prepare-upload', 'recover-upload'],
    );
  });
}

for (const outcome of [
  'active-zero',
  'active-partial',
  'unknown',
  'query-timeout',
  'final-unknown',
] as const) {
  test(`upload timeout followed by ${outcome} preserves the same checkpoint and never resends`, async (t) => {
    const h = await setup(t);
    const { PostPlusNetworkRequestError } = await import(
      './network-diagnostics.js'
    );
    const failure = new PostPlusNetworkRequestError({
      method: 'POST',
      targetUrl: uploadUrl,
      cause: new DOMException('The operation timed out', 'TimeoutError'),
    });
    const calls: string[] = [];
    h.options.dependencies!.fetchResponse = async (_url, init) => {
      const command = new Headers(init.headers).get('x-goog-upload-command')!;
      calls.push(command);
      if (command === 'upload, finalize') throw failure;
      assert.equal(init.body, undefined);
      if (outcome === 'query-timeout')
        throw new DOMException('Timed out', 'TimeoutError');
      return new Response(null, {
        headers: {
          'x-goog-upload-status': outcome.startsWith('active')
            ? 'active'
            : outcome === 'final-unknown'
              ? 'final'
              : 'unknown',
          'x-goog-upload-size-received':
            outcome === 'active-partial' ? '5' : '0',
        },
      });
    };
    h.options.request = async (request) => {
      h.requests.push(request);
      return request.operation === 'prepare-upload'
        ? upload
        : { output: { status: 'unknown' } };
    };
    await assert.rejects(
      prepareVideoAnalysisInput(h.options),
      (error: unknown) =>
        outcome === 'final-unknown'
          ? (error as { code?: string }).code ===
            'media_video_upload_result_unknown'
          : error === failure,
    );
    assert.deepEqual(calls, ['upload, finalize', 'query']);
    assert.equal(h.state().phase, 'uploading');
    assert.equal(h.state().uploadUrl, uploadUrl);
    assert.equal(h.state().uploadToken, 'signed-ticket');
    assert.equal(h.state().uploadPreparationAttempts, 1);
    assert.deepEqual(
      h.requests.map((r) => r.operation),
      outcome === 'final-unknown'
        ? ['prepare-upload', 'recover-upload']
        : ['prepare-upload'],
    );
  });
}

test('an ordinary upload transport failure does not trigger the timeout query path', async (t) => {
  const h = await setup(t);
  let calls = 0;
  h.options.dependencies!.fetchResponse = async () => {
    calls += 1;
    throw new Error('Connection reset');
  };
  await assert.rejects(prepareVideoAnalysisInput(h.options), {
    code: 'media_video_upload_result_unknown',
  });
  assert.equal(calls, 1);
  assert.equal(h.state().phase, 'uploading');
});

test('timeout while reading the upload ACK body also queries the original session', async (t) => {
  const h = await setup(t);
  const calls: string[] = [];
  h.options.dependencies!.fetchResponse = async (_url, init) => {
    const command = new Headers(init.headers).get('x-goog-upload-command')!;
    calls.push(command);
    if (command === 'upload, finalize')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('Timed out', 'TimeoutError'));
          },
        }),
      );
    return new Response(JSON.stringify({ file: { name: 'files/recovered' } }), {
      headers: { 'x-goog-upload-status': 'final' },
    });
  };
  const result = await prepareVideoAnalysisInput(h.options);
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/recovered',
  );
  assert.deepEqual(calls, ['upload, finalize', 'query']);
  assert.equal(h.requests.length, 1);
});

test('an aborted deadline still recovers when the response body reports AbortError', async (t) => {
  const h = await setup(t);
  const uploadDeadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) =>
    ms === 300_000 ? uploadDeadline.signal : new AbortController().signal,
  );
  let calls = 0;
  h.options.dependencies!.fetchResponse = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      uploadDeadline.abort(new DOMException('Timed out', 'TimeoutError'));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('Aborted', 'AbortError'));
          },
        }),
      );
    }
    assert.equal(init.signal?.aborted, false);
    assert.equal(
      new Headers(init.headers).get('x-goog-upload-command'),
      'query',
    );
    return new Response(JSON.stringify({ file: { name: 'files/recovered' } }), {
      headers: { 'x-goog-upload-status': 'final' },
    });
  };
  const result = await prepareVideoAnalysisInput(h.options);
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/recovered',
  );
  assert.equal(calls, 2);
});

test('proven pre-execution preparation rejections do not consume the empty-session recovery budget', async (t) => {
  const h = await setup(t);
  const rejected = new Error('Compatibility rejected before execution');
  h.options.isRequestRejectedBeforeExecution = (error) => error === rejected;
  h.options.request = async (request) => {
    h.requests.push(request);
    throw rejected;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      prepareVideoAnalysisInput({
        ...h.options,
        state: attempt ? h.state() : undefined,
      }),
      (error) => error === rejected,
    );
    assert.equal(h.state().phase, 'downloaded');
    assert.equal(h.state().uploadPreparationAttempts, undefined);
    assert.equal(h.state().uploadUrl, undefined);
  }
  h.options.request = async (request) => {
    h.requests.push(request);
    return upload;
  };
  const result = await prepareVideoAnalysisInput({
    ...h.options,
    state: h.state(),
  });
  assert.equal(
    result.videoReference,
    'postplus-video://signed-ticket/files/test_file',
  );
  assert.equal(h.state().uploadPreparationAttempts, 1);
  assert.equal(h.requests.length, 4);
});

test('a rejected preparation does not erase an earlier unknown preparation attempt', async (t) => {
  const h = await setup(t);
  const rejected = new Error('Compatibility rejected before execution');
  h.options.isRequestRejectedBeforeExecution = (error) => error === rejected;
  h.options.request = async () => {
    throw new Error('ACK lost');
  };
  await assert.rejects(prepareVideoAnalysisInput(h.options), {
    code: 'media_video_upload_preparation_unknown',
  });
  assert.equal(h.state().uploadPreparationAttempts, 1);
  h.options.request = async () => {
    throw rejected;
  };
  await assert.rejects(
    prepareVideoAnalysisInput({ ...h.options, state: h.state() }),
    (error) => error === rejected,
  );
  assert.equal(h.state().uploadPreparationAttempts, 1);
  assert.equal(h.state().phase, 'downloaded');
  h.options.request = async () => {
    throw new Error('ACK lost again');
  };
  await assert.rejects(
    prepareVideoAnalysisInput({ ...h.options, state: h.state() }),
    { code: 'media_video_upload_preparation_unknown' },
  );
  assert.equal(h.state().uploadPreparationAttempts, 2);
});
