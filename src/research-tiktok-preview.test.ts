import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { normalizeResearchReport } from './research-report-model.js';
import {
  TIKTOK_PREVIEW_SCRIPT,
  compactLikes,
  renderResearchReport,
  tiktokEmbedUrl,
} from './research-report.js';

const input = (items: unknown[], routeKey = 'tiktok-videos') => [
  {
    name: 'raw.json',
    payload: { routeKey, status: 'completed', output: { items } },
  },
];
const video = (id = '123') => ({
  id,
  webVideoUrl: `https://www.tiktok.com/@coffee/video/${id}`,
  text: 'Portable espresso review',
  diggCount: 12300,
  playCount: 987654,
  hashtags: [{ name: 'PortableEspresso' }, { name: 'Coffee' }],
  authorMeta: { name: 'coffee', avatar: 'https://example.test/avatar.jpg' },
  videoMeta: { coverUrl: 'https://example.test/cover.jpg' },
});

test('TikTok covers, avatars, tags and heart counts use their own returned fields', () => {
  const report = normalizeResearchReport(input([video()])),
    item = report.items[0]!;
  assert.equal(item.image, 'https://example.test/cover.jpg');
  assert.equal(item.authorAvatar, 'https://example.test/avatar.jpg');
  assert.deepEqual(item.tags, ['portableespresso', 'coffee']);
  const html = renderResearchReport(report);
  assert.match(html, /<body[^>]*class="tiktok-explore">/);
  assert.match(
    html,
    /class="tk-cover"[^>]*src="https:\/\/example.test\/cover.jpg"/,
  );
  assert.match(html, /class="tk-author-avatar"/);
  assert.match(html, /aria-label="12300 likes"/);
  assert.match(html, />12.3K<\/strong>/);
  assert.match(html, /fill="none" stroke="currentColor"/);
  assert.match(html, /data-tag="portableespresso"/);
  assert.ok(!html.includes('Singing'));
  assert.ok(!html.includes('<iframe'));
  assert.match(html, /aspect-ratio:3\/4/);
  assert.match(html, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:1099px\).*?repeat\(4/s);
  assert.ok(!html.includes('<details class="report-overview"'));
  assert.ok(!html.includes('<h1>'));
  assert.ok(!html.includes('Collection outcomes'));
  assert.ok(!html.includes('<select id="platform"'));
  assert.ok(!/<button[^>]+data-view="creator"/.test(html));
  assert.equal(compactLikes(1200000), '1.2M');
  assert.equal(compactLikes(0), '0');
  const unknown = video();
  delete (unknown as any).diggCount;
  const noLikes = renderResearchReport(
    normalizeResearchReport(input([unknown])),
  );
  assert.match(noLikes, /Likes not returned/);
  assert.match(noLikes, /<strong>—<\/strong>/);
});
test('only genuine TikTok video URLs produce official player addresses; direct media stays lazy', () => {
  const item = normalizeResearchReport(input([video()])).items[0]!;
  assert.match(
    tiktokEmbedUrl(item),
    /^https:\/\/www.tiktok.com\/player\/v1\/123\?autoplay=1&muted=0/,
  );
  for (const url of [
    'https://evil.test/@coffee/video/123',
    'https://www.tiktok.com/@coffee',
    'https://www.tiktok.com/@coffee/photo/123',
  ])
    assert.equal(tiktokEmbedUrl({ ...item, url }), '');
  const html = renderResearchReport(
    normalizeResearchReport(
      input([{ ...video(), videoUrl: 'https://example.test/clip.mp4' }]),
    ),
  );
  const tag = html.match(/<video[^>]*>/)![0];
  assert.match(tag, /data-src="https:\/\/example.test\/clip.mp4"/);
  assert.ok(!/\ssrc=/.test(tag));
  assert.match(tag, /preload="none"/);
  assert.match(tag, /playsinline loop hidden/);
  assert.ok(!/\smuted(?:\s|>)/.test(tag));
  const ins = renderResearchReport(
    normalizeResearchReport(
      input(
        [
          {
            id: '1',
            shortCode: 'x',
            displayUrl: 'https://example.test/ins.jpg',
          },
        ],
        'instagram-posts',
      ),
    ),
  );
  assert.ok(!ins.includes('<body class="tiktok-explore">'));
  assert.ok(!ins.includes('class="card tk-card"'));
});
test('real TikTok cid identities preserve 156 comments on four posts and never use the post as identity', () => {
  const comments = Array.from({ length: 156 }, (_, i) => ({
    cid: String(7000 + i),
    text: 'Same words',
    videoWebUrl: `https://www.tiktok.com/@coffee/video/${(i % 4) + 1}`,
  }));
  const report = normalizeResearchReport(input(comments, 'tiktok-comments'));
  assert.equal(report.items.length, 156);
  assert.equal(new Set(report.items.map((item) => item.id)).size, 156);
  assert.equal(report.duplicates, 0);
  assert.equal(report.items[0]!.id, 'tiktok:comment:7000');
  assert.throws(
    () =>
      normalizeResearchReport(
        input(
          [
            {
              text: 'No ID',
              videoWebUrl: 'https://www.tiktok.com/@coffee/video/1',
            },
          ],
          'tiktok-comments',
        ),
      ),
    /stable.*comment/,
  );
});

