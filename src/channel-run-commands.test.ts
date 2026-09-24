import assert from 'node:assert/strict';
import { test } from 'node:test';

import { channelRunExitCode, parseChannelRun } from './channel-run-commands.js';

test('run grammar is projected from fixed public action fields', () => {
  const parsed = parseChannelRun([
    'ga4.report',
    '--connection',
    'local-id',
    '--target',
    'properties/1',
    '--start-date',
    '2026-01-01',
    '--end-date',
    '2026-01-31',
    '--dimensions',
    'country',
    '--metrics',
    'activeUsers,sessions',
    '--limit',
    '100',
    '--offset',
    '0',
    '--operation-id',
    'original',
    '--wait',
  ]);
  assert.equal(parsed.request.operationId, 'original');
  assert.equal(parsed.wait, true);
  assert.deepEqual(parsed.request.parameters.metrics, [
    'activeUsers',
    'sessions',
  ]);
  assert.equal(parsed.request.parameters.limit, 100);
});

test('Reddit Ads campaign status preserves the selected account and inspected snapshot', () => {
  const parsed = parseChannelRun([
    'reddit-ads.campaign.status.update',
    '--connection',
    'mine',
    '--target',
    'campaign-123',
    '--target-account-id',
    'account-456',
    '--expected-name',
    'Test Campaign',
    '--expected-status',
    'ACTIVE',
    '--new-status',
    'PAUSED',
  ]);
  assert.deepEqual(parsed.request.target, {
    kind: 'reddit_ads_campaign',
    accountId: 'account-456',
    id: 'campaign-123',
  });
  assert.deepEqual(parsed.request.parameters, {
    expectedName: 'Test Campaign',
    expectedStatus: 'ACTIVE',
    newStatus: 'PAUSED',
  });
});

test('Reddit Ads account discovery needs the connection, not a guessed account ID', () => {
  const parsed = parseChannelRun([
    'reddit-ads.accounts.list',
    '--connection',
    'mine',
  ]);
  assert.deepEqual(parsed.request.target, { kind: 'connection' });
  assert.deepEqual(parsed.request.parameters, {});
  assert.throws(() =>
    parseChannelRun([
      'reddit-ads.accounts.list',
      '--connection',
      'mine',
      '--target',
      'a2_other',
    ]),
  );
});
test('run grammar rejects raw provider controls, duplicate flags and incomplete requests', () => {
  for (const args of [
    ['google-ads.accounts.list', '--connection', 'a', '--tool', 'ANY'],
    ['google-ads.accounts.list', '--connection', 'a', '--connection', 'b'],
    ['ga4.report', '--connection', 'a'],
    ['execute-any-tool', '--connection', 'a'],
  ])
    assert.throws(() => parseChannelRun(args));
});

test('Google target path comes from the generated contract and is preserved as an exact array', () => {
  const parsed = parseChannelRun([
    'google-ads.campaigns.report',
    '--connection',
    'mine',
    '--target',
    'customers/2222222222',
    '--target-access-path',
    'customers/1111111111,customers/2222222222',
    '--start-date',
    '2026-01-01',
    '--end-date',
    '2026-01-31',
  ]);
  assert.deepEqual(parsed.request.target, {
    kind: 'google_customer',
    id: 'customers/2222222222',
    accessPath: ['customers/1111111111', 'customers/2222222222'],
  });
  assert.throws(
    () =>
      parseChannelRun([
        'google-ads.accounts.children',
        '--connection',
        'mine',
        '--target',
        'customers/1111111111',
      ]),
    /target-access-path/,
  );
});

