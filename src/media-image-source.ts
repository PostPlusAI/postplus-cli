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