function fixture(direct = false, finePointer = true) {
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const windowEvents: Record<string, (event: any) => void> = {};
  const documentEvents: Record<string, (event: any) => void> = {};
  class Element {
    dataset: Record<string, string> = {};
    events: Record<string, ((event: any) => void)[]> = {};
    classes = new Set<string>();
    attributes: Record<string, string> = {};
    hidden = false;
    textContent = '';
    src = '';
    removed = false;
    children: Element[] = [];
    className = '';
    title = '';
    allow = '';
    referrerPolicy = '';
    muted = false;
    pauseCount = 0;
    loadCount = 0;
    playResolvers: (() => void)[] = [];
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
    };
    contentWindow = {
      messages: [] as unknown[],
      postMessage: (data: unknown, origin: string) => {
        this.contentWindow.messages.push({ data, origin });
      },
    };
    addEventListener(type: string, fn: (event: any) => void) {
      (this.events[type] ??= []).push(fn);
    }
    removeEventListener(type: string, fn: (event: any) => void) {
      this.events[type] = (this.events[type] || []).filter(
        (handler) => handler !== fn,
      );
    }
    emit(type: string, event: any = {}) {
      for (const fn of this.events[type] || []) fn(event);
    }
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    }
    removeAttribute(key: string) {
      delete this.attributes[key];
      if (key === 'src') this.src = '';
    }
    append(child: Element) {
      this.children.push(child);
    }
    remove() {
      this.removed = true;
    }
    pause() {
      this.pauseCount++;
    }
    load() {
      this.loadCount++;
    }
    play() {
      return new Promise<void>((resolve) => this.playResolvers.push(resolve));
    }
    querySelector(selector: string): Element | null {
      return null;
    }
    closest(selector: string): Element {
      return this;
    }
  }
  const node = new Element(),
    card = new Element(),
    status = new Element(),
    button = new Element(),
    volume = new Element(),
    link = new Element(),
    media = direct ? new Element() : null;
  if (media) {
    media.dataset.src = 'https://example.test/video.mp4';
    media.hidden = true;
  }
  node.dataset.embed = direct
    ? ''
    : 'https://www.tiktok.com/player/v1/123?autoplay=1&muted=0';
  node.querySelector = (selector) =>
    selector === '.tk-preview-status'
      ? status
      : selector === '.tk-volume-toggle'
        ? volume
        : selector === '.tk-hover-video'
          ? media
          : selector === '.tk-preview-toggle'
            ? button
            : selector === '.tk-cover-link'
              ? link
              : null;
  node.closest = () => card;
  card.querySelector = (selector) =>
    selector === '.tk-preview-status' ? status : null;
  const frames: Element[] = [];
  const document = {
    hidden: false,
    querySelectorAll: () => [node],
    createElement: (kind: string) => {
      assert.equal(kind, 'iframe');
      const frame = new Element();
      frames.push(frame);
      return frame;
    },
    addEventListener: (type: string, fn: (event: any) => void) =>
      (documentEvents[type] = fn),
  };
  const window = {
    matchMedia: () => ({ matches: finePointer }),
    addEventListener: (type: string, fn: (event: any) => void) =>
      (windowEvents[type] = fn),
  };
  const context = {
    document,
    window,
    Promise,
    setTimeout: (fn: () => void, ms: number) => {
      assert.ok([10000, 3000].includes(ms));
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(TIKTOK_PREVIEW_SCRIPT, context);
  return {
    node,
    card,
    status,
    button,
    volume,
    volumeClick: () =>
      volume.emit('click', { preventDefault() {}, stopPropagation() {} }),
    link,
    media,
    frames,
    windowEvents,
    documentEvents,
    timers,
    click: () =>
      button.emit('click', { preventDefault() {}, stopPropagation() {} }),
    hidden: () => runInNewContext('stopHiddenPreviews()', context),
  };
}
test('hover lazily creates one audible official iframe and leaving destroys it, without accepting forged messages', () => {
  const f = fixture();
  assert.equal(f.frames.length, 0);
  f.node.emit('mouseenter');
  assert.equal(f.frames.length, 1);
  const frame = f.frames[0]!;
  assert.match(frame.src, /player\/v1\/123/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.node.classes.has('is-playing'), false);
  f.windowEvents.message!({
    origin: 'https://evil.test',
    source: frame.contentWindow,
    data: { 'x-tiktok-player': true, type: 'onStateChange', value: 1 },
  });
  assert.equal(f.node.classes.has('is-playing'), false);
  f.windowEvents.message!({
    origin: 'https://www.tiktok.com',
    source: {},
    data: { 'x-tiktok-player': true, type: 'onPlayerError' },
  });
  assert.equal(frame.removed, false);
  f.windowEvents.message!({
    origin: 'https://www.tiktok.com',
    source: frame.contentWindow,
    data: { 'x-tiktok-player': true, type: 'onPlayerReady' },
  });
  assert.equal(frame.contentWindow.messages.length, 2);
  assert.equal((frame.contentWindow.messages[0] as any).data.type, 'unMute');
  f.windowEvents.message!({
    origin: 'https://www.tiktok.com',
    source: frame.contentWindow,
    data: { 'x-tiktok-player': true, type: 'onStateChange', value: 1 },
  });
  assert.equal(f.node.classes.has('is-playing'), true);
  assert.equal(f.timers.size, 0);
  f.node.emit('mouseleave');
  assert.equal(frame.removed, true);
  assert.equal(f.node.classes.has('is-playing'), false);
  f.node.emit('mouseenter');
  const newer = f.frames[1]!;
  f.windowEvents.message!({
    origin: 'https://www.tiktok.com',
    source: frame.contentWindow,
    data: { 'x-tiktok-player': true, type: 'onPlayerError' },
  });
  assert.equal(
    newer.removed,
    false,
    'stale frame cannot stop the next preview',
  );
});
test('real player errors keep the cover; absent API messages never remove a loaded autoplay frame', () => {
  const f = fixture();
  f.node.emit('mouseenter');
  const frame = f.frames[0]!;
  f.windowEvents.message!({
    origin: 'https://www.tiktok.com',
    source: frame.contentWindow,
    data: {
      'x-tiktok-player': true,
      type: 'onPlayerError',
      value: { errorCode: 2001 },
    },
  });
  assert.equal(frame.removed, true);
  assert.match(f.status.textContent, /unavailable/);
  assert.equal(f.timers.size, 0);
  f.node.emit('mouseenter');
  const second = f.frames[1]!;
  second.emit('load');
  assert.equal(second.removed, false);
  assert.equal(f.node.classes.has('is-loaded'), true);
  assert.equal(
    f.node.classes.has('is-playing'),
    false,
    'load is not proof of playback',
  );
  assert.equal(f.status.textContent, '');
  assert.equal(
    f.timers.size,
    0,
    'no API-ACK timer may remove the native autoplay player',
  );
  f.node.emit('mouseleave');
  assert.equal(second.removed, true);
  assert.equal(f.node.classes.has('is-loaded'), false);
});
test('touch leaves playback to the explicit in-page detail; opening detail stops and blocks grid hover', () => {
  const touch = fixture(false, false);
  touch.node.emit('mouseenter');
  assert.equal(touch.frames.length, 0);
  const f = fixture();
  f.node.emit('mouseenter');
  f.documentEvents['research-detail-open']!({});
  assert.equal(f.frames[0]!.removed, true);
  f.node.emit('mouseenter');
  assert.equal(f.frames.length, 1);
  f.documentEvents['research-detail-close']!({});
  f.node.emit('mouseenter');
  assert.equal(f.frames.length, 2);
  f.card.hidden = true;
  f.hidden();
  assert.equal(f.frames[1]!.removed, true);
});
test('direct previews defer src and a stale play promise cannot pause the reused active video', async () => {
  const f = fixture(true),
    media = f.media!;
  assert.equal(media.src, '');
  f.node.emit('mouseenter');
  assert.equal(media.src, 'https://example.test/video.mp4');
  assert.equal(media.muted, false);
  f.node.emit('mouseleave');
  assert.equal(media.src, '');
  assert.equal(media.hidden, true);
  assert.equal(f.timers.size, 0);
  f.node.emit('mouseenter');
  const pausedBefore = media.pauseCount;
  media.playResolvers[0]!();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    media.pauseCount,
    pausedBefore,
    'first hover promise must not pause the second hover',
  );
  media.emit('playing');
  assert.equal(media.hidden, false);
  assert.equal(f.timers.size, 0);
  f.node.emit('mouseleave');
  assert.equal(media.hidden, true);
  assert.equal(media.src, '');
});

