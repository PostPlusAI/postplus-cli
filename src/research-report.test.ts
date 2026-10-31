import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runHostedDomainCommand } from './hosted-domain-commands.js';
import {
  RESEARCH_ANALYSIS_SCHEMA,
  validateResearchAnalysis,
} from './research-report-analysis.js';
import {
  type ReportInput,
  normalizeResearchReport,
} from './research-report-model.js';
import { renderResearchReport, runResearchReport } from './research-report.js';

const input = (
  routeKey: string,
  items: unknown[],
  name = 'batch.json',
): ReportInput => ({
  name,
  payload: {
    routeKey,
    status: 'completed',
    output: { items, input: { searchQueries: ['portable espresso'] } },
  },
});
const video = (id = '900') => ({
  id,
  text: 'How to use a portable espresso maker',
  webVideoUrl: `https://www.tiktok.com/@maker/video/${id}`,
  authorMeta: {
    id: '11',
    name: 'maker',
    fans: 12000,
    signature: 'Coffee outside',
    avatar: 'https://example.test/avatar.jpg',
  },
  videoMeta: { coverUrl: 'https://example.test/cover.jpg' },
  diggCount: 0,
  playCount: 1200,
});
const inputs = () => [
  input('tiktok-videos', [video()]),
  input('tiktok-profiles', [video()], 'profiles.json'),
];
const analysis = () => ({
  schemaVersion: 1,
  goal: 'Find coffee creators',
  criteria: [{ id: 'fit', label: 'Shows the product in use', origin: 'user' }],
  items: [
    {
      id: 'tiktok:creator:11',
      decision: 'include',
      reason: 'A relevant demonstration is present',
      analysisDepth: 'metadata',
      criteria: [
        { id: 'fit', status: 'met', evidenceIds: ['tiktok:content:900'] },
      ],
      evidenceIds: ['tiktok:content:900'],
      topics: ['coffee'],
    },
  ],
});

test('declared TikTok MP4 content remains video without a direct file URL and preserves explicit media types', () => {
  const mp4 = { format: 'mp4', duration: 29, width: 720, height: 1280 };
  const rows = [
    { ...video('901'), isSlideshow: false, videoMeta: mp4, mediaUrls: [] },
    { ...video('902'), videoMeta: mp4 },
    { ...video('903'), isSlideshow: true, videoMeta: mp4 },
    { ...video('904'), isSlideshow: false },
    { ...video('905'), type: 'Image', videoMeta: mp4 },
    { ...video('906'), type: 'Video' },
    { ...video('907'), productType: 'clips', videoMeta: mp4 },
  ];
  const report = normalizeResearchReport([
    input('tiktok-videos', rows),
    input('instagram-posts', [{ id: '908', videoMeta: mp4 }], 'instagram.json'),
  ]);
  assert.deepEqual(
    report.items.map((item) => item.mediaFormat),
    [
      'video',
      'video',
      'slideshow',
      'unknown',
      'image',
      'video',
      'reel',
      'unknown',
    ],
  );
  assert.ok(!report.items[0]!.video);
  assert.deepEqual(report.items[0]!.images, []);
});