test('arrays preserve explicit empty dimensions and reject missing items in a target path', () => {
  const parsed = parseChannelRun([
    'ga4.report',
    '--connection',
    'mine',
    '--target',
    'properties/1',
    '--start-date',
    '2026-01-01',
    '--end-date',
    '2026-01-31',
    '--dimensions',
    '[]',
    '--metrics',
    'activeUsers',
    '--limit',
    '1',
    '--offset',
    '0',
  ]);
  assert.deepEqual(parsed.request.parameters.dimensions, []);
  assert.throws(
    () =>
      parseChannelRun([
        'google-ads.accounts.children',
        '--connection',
        'mine',
        '--target',
        'customers/1111111111',
        '--target-access-path',
        'customers/1111111111,,customers/2222222222',
      ]),
    /empty item/,
  );
});

test('budget grammar preserves exact decimal money, account path and inspected snapshot', () => {
  const parsed = parseChannelRun([
    'google-ads.budgets.update',
    '--connection',
    'mine',
    '--target',
    'customers/1234567890/campaignBudgets/2',
    '--target-account-id',
    'customers/1234567890',
    '--target-access-path',
    'customers/1234567890',
    '--amount',
    '9007199254.740993',
    '--currency',
    'USD',
    '--expected-snapshot',
    'a'.repeat(64),
  ]);
  assert.equal(parsed.request.parameters.amount, '9007199254.740993');
  assert.equal(parsed.request.parameters.expectedSnapshot, 'a'.repeat(64));
  assert.deepEqual(parsed.request.target, {
    kind: 'google_budget',
    id: 'customers/1234567890/campaignBudgets/2',
    accountId: 'customers/1234567890',
    accessPath: ['customers/1234567890'],
  });
  assert.throws(
    () =>
      parseChannelRun([
        'google-ads.budgets.update',
        '--connection',
        'mine',
        '--target',
        'customers/1234567890/campaignBudgets/2',
        '--target-account-id',
        'customers/1234567890',
        '--target-access-path',
        'customers/1234567890',
        '--amount',
        '1',
        '--currency',
        'USD',
      ]),
    /expected-snapshot/,
  );
});

test('Search Console preserves domain-property identity and explicit report controls', () => {
  const parsed = parseChannelRun([
    'gsc.report',
    '--connection',
    'mine',
    '--target',
    'sc-domain:example.com',
    '--start-date',
    '2026-01-01',
    '--end-date',
    '2026-01-31',
    '--dimensions',
    'date,query',
    '--search-type',
    'web',
    '--data-state',
    'final',
    '--aggregation-type',
    'auto',
    '--limit',
    '100',
    '--offset',
    '200',
  ]);
  assert.deepEqual(parsed.request.target, {
    kind: 'search_console_site',
    id: 'sc-domain:example.com',
  });
  assert.deepEqual(parsed.request.parameters.dimensions, ['date', 'query']);
  assert.equal(parsed.request.parameters.offset, 200);
  const inspection = parseChannelRun([
    'gsc.url.inspect',
    '--connection',
    'mine',
    '--target',
    'https://example.com/blog/',
    '--url',
    'https://example.com/blog/page',
    '--language',
    'en-US',
  ]);
  assert.equal(inspection.request.target.id, 'https://example.com/blog/');
});

test('Instagram carousel and Reel commands preserve ordered children and fixed media inputs', () => {
  const carousel = parseChannelRun([
    'instagram.carousel.container.create',
    '--connection',
    'mine',
    '--target',
    '123',
    '--children',
    '456,789',
    '--caption',
    'Two slides',
  ]);
  assert.deepEqual(carousel.request.target, {
    kind: 'instagram_account',
    id: '123',
  });
  assert.deepEqual(carousel.request.parameters, {
    children: ['456', '789'],
    caption: 'Two slides',
  });
  const reel = parseChannelRun([
    'instagram.reel.container.create',
    '--connection',
    'mine',
    '--target',
    '123',
    '--video-url',
    'https://example.test/reel.mp4',
    '--caption',
    'Demo',
  ]);
  assert.deepEqual(reel.request.parameters, {
    videoUrl: 'https://example.test/reel.mp4',
    caption: 'Demo',
  });
  assert.throws(
    () =>
      parseChannelRun([
        'instagram.carousel.container.create',
        '--connection',
        'mine',
        '--target',
        '123',
        '--children',
        '456,,789',
        '--caption',
        'Invalid',
      ]),
    /empty item/,
  );
});