test('Instagram uses actual type, names and boolean verification with dense posts and compact account rows', () => {
  const posts = normalizeResearchReport(
    input(
      [
        {
          id: '1',
          type: 'Video',
          productType: 'clips',
          displayUrl: 'https://example.test/reel.jpg',
          likesCount: -1,
          commentsCount: 5,
        },
        {
          id: '2',
          type: 'Sidecar',
          productType: 'carousel_container',
          displayUrl: 'https://example.test/carousel.jpg',
          likesCount: 12,
          commentsCount: 0,
        },
        {
          id: '3',
          type: 'Image',
          productType: 'feed',
          displayUrl: 'https://example.test/image.jpg',
        },
      ],
      'instagram-posts',
    ),
  );
  assert.deepEqual(
    posts.items.map((item) => item.mediaFormat),
    ['reel', 'carousel', 'image'],
  );
  assert.equal(posts.items[0]!.metrics.likes, undefined);
  assert.equal(posts.items[0]!.type, 'Video');
  assert.equal(posts.items[0]!.productType, 'clips');
  const html = renderResearchReport(posts);
  assert.match(html, /<body[^>]*class="instagram-native"/);
  assert.match(html, /repeat\(3,minmax\(0,1fr\)\);gap:2px/);
  assert.match(html, /max-width:950px/);
  assert.match(html, /aria-label="Video"/);
  assert.match(html, /aria-label="Carousel"/);
  assert.match(html, /ig-hover-metrics/);
  assert.match(html, /<strong>—<\/strong>/);
  assert.ok(!/<button[^>]+data-view=/.test(html));
  assert.ok(!html.includes('<select id="platform"'));
  const creators = normalizeResearchReport(
    input(
      [
        {
          id: 'a',
          username: 'realcreator',
          fullName: 'Real Creator',
          followersCount: 23400,
          verified: true,
          profilePicUrlHD: 'https://example.test/avatar.jpg',
        },
        {
          id: 'b',
          username: 'notverified',
          fullName: 'Another Creator',
          followersCount: 18,
          verified: 'true',
        },
      ],
      'instagram-profiles',
    ),
  );
  assert.equal(creators.items[0]!.fullName, 'Real Creator');
  assert.equal(creators.items[0]!.verified, true);
  assert.equal(creators.items[1]!.verified, false);
  const rows = renderResearchReport(creators);
  assert.match(rows, /Real Creator · 23.4K followers/);
  assert.equal((rows.match(/aria-label="Verified account"/g) || []).length, 1);
  assert.equal((rows.match(/class="ig-creator-row"/g) || []).length, 2);
  assert.match(rows, /width:50px;height:50px/);
  assert.ok(!rows.includes('<h1>'));
  assert.ok(!rows.includes('Collection outcomes'));
});
test('avatar failures, including already completed failures, become initials without breaking cover or account layout', () => {
  const report = normalizeResearchReport(
    input([{ id: 'a', username: 'realcreator' }], 'instagram-profiles'),
  );
  const script = renderResearchReport(report).match(
    /<script>([\s\S]*?)<\/script>/,
  )![1]!;
  const errorScript = script.slice(
    script.indexOf('function unavailableMedia'),
    script.indexOf('let activePreview'),
  );
  function image(classes: string[], complete: boolean) {
    return {
      className: classes.join(' '),
      classList: { contains: (v: string) => classes.includes(v) },
      tagName: 'IMG',
      complete,
      naturalWidth: 0,
      dataset: { initial: 'R' } as Record<string, string>,
      hidden: false,
      events: {} as Record<string, () => void>,
      replacement: null as any,
      note: null as any,
      addEventListener(type: string, fn: () => void) {
        this.events[type] = fn;
      },
      replaceWith(node: any) {
        this.replacement = node;
      },
      after(node: any) {
        this.note = node;
      },
    };
  }
  const cached = image(['ig-creator-avatar'], true),
    later = image(['tk-author-avatar'], false),
    cover = image(['tk-cover'], true);
  let created = 0;
  const document = {
    querySelectorAll: () => [cached, later, cover],
    createElement: () => {
      created++;
      return {
        className: '',
        textContent: '',
        attributes: {} as Record<string, string>,
        setAttribute(key: string, value: string) {
          this.attributes[key] = value;
        },
      };
    },
  };
  runInNewContext(errorScript, { document });
  assert.equal(cached.replacement.textContent, 'R');
  assert.equal(
    cached.replacement.attributes['aria-label'],
    'Profile image unavailable',
  );
  assert.equal(cover.hidden, true);
  assert.equal(cover.note.textContent, 'Preview unavailable');
  assert.equal(later.replacement, null);
  later.events.error!();
  assert.equal(later.replacement.textContent, 'R');
  const count = created;
  cached.events.error!();
  assert.equal(
    created,
    count,
    'cached and subsequent errors must not duplicate placeholders',
  );
  assert.equal(
    later.note,
    null,
    'avatar row must not receive a large error paragraph',
  );
});