test('projects both platforms, profile snapshots and actual zeros without fabricating missing metrics', () => {
  const report = normalizeResearchReport([
    ...inputs(),
    input(
      'instagram-posts',
      [
        {
          id: '55',
          shortCode: 'abc',
          ownerUsername: 'coffee',
          caption: 'Tutorial',
          displayUrl: 'https://example.test/a.jpg',
          images: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
          timestamp: '2026-10-19',
          likesCount: 8,
        },
      ],
      'ins.json',
    ),
  ]);
  assert.equal(report.items.length, 3);
  assert.equal(report.items[0]!.metrics.likes, 0);
  assert.equal(report.items[0]!.metrics.comments, undefined);
  assert.equal(report.items[1]!.id, 'tiktok:creator:11');
  assert.equal(report.items[1]!.metrics.followers, 12000);
  assert.equal(report.items[1]!.text, 'Coffee outside');
  assert.equal(report.items[2]!.url, 'https://www.instagram.com/p/abc/');
  assert.equal(report.items[2]!.images.length, 2);
  assert.deepEqual(report.sources[0]!.input, {
    queries: ['portable espresso'],
  });
});
test('stable IDs survive batch order, duplicate records preserve all sources and distinct captions do not merge identities', () => {
  const report = normalizeResearchReport([
    input('tiktok-videos', [video('1'), video('2')], 'a.json'),
    input('tiktok-videos', [video('1')], 'b.json'),
  ]);
  assert.equal(report.items.length, 2);
  assert.equal(report.returned, 3);
  assert.equal(report.duplicates, 1);
  assert.deepEqual(report.items[0]!.sources, ['a.json', 'b.json']);
  const reverse = normalizeResearchReport([
    input('tiktok-videos', [video('1')], 'b.json'),
    input('tiktok-videos', [video('1')], 'a.json'),
  ]);
  assert.equal(report.items[0]!.id, reverse.items[0]!.id);
});
test('comments retain parent source from the real output input envelope', () => {
  const report = normalizeResearchReport([
    {
      name: 'comments.json',
      payload: {
        routeKey: 'tiktok-comments',
        status: 'completed',
        output: {
          input: { postURLs: ['https://www.tiktok.com/@maker/video/900'] },
          items: [{ id: 'c1', text: 'Will it heat water?', likesCount: 4 }],
        },
      },
    },
  ]);
  assert.equal(
    report.items[0]!.parentUrl,
    'https://www.tiktok.com/@maker/video/900',
  );
  assert.match(report.items[0]!.id, /comment:.*c1$/);
});
test('search accounts and hashtag discovery do not become content recommendations', () => {
  const report = normalizeResearchReport([
    input('instagram-search', [
      {
        users: [{ id: 'u1', username: 'coffee', biography: 'Coffee maker' }],
        hashtags: [
          {
            id: 'h1',
            name: 'coffee',
            url: 'https://www.instagram.com/explore/tags/coffee/',
          },
        ],
      },
    ]),
  ]);
  assert.deepEqual(
    report.items.map((item) => item.kind),
    ['creator', 'discovery'],
  );
});
test('preserves real terminal and processing outcomes without treating failures as empty success', () => {
  const statuses = ['failed', 'processing', 'canceled'];
  const report = normalizeResearchReport(
    statuses.map((status) => ({
      name: status,
      payload: {
        routeKey: 'tiktok-videos',
        status,
        error: { message: 'Collection unavailable' },
      },
    })),
  );
  assert.equal(report.items.length, 0);
  assert.deepEqual(
    report.sources.map((source) => source.count),
    [null, null, null],
  );
  assert.deepEqual(
    report.sources.map((source) => source.status),
    statuses,
  );
  assert.throws(
    () =>
      normalizeResearchReport([
        {
          name: 'x',
          payload: { routeKey: 'tiktok-videos', status: 'completed' },
        },
      ]),
    /no items/,
  );
  assert.throws(
    () =>
      normalizeResearchReport([
        {
          name: 'x',
          payload: {
            routeKey: 'reddit-search',
            status: 'completed',
            output: { items: [] },
          },
        },
      ]),
    /Unsupported/,
  );
  assert.throws(
    () =>
      normalizeResearchReport([
        input('tiktok-videos', [{ text: 'No identity' }]),
      ]),
    /stable/,
  );
});
test('validates analysis shape, evidence identities and conditions rather than accepting unchecked claims', () => {
  const report = normalizeResearchReport(inputs());
  assert.equal(
    validateResearchAnalysis(analysis(), report.items).items.length,
    1,
  );
  for (const mutate of [
    (v: any) => (v.unknown = true),
    (v: any) => (v.items[0].id = 'missing'),
    (v: any) => (v.items[0].criteria[0].id = 'absent'),
    (v: any) => (v.items[0].criteria[0].evidenceIds = ['missing']),
    (v: any) => (v.items[0].criteria[0].evidenceIds = []),
    (v: any) => v.items.push(v.items[0]),
    (v: any) => v.criteria.push(v.criteria[0]),
    (v: any) => (v.items[0].analysisDepth = 'watched everything'),
  ]) {
    const v = analysis();
    mutate(v);
    assert.throws(() => validateResearchAnalysis(v, report.items));
  }
  const unknown = analysis();
  unknown.items[0]!.criteria[0]!.status = 'unknown';
  unknown.items[0]!.criteria[0]!.evidenceIds = [];
  validateResearchAnalysis(unknown, report.items);
});
test('unsafe URLs reject before rendering and markup is escaped', () => {
  for (const url of [
    'javascript:alert(1)',
    'https://secret:password@example.test/a',
  ])
    assert.throws(
      () =>
        normalizeResearchReport([
          input('tiktok-videos', [{ ...video(), webVideoUrl: url }]),
        ]),
      /HTTP/,
    );
  const report = normalizeResearchReport([
    input('tiktok-videos', [
      {
        ...video(),
        text: '</script><img src=x onerror=alert(1)>',
        authorMeta: { id: '11', name: '<unsafe>' },
      },
    ]),
  ]);
  const html = renderResearchReport(report);
  assert.ok(!html.includes('</script><img'));
  assert.ok(html.includes('&lt;unsafe&gt;'));
  assert.ok(html.includes('&lt;/script&gt;'));
});
test('fixed report retains hundreds of records, complete image sequence and explicit missing previews', () => {
  const report = normalizeResearchReport([
    input(
      'tiktok-videos',
      Array.from({ length: 350 }, (_, i) => video(String(i))),
    ),
  ]);
  const html = renderResearchReport(report);
  assert.equal((html.match(/class="card(?: tk-card)?"/g) || []).length, 350);
  assert.match(html, /loading="lazy"/);
  assert.ok(!html.includes('<h1>'));
  assert.ok(!html.includes('PostPlus · Research evidence'));
  assert.ok(!html.includes('Collection outcomes'));
  assert.ok(!html.includes('<script src='));
  assert.ok(!html.includes('Creators (0)'));
  assert.match(html, /@media\(max-width:550px\)/);
  const empty = renderResearchReport(
    normalizeResearchReport([
      input('instagram-posts', [{ id: '1', caption: 'No image' }]),
    ]),
  );
  assert.match(empty, /Preview unavailable/);
});
test('analysis exposes reasons, criteria, inspection depth and evidence links', () => {
  const report = normalizeResearchReport(inputs()),
    html = renderResearchReport(
      report,
      validateResearchAnalysis(analysis(), report.items),
    );
  assert.match(html, /A relevant demonstration is present/);
  assert.ok(!html.includes('Inspection: metadata'));
  assert.ok(!html.includes('User condition'));
  assert.match(html, /data-evidence="tiktok:content:900"/);
  assert.ok(!html.includes('Collection sources'));
});
test('report CLI writes locally, emits stable IDs, and never overwrites evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-report-'));
  try {
    const source = join(dir, 'raw.json'),
      out = join(dir, 'report.html'),
      findings = join(dir, 'analysis.json');
    await writeFile(
      source,
      JSON.stringify(input('tiktok-videos', [video()]).payload),
    );
    let stdout = '';
    await runResearchReport(
      ['--input', source, '--output', out],
      (text) => (stdout += text),
    );
    assert.equal(JSON.parse(stdout).items[0].id, 'tiktok:content:900');
    assert.match(await readFile(out, 'utf8'), /tk-preview/);
    await assert.rejects(
      runResearchReport(['--input', source, '--output', source]),
      /overwrite/,
    );
    await assert.rejects(
      runResearchReport([
        '--input',
        source,
        '--input',
        source,
        '--output',
        out,
      ]),
      /Duplicate/,
    );
    const bad = analysis();
    await writeFile(findings, JSON.stringify(bad));
    await assert.rejects(
      runResearchReport([
        '--input',
        source,
        '--analysis',
        findings,
        '--output',
        out,
      ]),
      /missing evidence/,
    );
    assert.match(await readFile(out, 'utf8'), /tk-preview/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('schema discovery and help are local; in-process hosted execution is rejected', async () => {
  let stdout = '';
  await runResearchReport(['--analysis-schema'], (text) => (stdout += text));
  assert.deepEqual(JSON.parse(stdout), RESEARCH_ANALYSIS_SCHEMA);
  stdout = '';
  await runResearchReport(['--help'], (text) => (stdout += text));
  assert.match(stdout, /No login, credits, network calls/);
  await assert.rejects(
    runHostedDomainCommand('research', ['report'], {} as any),
    /local CLI/,
  );
});

test('generated interaction script filters views, searches, sorts and opens referenced evidence', async () => {
  const { runInNewContext } = await import('node:vm');
  const report = normalizeResearchReport(inputs());
  const html = renderResearchReport(
    report,
    validateResearchAnalysis(analysis(), report.items),
  );
  function element(dataset: Record<string, string> = {}) {
    return {
      dataset,
      hidden: false,
      value: '',
      textContent: '',
      attributes: {} as Record<string, string>,
      events: {} as Record<string, () => void>,
      setAttribute(key: string, value: string) {
        this.attributes[key] = value;
      },
      addEventListener(event: string, handler: () => void) {
        this.events[event] = handler;
      },
      scrollIntoView() {
        this.attributes.scrolled = 'true';
      },
    };
  }
  const cards = report.items.map((item) =>
    element({
      kind: item.kind,
      platform: item.platform,
      decision: item.kind === 'creator' ? 'include' : 'unreviewed',
      likes: String(item.metrics.likes ?? -1),
      tags: JSON.stringify(item.kind === 'content' ? ['coffee'] : []),
      search: [item.text, item.author].join(' ').toLowerCase(),
    }),
  );
  const tabs = ['content', 'creator', 'comment', 'discovery'].map((kind) =>
    element({ view: kind }),
  );
  const controls = Object.fromEntries(
    ['query', 'platform', 'decision', 'sort', 'count', 'empty'].map((id) => [
      id,
      { ...element(), id },
    ]),
  );
  const topics = ['', 'coffee', 'unrelated'].map((tag) => element({ tag }));
  const appended: unknown[] = [];
  const evidenceLink = element({ evidence: 'tiktok:content:900' });
  const body = { ...element({ view: 'creator' }), classList: { toggle() {} } };
  const document = {
    body,
    querySelectorAll(selector: string) {
      return selector === '[data-tag]'
        ? topics
        : selector === '.card'
          ? cards
          : selector === '[data-view]'
            ? [...tabs, body]
            : selector === '.tabs button[data-view]'
              ? tabs
              : selector === 'input,select'
                ? Object.values(controls).filter((el) =>
                    ['query', 'platform', 'decision', 'sort'].includes(el.id),
                  )
                : selector === '[data-evidence]'
                  ? [evidenceLink]
                  : [];
    },
    getElementById(id: string) {
      if (id === 'grid')
        return { append: (card: unknown) => appended.push(card) };
      if (id === 'item-' + encodeURIComponent('tiktok:content:900'))
        return cards[0];
      return controls[id];
    },
  };
  controls.decision!.value = 'include';
  assert.match(html, /<option value="include" selected>Recommended/);
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document,
  });
  assert.equal(controls.count!.textContent, '1 results shown');
  assert.equal(cards[0]!.hidden, true);
  assert.equal(cards[1]!.hidden, false);
  tabs[0]!.events.click!();
  assert.equal(controls.empty!.hidden, true);
  assert.equal(controls.decision!.value, '');
  controls.decision!.value = '';
  controls.decision!.events.input!();
  assert.equal(cards[0]!.hidden, false);
  controls.query!.value = 'unrelated';
  controls.query!.events.input!();
  assert.equal(controls.empty!.hidden, false);
  evidenceLink.events.click!();
  assert.equal(cards[0]!.hidden, false);
  assert.equal(cards[0]!.attributes.scrolled, 'true');
  assert.equal(controls.query!.value, '');
  topics[2]!.events.click!();
  body.events.click?.(); // Real tag clicks bubble to body, which also has data-view.
  assert.equal(
    body.events.click,
    undefined,
    'body must never be bound as a view tab',
  );
  assert.equal(cards[0]!.hidden, true);
  topics[1]!.events.click!();
  body.events.click?.();
  assert.equal(cards[0]!.hidden, false);
  assert.equal(topics[1]!.attributes['aria-pressed'], 'true');
  controls.sort!.value = 'likes';
  controls.sort!.events.input!();
  assert.equal(appended.length, 2);
});

