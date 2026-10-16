// GENERATED from apps/web/lib/server/postplus-cli/hosted-image-source-core.ts. Do not edit; run pnpm hosted-execution-manifest:sync.

import assert from 'node:assert/strict';

const maxImages = 35;

/** JSON data only, never webpage script execution or recursive string parsing. */
export function extractInstagramPageProduct(
  html: string,
  shortcode: string,
): Record<string, unknown> {
  assert.ok(
    Buffer.byteLength(html) <= 4 * 1024 * 1024,
    'image_sequence_page_too_large',
  );
  const products: Record<string, unknown>[] = [];
  let visited = 0;
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (!/\bdata-sjs(?:\s|=|$)/i.test(match[1]!)) continue;
    const stack: { value: unknown; depth: number }[] = [
      { value: JSON.parse(match[2]!), depth: 0 },
    ];
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      assert.ok(
        ++visited <= 50000 && depth <= 64,
        'image_sequence_page_schema_invalid',
      );
      if (!value || typeof value !== 'object') continue;
      const media = (value as Record<string, unknown>).xig_polaris_media;
      if (media && typeof media === 'object') {
        const product = (media as Record<string, unknown>)
          .if_not_gated_logged_out;
        if (
          product &&
          typeof product === 'object' &&
          !Array.isArray(product) &&
          (product as Record<string, unknown>).code === shortcode
        )
          products.push(product as Record<string, unknown>);
      }
      for (const child of Object.values(value))
        stack.push({ value: child, depth: depth + 1 });
    }
  }
  assert.equal(products.length, 1, 'image_sequence_page_schema_invalid');
  return products[0]!;
}
export interface ImageSequence {
  completenessBasis: 'returned-list' | 'declared-count';
  declaredCount: number | null;
  images: {
    index: number;
    url: string;
    width: number | null;
    height: number | null;
  }[];
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Private probe contract for the public post's ordered original-image list. */
export function parseInstagramImageSequence(
  value: unknown,
  expectedShortcode: string,
): ImageSequence {
  const product = record(value);
  assert.equal(
    product.code,
    expectedShortcode,
    'image_sequence_source_identity_mismatch',
  );
  assert.equal(product.media_type, 8, 'image_sequence_not_carousel');
  const children = product.carousel_media;
  assert.ok(
    Array.isArray(children) &&
      children.length > 0 &&
      children.length <= maxImages,
    'image_sequence_count_invalid',
  );
  const declaredCount = product.carousel_media_count;
  if (declaredCount !== undefined && declaredCount !== null) {
    assert.ok(Number.isSafeInteger(declaredCount));
    assert.equal(declaredCount, children.length, 'image_sequence_incomplete');
  }
  const images = children.map((value, index) => {
    const child = record(value);
    assert.equal(child.media_type, 1, 'image_sequence_mixed_media');
    const candidates = record(child.image_versions2).candidates;
    assert.ok(Array.isArray(candidates) && candidates.length > 0);
    // Select the declared primary representation once. No alternate-URL
    // fallback and no sorting/deduplication of the source's child array.
    const primary = record(candidates[0]);
    assert.equal(typeof primary.url, 'string');
    const url = new URL(primary.url as string);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.port, '');
    assert.match(url.hostname, /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/u);
    const dimensions = [primary.width, primary.height].map((dimension) => {
      if (dimension === undefined || dimension === null) return null;
      assert.ok(
        Number.isSafeInteger(dimension) &&
          Number(dimension) > 0 &&
          Number(dimension) <= 16384,
      );
      return Number(dimension);
    });
    return {
      index: index + 1,
      url: url.href,
      width: dimensions[0]!,
      height: dimensions[1]!,
    };
  });
  return {
    // A returned array alone cannot prove the platform did not hide a child.
    completenessBasis:
      declaredCount == null ? 'returned-list' : 'declared-count',
    declaredCount: declaredCount == null ? null : Number(declaredCount),
    images,
  };
}

/** Order is the platform's array order, never a URL/name sort or dedup. */
export function parseTikTokImageSequence(html: string, expectedId: string) {
  const matches = [
    ...html.matchAll(
      /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  assert.equal(matches.length, 1, 'image_sequence_page_schema_invalid');
  const scope = record(record(JSON.parse(matches[0]![1]!)).__DEFAULT_SCOPE__);
  const detail = record(scope['webapp.video-detail']);
  assert.equal(detail.statusCode, 0, 'image_sequence_source_unavailable');
  const item = record(record(detail.itemInfo).itemStruct);
  assert.equal(item.id, expectedId, 'image_sequence_source_identity_mismatch');
  const images = record(item.imagePost).images;
  assert.ok(
    Array.isArray(images) && images.length > 0 && images.length <= maxImages,
    'image_sequence_count_invalid',
  );
  return images.map((value, index) => {
    const image = record(value);
    const urls = record(image.imageURL).urlList;
    assert.ok(
      Array.isArray(urls) && typeof urls[0] === 'string',
      'image_sequence_media_missing',
    );
    const url = new URL(urls[0]);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.port, '');
    assert.match(
      url.hostname,
      /(?:^|\.)(?:tiktokcdn(?:-us|-eu)?\.com|tiktokcdn\.eu|byteoversea\.com)$/u,
    );
    const width = image.imageWidth;
    const height = image.imageHeight;
    assert.ok(
      Number.isSafeInteger(width) &&
        Number(width) > 0 &&
        Number(width) <= 16384,
    );
    assert.ok(
      Number.isSafeInteger(height) &&
        Number(height) > 0 &&
        Number(height) <= 16384,
    );
    return {
      index: index + 1,
      url: url.href,
      width: Number(width),
      height: Number(height),
    };
  });
}

const pageHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
};

export async function resolveImageSequenceSource(
  source: string,
  fetchSource: (
    url: string,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ) => Promise<Response>,
  signal: AbortSignal,
  directSourceKind: 'image' | 'video' = 'video',
) {
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('media_source_invalid_url');
  const instagram =
    /^(?:www\.)?instagram\.com$/u.test(url.hostname) &&
    /^\/p\/([\w-]+)\/?$/u.exec(url.pathname);
  const tiktok =
    /^(?:www\.)?tiktok\.com$/u.test(url.hostname) &&
    /^\/@[\w.-]+\/photo\/(\d+)\/?$/u.exec(url.pathname);
  // CLI media preparation delegates generic URLs to video acquisition. An
  // explicitly image-only caller uses the same bounded signature validator as
  // carousel images; URL suffixes and Content-Type are not proof of image bytes.
  if (!instagram && !tiktok) {
    if (
      directSourceKind === 'image' &&
      !/^(?:www\.)?(?:instagram|tiktok)\.com$/u.test(url.hostname)
    )
      return {
        kind: 'ordered-images' as const,
        sourceIdentifier: 'direct-image',
        sequence: {
          completenessBasis: 'declared-count' as const,
          declaredCount: 1,
          images: [{ index: 1, url: source, width: null, height: null }],
        },
      };
    return { kind: 'video-input' as const, useOriginalSource: true };
  }

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
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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
      (n, c) => n * BigInt(64) + BigInt(alphabet.indexOf(c)),
      BigInt(0),
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
        kind: 'video-input' as const,
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
  return { kind: 'ordered-images' as const, sequence, sourceIdentifier };
}