test('grid starts with sound, respects volume changes and removes listeners when stopped', () => {
  const f = fixture(true),
    media = f.media!;
  for (let i = 0; i < 5; i++) {
    f.node.emit('mouseenter');
    assert.equal(media.muted, false);
    media.muted = true;
    media.emit('volumechange');
    assert.equal(media.muted, true);
    f.node.emit('mouseleave');
    for (const name of ['playing', 'error', 'volumechange'])
      assert.equal(media.events[name]?.length || 0, 0);
  }
});
test('slideshow flags show a stack icon without treating a photo or post page as video media', () => {
  const row = {
    ...video(),
    isSlideshow: true,
    webVideoUrl: 'https://www.tiktok.com/@coffee/photo/123',
  };
  const report = normalizeResearchReport(input([row]));
  assert.equal(report.items[0]!.mediaFormat, 'slideshow');
  assert.equal(tiktokEmbedUrl(report.items[0]!), '');
  const html = renderResearchReport(report);
  assert.match(html, /class="tk-slideshow-icon"/);
  assert.ok(!html.includes('<button class="tk-volume-toggle"'));
  assert.ok(!html.includes('<video'));
  const plain = renderResearchReport(
    normalizeResearchReport(input([{ ...video(), isSlideshow: false }])),
  );
  assert.ok(!plain.includes('<svg class="tk-slideshow-icon"'));
  const notMedia = normalizeResearchReport(
    input([
      { ...video(), videoUrl: 'https://www.tiktok.com/@coffee/video/123' },
    ]),
  ).items[0]!;
  assert.equal(notMedia.video, '');
  assert.ok(tiktokEmbedUrl(notMedia));
});