test('latest genuinely dated snapshot replaces fields wholesale while retaining all observations', () => {
  const older = input(
    'instagram-profiles',
    [
      {
        id: '7',
        username: 'creator',
        biography: 'Old bio',
        followersCount: 100,
      },
    ],
    'old.json',
  );
  const newer = input(
    'instagram-profiles',
    [{ id: '7', username: 'creator', biography: 'New bio' }],
    'new.json',
  );
  (older.payload as any).output.fetchedAt = '2026-10-18T00:00:00Z';
  (newer.payload as any).output.fetchedAt = '2026-10-19T00:00:00Z';
  for (const inputs of [
    [older, newer],
    [newer, older],
  ]) {
    const item = normalizeResearchReport(inputs).items[0]!;
    assert.equal(item.text, 'New bio');
    assert.equal(
      item.metrics.followers,
      undefined,
      'old fields must not leak into the new snapshot',
    );
    assert.equal(item.sources.length, 2);
    assert.equal(item.observedAt, '2026-10-19T00:00:00Z');
  }
  delete (older.payload as any).output.fetchedAt;
  assert.equal(
    normalizeResearchReport([older, newer]).items[0]!.text,
    'Old bio',
    'undated ordering must not invent recency',
  );
});

test('accepts typed PostPlus error-only files as failures with unknown route, never as zero results', () => {
  const report = normalizeResearchReport([
    {
      name: 'error.json',
      payload: {
        error: {
          code: 'postplus_cli_hosted_provider_timeout',
          message: 'Collection timed out',
          layer: 'hosted-capability',
          operationId: 'op1',
        },
      },
    },
  ]);
  assert.equal(report.sources[0]!.route, 'unknown route');
  assert.equal(report.sources[0]!.status, 'failed');
  assert.equal(report.sources[0]!.count, null);
  assert.equal(report.returned, 0);
  const html = renderResearchReport(report);
  assert.ok(!html.includes('Collection outcomes'));
  assert.ok(!html.includes('postplus_cli_hosted_provider_timeout'));
  for (const payload of [
    { error: 'random' },
    { error: { code: 'random', message: 'unknown' } },
    { error: { code: 'postplus_cli_x' } },
    { status: 'completed', error: { code: 'postplus_cli_x', message: 'bad' } },
  ])
    assert.throws(
      () => normalizeResearchReport([{ name: 'unknown.json', payload }]),
      /Unsupported/,
    );
});

