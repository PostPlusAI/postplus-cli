import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeAdReport,
  renderAdReport,
  reportCreativeGroupKey,
} from './ad-library-report.js';
import { runAdLibraryCommand } from './ad-library.js';

const ad = (id = '123') => ({
  ad_archive_id: id,
  page_id: '99',
  page_name: 'Example',
  is_active: true,
  publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
  start_date: 1750000000,
  snapshot: {
    page_profile_picture_url: 'https://example.test/logo.png',
    body: { text: 'Actual text' },
    videos: [{ video_hd_url: 'https://example.test/video.mp4' }],
    title: 'Headline',
    cta_text: 'Learn more',
    link_url: 'https://example.test/landing',
  },
});
const input = (items: unknown[]) => ({
  name: 'fresh.json',
  payload: {
    routeKey: 'facebook-ads-library',
    status: 'completed',
    output: { fetchedAt: '2026-10-12T01:00:00Z', items },
  },
});
test('retains 720 ads beyond request page sizes and all creative variants, deduplicates archive IDs', () => {
  const ads = Array.from({ length: 720 }, (_, i) => ad(String(i)));
  const variant = ad('0');
  variant.snapshot.body.text = 'Second variant';
  const result = normalizeAdReport([input(ads), input([ads[0], variant])]);
  assert.equal(result.ads.length, 720);
  assert.equal(result.ads[0]!.creatives.length, 2);
  const html = renderAdReport([input(ads)]);
  assert.equal((html.match(/class="card"/g) || []).length, 720);
  assert.match(html, /preload="none"/);
  assert.match(html, /Checked:/);
  assert.match(html, /aria-label="FACEBOOK"/);
  assert.match(html, /aria-label="INSTAGRAM"/);
});
test('stored results normalize with correct observation, relative public logos and pagination disclosure', () => {
  const result = {
    name: 'stored.json',
    payload: {
      schemaVersion: 1,
      nextOffset: 50,
      items: [
        {
          archive_id: '123',
          page_id: '99',
          status: 'inactive',
          observed_at: '2026-10-01',
          brands: [
            {
              name: 'Example',
              logo_url: '/images/ad-library/brands/example.webp',
            },
          ],
          media: [{ kind: 'video', url: 'https://example.test/v.mp4' }],
          body: 'Stored body',
        },
      ],
    },
  };
  const data = normalizeAdReport([result]);
  assert.equal(data.ads[0]!.status, 'inactive');
  assert.match(data.ads[0]!.logo, /^https:\/\/postplus.io/);
  assert.match(renderAdReport([result]), /only one page/);
});
test('failed and pending outcomes are explicit, unknown payloads and missing items reject', () => {
  for (const status of ['failed', 'running', 'pending']) {
    const html = renderAdReport([
      {
        name: 'operation.json',
        payload: {
          routeKey: 'facebook-ads-library',
          status,
          error: { message: 'Provider rejected request' },
        },
      },
    ]);
    assert.match(html, new RegExp(status));
    assert.match(html, /Provider rejected request/);
  }
  assert.throws(
    () => normalizeAdReport([{ name: 'x', payload: {} }]),
    /Unsupported/,
  );
  assert.throws(
    () =>
      normalizeAdReport([
        {
          name: 'x',
          payload: { routeKey: 'facebook-ads-library', status: 'completed' },
        },
      ]),
    /Missing ad items/,
  );
});
test('escapes source content and rejects executable or credentialed URLs', () => {
  const a = ad();
  a.snapshot.body.text = '</script><script>alert("x")</script>';
  a.page_name = '" onmouseover="alert(1)';
  const html = renderAdReport([input([a])]);
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;\/script&gt;/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///tmp/x',
    'https://user:pass@example.test',
  ]) {
    const a = ad();
    a.snapshot.link_url = unsafe;
    assert.throws(() => renderAdReport([input([a])]));
  }
});
test('offline command accepts repeated inputs, preserves source files and publishes HTML atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ad-report-'));
  try {
    const source = join(dir, 'input.json'),
      out = join(dir, 'report.html');
    const json = JSON.stringify(input([ad()]).payload);
    await writeFile(source, json);
    await runAdLibraryCommand(
      ['report', '--input', source, '--input', source, '--output', out],
      {
        output: () => {},
        request: async () => assert.fail('report must not request network'),
      },
    );
    assert.match(await readFile(out, 'utf8'), /1 ads shown/);
    assert.equal(await readFile(source, 'utf8'), json);
    await assert.rejects(
      runAdLibraryCommand(['report', '--input', source, '--output', source]),
      /overwrite/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('stored presentation preserves per-creative evidence and matches media sort order', () => {
  const result = normalizeAdReport([
    {
      name: 'stored.json',
      payload: {
        schemaVersion: 1,
        items: [
          {
            archive_id: '1',
            page_id: '2',
            advertiser: { name: 'Actual advertiser' },
            brands: [{ name: 'Product brand' }],
            presentation: {
              publisherPlatforms: ['INSTAGRAM'],
              common: {
                body: 'Shared',
                destinationUrl: 'https://example.test',
              },
              creatives: [
                { sortOrder: 0, headline: 'First', ctaText: 'Try', body: null },
                { sortOrder: 1, headline: 'Second' },
              ],
            },
            media: [
              {
                kind: 'video',
                url: 'https://example.test/a.mp4',
                sort_order: 0,
              },
              {
                kind: 'image',
                url: 'https://example.test/b.png',
                sort_order: 1,
              },
            ],
          },
        ],
      },
    },
  ]);
  assert.equal(result.ads[0]!.advertiser, 'Actual advertiser');
  assert.deepEqual(result.ads[0]!.platforms, ['INSTAGRAM']);
  assert.equal(result.ads[0]!.creatives[0]!.body, 'Shared');
  assert.equal(result.ads[0]!.creatives[0]!.media.length, 1);
  assert.equal(result.ads[0]!.creatives[1]!.media[0]!.kind, 'image');
});

test('creative switching retains all variants, pauses hidden videos, and wraps in both directions', async () => {
  const { runInNewContext } = await import('node:vm');
  const item = ad();
  const html = renderAdReport([input([item])]);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  let paused = 0;
  const variants = Array.from({ length: 3 }, (_, i) => ({
    hidden: i !== 0,
    textContent: `Creative ${i}`,
    querySelectorAll: () => [{ pause: () => paused++ }],
  }));
  const listeners: Record<string, () => void> = {};
  const controls = [-1, 1].map((step) => ({
    dataset: { step: String(step) },
    addEventListener: (_: string, fn: () => void) => {
      listeners[step] = fn;
    },
  }));
  const output = { textContent: '' };
  const card = {
    textContent: 'Example',
    dataset: { group: 'ad:123', ad: '123', media: 'video' } as Record<
      string,
      string
    >,
    querySelectorAll: (selector: string) =>
      selector === '.variant' ? variants : controls,
    querySelector: (selector: string) =>
      selector === '.ad-group' ? null : output,
  };
  const document = {
    querySelectorAll: (selector: string) =>
      selector === '.card' ? [card] : [],
    getElementById: () => ({ value: '', addEventListener() {} }),
  };
  runInNewContext(script, { document });
  listeners[1]!();
  assert.equal(card.dataset.current, '1');
  assert.deepEqual(
    variants.map((v) => v.hidden),
    [true, false, true],
  );
  assert.equal(output.textContent, 'Creative 2 of 3');
  listeners[-1]!();
  listeners[-1]!();
  assert.equal(card.dataset.current, '2');
  assert.equal(output.textContent, 'Creative 3 of 3');
  assert.ok(paused > 0);
});

test('source CTA, footer copy and collation counts retain their own meanings', () => {
  const item = { ...ad(), collation_count: 4 };
  item.snapshot.cta_text = 'Subscribe';
  const html = renderAdReport([input([item])]);
  assert.match(html, /class="cta"[^>]*>Subscribe<\/a>/);
  assert.match(html, /class="domain">example.test<\/div>/);
  assert.match(html, /<strong>4 ads<\/strong> use this creative and text/);
  assert.ok(!html.includes('Creative 1 of 4'));
  const withoutCta = ad();
  withoutCta.snapshot.cta_text = '';
  assert.ok(!renderAdReport([input([withoutCta])]).includes('class="cta"'));
});

test('only identical verified ordered videos of one advertiser group together', () => {
  const make = (
    id: string,
    page = '99',
    hash = 'a'.repeat(64),
    kind = 'video',
  ) => ({
    archive_id: id,
    page_id: page,
    status: 'active',
    media: [
      { kind, url: 'https://example.test/video.mp4', content_sha256: hash },
    ],
  });
  const { ads } = normalizeAdReport([
    {
      name: 'stored.json',
      payload: {
        schemaVersion: 1,
        items: [
          make('1'),
          make('2'),
          make('3', '100'),
          make('4', '99', ''),
          make('5', '99', 'a'.repeat(64), 'image'),
          make('6', '99', 'b'.repeat(64)),
        ],
      },
    },
  ]);
  assert.equal(
    reportCreativeGroupKey(ads[0]!),
    reportCreativeGroupKey(ads[1]!),
  );
  for (const other of ads.slice(2))
    assert.notEqual(
      reportCreativeGroupKey(ads[0]!),
      reportCreativeGroupKey(other),
    );
});

test('group selection and status filtering retain each original ad without duplicate cards', async () => {
  const { runInNewContext } = await import('node:vm');
  const html = renderAdReport([input([ad()])]);
  const controls = new Map<string, any>();
  const element = () => ({
    value: '',
    hidden: false,
    textContent: '',
    style: { cssText: '' },
    children: [] as any[],
    onChange: () => {},
    setAttribute() {},
    addEventListener(_event: string, fn: () => void) {
      this.onChange = fn;
    },
    replaceChildren() {
      this.children = [];
    },
    append(child: any) {
      this.children.push(child);
    },
  });
  for (const id of ['query', 'status', 'media', 'count', 'empty'])
    controls.set(id, element());
  const cards = ['active', 'inactive'].map((status, index) => {
    const variant = {
      hidden: false,
      textContent: 'Novel writing',
      querySelector: () => ({}),
      querySelectorAll: () => [],
    };
    const card = {
      dataset: {
        ad: String(index + 1),
        group: 'same-video',
        brand: '99',
        status,
        media: 'video',
      } as Record<string, string>,
      textContent: 'Novel writing',
      hidden: false,
      control: null as any,
      prepend(control: any) {
        this.control = control;
      },
      querySelector(selector: string) {
        return selector === '.ad-group'
          ? this.control
          : selector === '.meta'
            ? { textContent: 'Novel writing' }
            : null;
      },
      querySelectorAll(selector: string) {
        return selector === '.variant' ? [variant] : [];
      },
    };
    return card;
  });
  const document = {
    querySelectorAll: (selector: string) => (selector === '.card' ? cards : []),
    getElementById: (id: string) => controls.get(id),
    createElement: element,
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document,
  });
  assert.deepEqual(
    cards.map((card) => card.hidden),
    [false, true],
  );
  assert.equal(controls.get('count').textContent, '2 of 2 ads · 1 card');
  assert.equal(cards[0]!.control.children.length, 2);
  assert.equal(cards[1]!.control.children.length, 0);
  cards[0]!.control.value = '2';
  cards[0]!.control.onChange();
  assert.deepEqual(
    cards.map((card) => card.hidden),
    [true, false],
  );
  controls.get('status').value = 'active';
  controls.get('status').onChange();
  assert.deepEqual(
    cards.map((card) => card.hidden),
    [false, true],
  );
  assert.equal(cards[0]!.control.hidden, true);
  assert.equal(controls.get('count').textContent, '1 of 2 ads · 1 card');
});

test('stored videos use only their matching thumbnail and reject unsafe poster URLs', () => {
  const payload = {
    schemaVersion: 1,
    items: [
      {
        archive_id: '1',
        page_id: '99',
        media: [
          {
            kind: 'video',
            url: 'https://example.test/first.mp4',
            sort_order: 0,
          },
          {
            kind: 'video',
            url: 'https://example.test/second.mp4',
            sort_order: 1,
          },
          {
            kind: 'thumbnail',
            url: 'https://example.test/second.jpg',
            sort_order: 1,
          },
          {
            kind: 'thumbnail',
            url: 'https://example.test/first.jpg',
            sort_order: 0,
          },
          {
            kind: 'video',
            url: 'https://example.test/third.mp4',
            sort_order: 2,
          },
          { kind: 'thumbnail', url: '', sort_order: 2 },
        ],
      },
    ],
  };
  const inputs = [{ name: 'stored.json', payload }];
  const media = normalizeAdReport(inputs).ads[0]!.creatives[0]!.media;
  assert.equal(media.length, 3);
  assert.deepEqual(
    media.map((item) => item.poster),
    ['https://example.test/first.jpg', 'https://example.test/second.jpg', ''],
  );
  const html = renderAdReport(inputs);
  assert.match(html, /poster="https:\/\/example.test\/first.jpg"/);
  assert.ok(!html.includes('javascript:'));
  payload.items[0]!.media[5]!.url = 'javascript:alert(1)';
  assert.throws(() => renderAdReport(inputs), /Unsafe report URL/);
});