test('TikTok Accounts show real display name, handle, followers and likes with an in-page representative work', () => {
  const report = normalizeResearchReport([
    ...input(
      [
        {
          authorMeta: {
            id: 'a1',
            name: 'coffee',
            nickName: 'Coffee Maker',
            fans: 12500,
            heart: 52000,
            verified: true,
            avatar: 'https://example.test/a.jpg',
          },
          webVideoUrl: 'https://www.tiktok.com/@coffee/video/123',
        },
      ],
      'tiktok-profiles',
    ),
    ...input([video()]).map((row) => ({ ...row, name: 'videos.json' })),
  ]);
  const html = renderResearchReport(report);
  assert.match(html, /class="tk-account-row"/);
  assert.match(html, /Coffee Maker/);
  assert.match(html, /12\.5K followers · 52K likes/);
  assert.match(html, /data-open-detail="tiktok:content:123"/);
  assert.match(html, /aria-label="Verified account"/);
  assert.ok(!html.includes('tk-volume-toggle'));
});
test('comment parents and author avatars come from explicit fields or actual nesting, never post authors', () => {
  const rows = normalizeResearchReport(
    input(
      [
        {
          cid: 'r1',
          repliesToId: 'p1',
          text: 'reply',
          avatarThumbnail: 'https://example.test/comment.jpg',
          authorMeta: { avatar: 'https://example.test/post.jpg' },
        },
        { cid: 'p1', repliesToId: '0', text: 'parent' },
      ],
      'tiktok-comments',
    ),
  ).items;
  assert.equal(
    rows.find((row) => row.id === 'tiktok:comment:r1')!.authorAvatar,
    'https://example.test/comment.jpg',
  );
  assert.equal(
    rows.find((row) => row.id === 'tiktok:comment:r1')!.parentCommentId,
    'p1',
  );
  assert.equal(
    rows.find((row) => row.id === 'tiktok:comment:p1')!.parentCommentId,
    '',
  );
  const html = renderResearchReport(
    normalizeResearchReport(
      input([{ cid: 'r1', text: 'text' }], 'tiktok-comments'),
    ),
  );
  assert.match(
    html,
    /class="comment-row" data-open-detail="tiktok:comment:r1"/,
  );
  assert.ok(!html.includes('<div class="preview'));
});