test('LinkedIn image command preserves the exact author and owned media reference', () => {
  const parsed = parseChannelRun([
    'linkedin.post.image.create',
    '--connection',
    'mine',
    '--target',
    'urn:li:organization:123',
    '--commentary',
    'Image demo',
    '--media-reference',
    'postplus-media://uploads/alice/photo.png',
  ]);
  assert.deepEqual(parsed.request.target, {
    kind: 'linkedin_author',
    id: 'urn:li:organization:123',
  });
  assert.deepEqual(parsed.request.parameters, {
    commentary: 'Image demo',
    mediaReference: 'postplus-media://uploads/alice/photo.png',
  });
});

test('Pinterest carousel command preserves image order and primary index', () => {
  const parsed = parseChannelRun([
    'pinterest.pin.carousel.create',
    '--connection',
    'mine',
    '--target',
    '123',
    '--image-urls',
    'https://example.test/first.jpg,https://example.test/second.jpg',
    '--title',
    'Demo carousel',
    '--description',
    'Two images',
    '--primary-image-index',
    '1',
  ]);
  assert.deepEqual(parsed.request.target, {
    kind: 'pinterest_board',
    id: '123',
  });
  assert.deepEqual(parsed.request.parameters, {
    imageUrls: [
      'https://example.test/first.jpg',
      'https://example.test/second.jpg',
    ],
    title: 'Demo carousel',
    description: 'Two images',
    primaryImageIndex: 1,
  });
});

test('unknown execution is not a successful CLI exit', () => {
  assert.equal(
    channelRunExitCode({
      output: { execution: { resultStatus: 'unknown' } },
    }),
    2,
  );
  assert.equal(
    channelRunExitCode({
      output: { execution: { resultStatus: 'failed' } },
    }),
    1,
  );
  assert.equal(
    channelRunExitCode({
      output: { execution: { resultStatus: 'verified' } },
    }),
    0,
  );
});

test('Pinterest video commands keep upload, media status, Pin create and inspection separate', () => {
  const upload = parseChannelRun([
    'pinterest.video.media.upload',
    '--connection',
    'mine',
    '--target',
    '123',
    '--media-reference',
    'postplus-media://uploads/alice/video.mp4',
  ]);
  assert.deepEqual(upload.request.parameters, {
    mediaReference: 'postplus-media://uploads/alice/video.mp4',
  });
  const status = parseChannelRun([
    'pinterest.video.media.status',
    '--connection',
    'mine',
    '--target',
    '789',
  ]);
  assert.deepEqual(status.request.target, {
    kind: 'pinterest_media',
    id: '789',
  });
  const create = parseChannelRun([
    'pinterest.pin.video.create',
    '--connection',
    'mine',
    '--target',
    '123',
    '--media-id',
    '789',
    '--cover-image-url',
    'https://example.test/cover.jpg',
    '--title',
    'Demo video',
    '--description',
    'Video description',
  ]);
  assert.deepEqual(create.request.parameters, {
    mediaId: '789',
    coverImageUrl: 'https://example.test/cover.jpg',
    title: 'Demo video',
    description: 'Video description',
  });
  const inspect = parseChannelRun([
    'pinterest.pin.inspect',
    '--connection',
    'mine',
    '--target',
    '456',
  ]);
  assert.deepEqual(inspect.request.target, {
    kind: 'pinterest_pin',
    id: '456',
  });
});

test('target discovery commands require a connection but do not invent a target', () => {
  for (const action of [
    'instagram.account.mine',
    'linkedin.person.mine',
    'pinterest.boards.list',
    'youtube.channels.list',
  ]) {
    const parsed = parseChannelRun([action, '--connection', 'mine']);
    assert.deepEqual(parsed.request.target, { kind: 'connection' });
    assert.deepEqual(parsed.request.parameters, {});
  }
});
