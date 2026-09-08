import { lstat } from 'node:fs/promises';
import path from 'node:path';

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
import { createImageSourceFetcher } from './media-source-http.js';
import { inspectVideoFile } from './media-video-file.js';

const pageHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
};

export async function prepareMediaSource(
  source: string,
  dependencies: {
    fetchSource?: Awaited<ReturnType<typeof createImageSourceFetcher>>;
    signal?: AbortSignal;
    onProgress?: (stage: string, bytes?: number) => void;
    parentDirectory?: string;
  } = {},
) {
  const signal = dependencies.signal ?? AbortSignal.timeout(120000);
  dependencies.onProgress?.('resolving_source');
  if (!/^https?:\/\//iu.test(source)) {
    const filename = path.resolve(source);
    if (!(await lstat(filename)).isFile())
      throw new Error('media_source_not_regular_file');
    if (/\.(?:mp4|mov|m4v|webm)$/iu.test(filename))
      return {
        kind: 'video',
        filePath: filename,
        metadata: await inspectVideoFile(filename),
      };
    return { kind: 'image', ...(await inspectLocalImage(filename)) };
  }
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('media_source_invalid_url');
  const instagram =
    /^(?:www\.)?instagram\.com$/u.test(url.hostname) &&
    /^\/p\/([\w-]+)\/?$/u.exec(url.pathname);
  const tiktok =
    /^(?:www\.)?tiktok\.com$/u.test(url.hostname) &&
    /^\/@[\w.-]+\/photo\/(\d+)\/?$/u.exec(url.pathname);
  // The command delegates remote video acquisition to its shared video transfer.
  if (!instagram && !tiktok)
    return { kind: 'video-input', useOriginalSource: true };
  const fetchSource =
    dependencies.fetchSource ?? (await createImageSourceFetcher());
  let sequence: ImageSequence;
  let sourceIdentifier: string;
  const cookies = new Map<string, string>(); // Anonymous response session only; memory lifetime is this call.
  const page = async (href: string, api = false) => {
    const response = await fetchSource(href, signal, {
      ...pageHeaders,
      ...(cookies.size
        ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {}),
      ...(api
        ? {
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '359341',
            'X-IG-WWW-Claim': '0',
            Origin: 'https://www.instagram.com',
            Accept: '*/*',
          }
        : {}),
    });
    if ([401, 403, 429].includes(response.status) || (!response.ok && !api)) {
      await response.body?.cancel();
      throw new Error(
        response.status === 429
          ? 'media_source_rate_limited'
          : 'media_source_access_denied',
      );
    }
    for (const value of response.headers.getSetCookie()) {
      const first = value.split(';')[0]!;
      const at = first.indexOf('=');
      if (at > 0 && first.slice(0, at) !== 'sessionid')
        cookies.set(first.slice(0, at), first.slice(at + 1));
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!response.body) throw new Error('media_source_empty_response');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 4 * 1024 * 1024)
        throw new Error('media_source_page_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  if (instagram) {
    const shortcode = instagram[1]!;
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    if (shortcode.length > 28) throw new Error('media_source_access_denied');
    const id = [...shortcode].reduce(
      (n, c) => n * 64n + BigInt(alphabet.indexOf(c)),
      0n,
    );
    await page('https://www.instagram.com/');
    await page(
      `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${id}`,
      true,
    );
    const product = extractInstagramPageProduct(
      await page(`https://www.instagram.com/p/${shortcode}`),
      shortcode,
    );
    if (product.media_type === 2)
      return {
        kind: 'video-input',
        useOriginalSource: true,
      };
    sequence = parseInstagramImageSequence(product, shortcode);
    sourceIdentifier = `instagram:${shortcode}`;
  } else {
    if (!tiktok) throw new Error('media_source_invalid_url');
    const id = tiktok[1]!;
    const href = new URL(url);
    href.pathname = href.pathname.replace('/photo/', '/video/');
    href.search = '';
    href.hash = '';
    sequence = {
      completenessBasis: 'returned-list',
      declaredCount: null,
      images: parseTikTokImageSequence(await page(href.href), id),
    };
    sourceIdentifier = `tiktok:${id}`;
  }
  return prepareImageSequence({
    sequence,
    sourceIdentifier,
    signal,
    fetchImage: (href, signal) => fetchSource(href, signal),
    onProgress: dependencies.onProgress,
    parentDirectory: dependencies.parentDirectory,
  });
}

export async function runMediaPrepareCommand(
  args: string[],
  dependencies: {
    prepareVideo?: (source: string) => Promise<unknown>;
    readProductError?: (error: unknown) => Record<string, unknown> | undefined;
  } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(
      'postplus media prepare --source <social-url-or-local-path>\nPrepare readable local evidence for your Agent. Video preparation acquires and validates the file without purchasing video inference.',
    );
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--source' || !args[1]?.trim())
    throw new Error(
      'media prepare requires --source <social-url-or-local-path>.',
    );
  const started = performance.now();
  let stage = 'resolving_source';
  let emitted: string | null = null;
  try {
    const result = await prepareMediaSource(args[1], {
      onProgress(next, bytes) {
        if (next === emitted) return;
        stage = next;
        emitted = next;
        process.stderr.write(
          `stage=${stage} elapsed=${Math.round(performance.now() - started)}ms${bytes === undefined ? '' : ` bytes=${bytes}`}\n`,
        );
      },
    });
    const prepared =
      result.kind === 'video-input' && dependencies.prepareVideo
        ? await dependencies.prepareVideo(args[1])
        : result;
    console.log(JSON.stringify(prepared, null, 2));
    return 0;
  } catch (error) {
    const productError = dependencies.readProductError?.(error);
    if (productError) {
      console.error(
        JSON.stringify({
          ...productError,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      return 1;
    }
    const known =
      error instanceof Error &&
      /^media_(?:source|image|video)_[a-z_]+$/u.test(error.message)
        ? error.message
        : 'media_source_unavailable';
    if (
      error instanceof Error &&
      'stage' in error &&
      ['downloading_source', 'validating_media'].includes(String(error.stage))
    )
      stage = String(error.stage);
    console.error(
      JSON.stringify({
        stage,
        elapsedMs: Math.round(performance.now() - started),
        code: known,
        retryable:
          error instanceof Error &&
          'retryable' in error &&
          typeof error.retryable === 'boolean'
            ? error.retryable
            : [
                'media_source_network_failed',
                'media_source_timeout',
                'media_source_rate_limited',
              ].includes(known),
        ...(error instanceof Error &&
        'imageIndex' in error &&
        Number.isSafeInteger(error.imageIndex)
          ? { imageIndex: error.imageIndex }
          : {}),
        userAction: known.includes('proxy')
          ? 'Check the configured network proxy and supported Node runtime; no media was analyzed.'
          : 'Check that the source is public and readable. Resume any existing source operation; collection may have incurred charges even when preparation fails.',
      }),
    );
    return 1;
  }
}