test('hover status remains inside the fixed-ratio cover without adding a grid row or loading text', () => {
  const html = renderResearchReport(normalizeResearchReport(input([video()])));
  assert.match(
    html,
    /class="tk-preview"[^>]*>[\s\S]*?<span class="tk-preview-status" role="status"><\/span>[\s\S]*?<\/div>\s*<p class="tk-caption"/,
  );
  assert.ok(!html.includes('<p class="tk-preview-status"'));
  assert.match(
    html,
    /\.tk-preview-status\{position:absolute;[^}]*pointer-events:none/,
  );
  assert.match(html, /\.tk-preview-status:empty\{display:none\}/);
  assert.ok(!html.includes('Loading muted preview'));
  const f = fixture();
  f.node.emit('mouseenter');
  assert.equal(f.status.textContent, '');
  f.frames[0]!.emit('error');
  assert.match(f.status.textContent, /unavailable/);
  f.node.emit('mouseleave');
  assert.equal(
    f.status.textContent,
    '',
    'failed preview status must clear even after its player state was removed',
  );
});

test('browser audible autoplay denial offers detail without claiming media failure', () => {
  const f = fixture();
  f.node.emit('mouseenter');
  const frame = f.frames[0]!;
  f.windowEvents.message!({origin:'https://www.tiktok.com', source:frame.contentWindow,
    data:{'x-tiktok-player':true, type:'onPlayerError', value:{errorCode:3002}}});
  assert.equal(frame.removed, true);
  assert.equal(f.status.textContent, 'Click to play with sound.');
  f.node.emit('mouseleave');
  assert.equal(f.status.textContent, '');
});