test('raw reports retain all decisions while content recommendations select content view', () => {
  const report = normalizeResearchReport(inputs());
  const raw = renderResearchReport(report);
  assert.ok(!raw.includes('<option value="include" selected>'));
  assert.match(raw, /let view="content"/);
  const findings = analysis();
  findings.items[0]!.id = 'tiktok:content:900';
  const html = renderResearchReport(
    report,
    validateResearchAnalysis(findings, report.items),
  );
  assert.match(html, /<option value="include" selected>Recommended/);
  assert.match(html, /let view="content"/);
});

test('nested Instagram replies are reviewable evidence with independent stable IDs', () => {
  const report = normalizeResearchReport([
    {
      name: 'comments.json',
      payload: {
        routeKey: 'instagram-comments',
        status: 'completed',
        output: {
          input: { directUrls: ['https://www.instagram.com/p/abc/'] },
          items: [
            {
              id: 'top',
              text: 'Is this suitable for oily skin?',
              replies: [
                {
                  id: 'reply',
                  text: 'It worked for my skin.',
                  ownerUsername: 'reader',
                },
              ],
            },
          ],
        },
      },
    },
  ]);
  assert.equal(report.returned, 1);
  assert.deepEqual(
    report.items.map((item) => item.id),
    ['instagram:comment:top', 'instagram:comment:reply'],
  );
  assert.equal(report.items[1]!.parentUrl, 'https://www.instagram.com/p/abc/');
  assert.deepEqual(report.items[1]!.sourcePaths, [
    { source: 'comments.json', path: 'output.items[0].replies[0]' },
  ]);
  assert.match(renderResearchReport(report), /It worked for my skin/);
});
