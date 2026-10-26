import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  RESEARCH_DETAIL_CSS,
  RESEARCH_DETAIL_SCRIPT,
  renderResearchDetail,
} from './research-report-detail.js';
import {
  type ResearchReport,
  normalizeResearchReport,
} from './research-report-model.js';

function report(
  comments?: unknown[],
  status = 'completed',
  urls = ['https://www.tiktok.com/@one/video/123'],
) {
  return normalizeResearchReport([
    {
      name: 'posts',
      payload: {
        routeKey: 'tiktok-videos',
        status: 'completed',
        output: {
          items: [
            {
              id: '123',
              webVideoUrl: 'https://www.tiktok.com/@one/video/123',
              text: '</script><script>alert(1)</script>',
              authorMeta: { name: 'one' },
            },
            {
              id: '124',
              webVideoUrl: 'https://www.tiktok.com/@one/video/124',
              videoUrl: 'https://example.test/video.mp4',
              authorMeta: { name: 'one' },
            },
          ],
        },
      },
    },
    ...(comments !== undefined
      ? [
          {
            name: 'comments',
            payload: {
              routeKey: 'tiktok-comments',
              status,
              output: { input: { postURLs: urls }, items: comments },
            },
          },
        ]
      : []),
  ]);
}
function payload(r: ResearchReport) {
  return JSON.parse(
    /id="research-detail-data">([\s\S]*)<\/script>/.exec(
      renderResearchDetail(r),
    )![1]!,
  );
}
test('safe JSON, post identity grouping, real reply IDs and native-controls embed', () => {
  const r = report([
    {
      cid: 'top',
      videoWebUrl: 'https://www.tiktok.com/@one/video/123/?q=x#hash',
      text: 'parent',
    },
    { cid: 'reply', text: 'child', repliesToId: 'top' },
  ]);
  assert.ok(!renderResearchDetail(r).includes('</script><script>alert'));
  const p = payload(r).posts;
  assert.equal(p[0].comments.length, 2);
  assert.equal(p[0].comments[1].parentCommentId, 'top');
  assert.equal(p[1].comments.length, 0);
  assert.equal(p[1].commentsState, 'not-collected');
  assert.match(p[0].embed, /player\/v1\/123\?autoplay=1&muted=0/);
  assert.equal(p[1].embed, '');
});
test('uncollected, completed empty, failed and processing comments remain distinct', () => {
  assert.equal(payload(report()).posts[0].commentsState, 'not-collected');
  assert.equal(payload(report([])).posts[0].commentsState, 'empty');
  assert.equal(payload(report([], 'failed')).posts[0].commentsState, 'failed');
  assert.equal(
    payload(report([], 'processing')).posts[0].commentsState,
    'pending',
  );
  assert.equal(
    payload(report([], 'completed', ['https://www.tiktok.com/@one/video/124']))
      .posts[0].commentsState,
    'not-collected',
  );
});
test('Instagram only renders real carousel images and no reply for null replies', () => {
  const r = normalizeResearchReport([
    {
      name: 'post',
      payload: {
        routeKey: 'instagram-posts',
        status: 'completed',
        output: {
          items: [
            {
              id: 'post',
              url: 'https://www.instagram.com/p/abc/',
              type: 'Sidecar',
              displayUrl: 'https://example.test/a.jpg',
              childPosts: [
                { displayUrl: 'https://example.test/a.jpg' },
                { displayUrl: 'https://example.test/b.jpg' },
              ],
            },
          ],
        },
      },
    },
    {
      name: 'comments',
      payload: {
        routeKey: 'instagram-comments',
        status: 'completed',
        output: {
          input: { directUrls: ['https://www.instagram.com/p/abc/'] },
          items: [{ id: 'top', text: 'real', replies: null }],
        },
      },
    },
  ]);
  const p = payload(r).posts[0];
  assert.equal(p.comments.length, 1);
  assert.equal(p.comments[0].parentCommentId, '');
  assert.equal(p.images.length, 2);
  assert.equal(p.embed, '');
});
test('detail script safely skips legacy mock DOM without dialog', () => {
  vm.runInNewContext(RESEARCH_DETAIL_SCRIPT, {
    document: { getElementById: () => null },
  });
});
class Element {
  tagName: string;
  children: Element[] = [];
  listeners = new Map<string, Function[]>();
  attrs = new Map();
  className = '';
  textContent = '';
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  open = false;
  isConnected = true;
  parent: Element | null = null;
  src = '';
  href = '';
  value = '';
  readOnly = false;
  selected = false;
  muted = true;
  volume = 1;
  playCalls = 0;
  pauseCalls = 0;
  focusCalls = 0;
  contentWindow = {
    messages: [] as any[],
    postMessage: (message: unknown, origin: string) =>
      this.contentWindow.messages.push({ message, origin }),
  };
  classList = { add: () => {}, remove: () => {} };
  constructor(tag = 'div') {
    this.tagName = tag;
  }
  addEventListener(name: string, fn: Function) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), fn]);
  }
  emit(name: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(name) || [])
      fn({ target: this, preventDefault() {}, ...event });
  }
  append(...nodes: Element[]) {
    nodes.forEach((node) => {
      node.parent = this;
      this.children.push(node);
    });
  }
  replaceChildren(...nodes: Element[]) {
    this.children.forEach((x) => (x.parent = null));
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
    if (k === 'src') this.src = '';
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {
    this.focusCalls++;
  }
  select() {
    this.selected = true;
  }
  load() {}
  pause() {
    this.pauseCalls++;
  }
  play() {
    this.playCalls++;
    this.emit('playing');
    return Promise.resolve();
  }
  getBoundingClientRect() {
    return { left: 0, right: 100, top: 0, bottom: 100 };
  }
}
function browser(
  r: ResearchReport,
  writeText?: (value: string) => Promise<void>,
  playOverride?: () => Promise<void>,
) {
  const ids = new Map(
    [
      'research-detail',
      'research-detail-data',
      'rd-media',
      'rd-comments',
      'rd-sound',
      'rd-player-status',
      'rd-title',
      'rd-original',
      'rd-prev',
      'rd-next',
      'rd-close',
      'rd-caption',
    ].map((id) => [id, new Element()]),
  );
  ids.get('research-detail-data')!.textContent = JSON.stringify(payload(r));
  const trigger = new Element('button'),
    document: any = new Element(),
    window: any = new Element();
  const events: string[] = [];
  document.getElementById = (id: string) => ids.get(id);
  document.createElement = (tag: string) => {
    const node = new Element(tag);
    if (tag === 'video' && playOverride)
      node.play = () => {
        node.playCalls++;
        return playOverride();
      };
    return node;
  };
  document.activeElement = trigger;
  document.body = new Element();
  document.dispatchEvent = (e: any) => {
    events.push(e.type);
    document.emit(e.type, e);
  };
  const timers = new Map<number, Function>();
  let n = 0;
  vm.runInNewContext(RESEARCH_DETAIL_SCRIPT, {
    document,
    window,
    navigator: writeText ? { clipboard: { writeText } } : undefined,
    CustomEvent: class {
      constructor(
        public type: string,
        public detail?: unknown,
      ) {}
    },
    setTimeout: (fn: Function) => {
      timers.set(++n, fn);
      return n;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { ids, trigger, window, events, timers };
}
test('opening attempts native autoplay, right-side navigation cleans the single player, Escape restores focus', () => {
  const b = browser(report());
  b.window.openResearchDetail('tiktok:content:123');
  assert.equal(b.events[0], 'research-detail-open');
  const frame = b.ids.get('rd-media')!.children[0]!;
  assert.equal(frame.tagName, 'iframe');
  assert.match(frame.src, /autoplay=1&muted=0&controls=1/);
  assert.equal(frame.contentWindow.messages.length, 0);
  const message = (origin: string, source: unknown, type: string) =>
    b.window.emit('message', {
      origin,
      source,
      data: { 'x-tiktok-player': true, type },
    });
  message('https://www.tiktok.com', frame.contentWindow, 'onPlayerReady');
  assert.equal(frame.contentWindow.messages.length, 0);
  assert.equal(b.ids.get('rd-media')!.children.length, 1);
  message('https://evil.test', frame.contentWindow, 'onPlayerError');
  message('https://www.tiktok.com', {}, 'onPlayerError');
  assert.equal(b.ids.get('rd-media')!.children.length, 1);
  b.ids.get('rd-next')!.emit('click');
  const video = b.ids.get('rd-media')!.children[0]!;
  assert.equal(video.tagName, 'video');
  assert.equal((video as any).controls, true);
  assert.equal(video.playCalls, 1);
  assert.equal(frame.parent, null);
  assert.equal(frame.contentWindow.messages.at(-1).message.type, 'pause');
  // Native controls remain usable after the initial play attempt.
  video.play();
  assert.equal(video.playCalls, 2);
  b.ids.get('research-detail')!.emit('cancel');
  assert.equal(video.pauseCalls, 1);
  assert.equal(video.src, '');
  assert.equal(b.ids.get('research-detail')!.open, false);
  assert.equal(b.trigger.focusCalls, 1);
  assert.equal(b.events.at(-1), 'research-detail-close');
  assert.equal(b.timers.size, 0);
});
test('native player errors alone add a short media message; no custom sound or readiness toolbar', () => {
  const r = report(),
    html = renderResearchDetail(r);
  assert.ok(!html.includes('rd-sound'));
  assert.ok(!html.includes('rd-media-tools'));
  assert.ok(!html.includes('rd-player-status'));
  assert.ok(html.includes('rd-post-nav'));
  assert.ok(!RESEARCH_DETAIL_SCRIPT.includes('setTimeout'));
  assert.ok(!RESEARCH_DETAIL_SCRIPT.includes('did not confirm'));
  const b = browser(r);
  b.window.openResearchDetail('tiktok:content:123');
  const frame = b.ids.get('rd-media')!.children[0]!;
  b.window.emit('message', {
    origin: 'https://www.tiktok.com',
    source: frame.contentWindow,
    data: { 'x-tiktok-player': true, type: 'onPlayerError' },
  });
  assert.equal(b.ids.get('rd-media')!.children.length, 2);
  assert.match(
    b.ids.get('rd-media')!.children[1]!.textContent,
    /Player reported an error/,
  );
});

test('only real reply relationships produce expandable threads', () => {
  const b = browser(
    report([
      { cid: 'top', text: 'parent' },
      { cid: 'reply', text: 'child', repliesToId: 'top' },
    ]),
  );
  b.window.openResearchDetail('tiktok:content:123');
  assert.equal(b.ids.get('rd-comments')!.children.length, 1);
  assert.equal(
    b.ids
      .get('rd-comments')!
      .children[0]!.children.filter((x) => x.tagName === 'details').length,
    1,
  );
  const none = browser(report([{ cid: 'top', text: 'no reply' }]));
  none.window.openResearchDetail('tiktok:content:123');
  assert.equal(
    none.ids
      .get('rd-comments')!
      .children[0]!.children.filter((x) => x.tagName === 'details').length,
    0,
  );
});

test('native post identity matches renamed TikTok handles and Instagram p/reel aliases, never another post', () => {
  const tk = report(
    [
      {
        cid: 'one',
        videoWebUrl: 'https://www.tiktok.com/@renamed/video/123',
        text: 'same post',
      },
    ],
    'completed',
    ['https://www.tiktok.com/@newname/photo/123'],
  );
  assert.equal(payload(tk).posts[0].comments.length, 1);
  assert.equal(payload(tk).posts[1].comments.length, 0);
  const ig = normalizeResearchReport([
    {
      name: 'post',
      payload: {
        routeKey: 'instagram-posts',
        status: 'completed',
        output: {
          items: [{ id: 'ig', url: 'https://www.instagram.com/p/abc/' }],
        },
      },
    },
    {
      name: 'comments',
      payload: {
        routeKey: 'instagram-comments',
        status: 'completed',
        output: {
          input: {
            directUrls: ['https://www.instagram.com/reel/abc/?tracking=1'],
          },
          items: [],
        },
      },
    },
  ]);
  assert.equal(payload(ig).posts[0].commentsState, 'empty');
});
test('orphan replies are retained and clearly identify their missing parent', () => {
  const b = browser(
    report([
      { cid: 'orphan', text: 'real reply', repliesToId: 'not-collected' },
    ]),
  );
  b.window.openResearchDetail('tiktok:content:123');
  const rows = b.ids.get('rd-comments')!.children;
  assert.equal(rows.length, 1);
  assert.ok(
    rows[0]!.children.some((x) =>
      x.textContent.includes('parent comment was not collected'),
    ),
  );
});

test('comment IDs open their exact post detail, with honest empty media when the post was not collected', () => {
  const r = normalizeResearchReport([
    {
      name: 'comments',
      payload: {
        routeKey: 'tiktok-comments',
        status: 'completed',
        output: {
          input: { postURLs: ['https://www.tiktok.com/@actual/video/999'] },
          items: [{ cid: 'only', text: 'comment', uniqueId: 'commenter' }],
        },
      },
    },
  ]);
  const p = payload(r).posts[0];
  assert.equal(p.author, '');
  assert.equal(p.video, '');
  assert.equal(p.image, '');
  assert.equal(p.embed, '');
  assert.equal(p.mediaCollected, false);
  assert.equal(p.url, 'https://www.tiktok.com/@actual/video/999');
  const b = browser(r);
  b.window.openResearchDetail('tiktok:comment:only');
  assert.equal(b.ids.get('research-detail')!.open, true);
  assert.ok(
    b.ids.get('rd-media')!.children[0]!.textContent.includes('not collected'),
  );
  assert.equal(b.ids.get('rd-comments')!.children.length, 1);
  const existing = browser(report([{ cid: 'one', text: 'comment' }]));
  existing.window.openResearchDetail('tiktok:comment:one');
  assert.equal(existing.ids.get('rd-media')!.children[0]!.tagName, 'iframe');
});

test('completed multi-URL collections do not invent zero platform comments and later failures retain real evidence', () => {
  const multi = report(
    [
      {
        cid: 'other',
        videoWebUrl: 'https://www.tiktok.com/@one/video/124',
        text: 'other post',
      },
    ],
    'completed',
    [
      'https://www.tiktok.com/@one/video/123',
      'https://www.tiktok.com/@one/video/124',
    ],
  );
  assert.equal(payload(multi).posts[0].commentsState, 'empty');
  assert.equal(payload(multi).posts[1].comments.length, 1);
  const good = report([{ cid: 'known', text: 'real existing evidence' }]);
  good.sources.push({
    name: 'later',
    route: 'tiktok-comments',
    status: 'failed',
    count: null,
    input: { urls: ['https://www.tiktok.com/@one/video/123'] },
    error: 'request failed',
    observedAt: '',
    operationId: 'later',
  });
  const p = payload(good).posts[0];
  assert.equal(p.comments.length, 1);
  assert.equal(p.commentsState, 'collected');
  assert.match(p.collectionNote, /failed/);
});

test('comment outcome matching accepts exact hosted provider URL fields and safe empty values', () => {
  const tk = report();
  tk.sources.push({
    name: 'provider raw',
    route: 'tiktok-comments',
    status: 'completed',
    count: 0,
    input: { postURLs: ['', 'https://www.tiktok.com/@renamed/video/123'] },
    error: '',
    observedAt: '',
    operationId: 'empty',
  });
  assert.equal(payload(tk).posts[0].commentsState, 'empty');
  const ig = normalizeResearchReport([
    {
      name: 'post',
      payload: {
        routeKey: 'instagram-posts',
        status: 'completed',
        output: {
          items: [{ id: 'ig', url: 'https://www.instagram.com/p/abc/' }],
        },
      },
    },
  ]);
  ig.sources.push({
    name: 'provider raw',
    route: 'instagram-comments',
    status: 'failed',
    count: null,
    input: { directUrls: ['https://www.instagram.com/reel/abc/'] },
    error: 'failed',
    observedAt: '',
    operationId: 'failed',
  });
  assert.equal(payload(ig).posts[0].commentsState, 'failed');
});

test('navigation circles share identical chevron geometry and reset default button padding', () => {
  const html = renderResearchDetail(report());
  const prev = /id="rd-prev"[\s\S]*?<path d="([^"]+)"/.exec(html)![1];
  const next = /id="rd-next"[\s\S]*?<path d="([^"]+)"/.exec(html)![1];
  assert.equal(prev, next);
  assert.match(
    RESEARCH_DETAIL_CSS,
    /#rd-prev svg\{transform:rotate\(180deg\)\}/,
  );
  assert.match(RESEARCH_DETAIL_CSS, /width:40px;height:40px/);
  assert.match(
    RESEARCH_DETAIL_CSS,
    /padding:0;margin:0;line-height:0;appearance:none;transform:none/,
  );
  assert.match(RESEARCH_DETAIL_CSS, /align-items:center;gap:12px/);
});

test('uncollected comments offer a source-bound shell-safe request, while empty and failed results do not', () => {
  const r = report();
  r.items[0]!.url = "https://www.tiktok.com/@one's/video/123";
  const request = payload(r).posts[0].collectionRequest;
  assert.ok(
    request.includes(
      String.raw`--url 'https://www.tiktok.com/@one'\''s/video/123'`,
    ),
  );
  assert.match(
    request,
    /--limit 100 --include-replies true --wait --output 'comments-123.json'/,
  );
  assert.match(request, /Original source batches for this report:[\s\S]*posts/);
  assert.match(request, /regenerate this same research report/);
  assert.equal(payload(report([])).posts[0].collectionRequest, '');
  assert.equal(payload(report([], 'failed')).posts[0].collectionRequest, '');
  const b = browser(r);
  b.window.openResearchDetail('tiktok:content:123');
  assert.ok(
    b.ids
      .get('rd-comments')!
      .children.some(
        (x) => x.textContent === 'Want to collect comments for this post?',
      ),
  );
  assert.ok(
    b.ids
      .get('rd-comments')!
      .children.some(
        (x) =>
          x.tagName === 'button' && x.textContent === 'Copy collection request',
      ),
  );
});
test('clipboard failure reveals selectable request text and never announces collection or copy success', () => {
  const b = browser(report());
  b.window.openResearchDetail('tiktok:content:123');
  const button = b.ids
    .get('rd-comments')!
    .children.find((x) => x.tagName === 'button')!;
  button.emit('click');
  const manual = b.ids
    .get('rd-comments')!
    .children.find((x) => x.tagName === 'textarea')!;
  assert.ok(manual);
  assert.equal(manual.readOnly, true);
  assert.equal(manual.selected, true);
  assert.match(manual.value, /video\/123/);
  assert.equal(button.textContent, 'Copy collection request');
  assert.ok(
    b.ids
      .get('rd-comments')!
      .children.some((x) => x.textContent.includes('Automatic copying failed')),
  );
});
test('asynchronous clipboard requests stay bound to the clicked post after navigation', async () => {
  const copied: string[] = [];
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const b = browser(report(), async (value) => {
    copied.push(value);
    await pending;
  });
  b.window.openResearchDetail('tiktok:content:123');
  const firstButton = b.ids
    .get('rd-comments')!
    .children.find((x) => x.tagName === 'button')!;
  firstButton.emit('click');
  b.ids.get('rd-next')!.emit('click');
  finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /video\/123/);
  assert.ok(!copied[0]!.includes('video/124'));
  assert.equal(
    b.ids.get('rd-comments')!.children.find((x) => x.tagName === 'button')!
      .textContent,
    'Copy collection request',
  );
});
test('portrait media is bounded by definite grid tracks and contained absolute media frames', () => {
  // Real bijmascha post 4009915165081460646: 720x1280 display, 1080x1920 original.
  assert.match(RESEARCH_DETAIL_CSS, /\.rd-layout\{position:absolute;inset:0/);
  assert.match(RESEARCH_DETAIL_CSS, /\.rd-media\{position:absolute;inset:0/);
  assert.match(RESEARCH_DETAIL_CSS, /height:min\(880px,92dvh\)/);
  const original = { width: 1080, height: 1920 };
  const box = { width: 600, height: 760 };
  const scale = Math.min(
    box.width / original.width,
    box.height / original.height,
  );
  assert.equal(original.height * scale, box.height);
  assert.ok(original.width * scale <= box.width);
  assert.match(
    RESEARCH_DETAIL_CSS,
    /grid-template-rows:minmax\(0,1fr\);height:100%;min-height:0/,
  );
  assert.match(
    RESEARCH_DETAIL_CSS,
    /\.rd-media-pane\{[^}]*min-height:0;overflow:hidden/,
  );
  assert.match(
    RESEARCH_DETAIL_CSS,
    /\.rd-media>video,\.rd-media>iframe,\.rd-media>img\{position:absolute;inset:0;width:100%;height:100%;[^}]*object-fit:contain/,
  );
  assert.match(
    RESEARCH_DETAIL_CSS,
    /grid-template-rows:minmax\(0,52%\) minmax\(0,48%\)/,
  );
});

test('blocked native autoplay only offers Play; late promises from replaced or closed players cannot affect current detail', async () => {
  const r = report();
  const first = r.items[0]!,
    second = r.items[1]!;
  first.video = 'https://example.test/one.mp4';
  second.video = 'https://example.test/two.mp4';
  const rejects: ((reason: unknown) => void)[] = [];
  const b = browser(
    r,
    undefined,
    () => new Promise<void>((_, reject) => rejects.push(reject)),
  );
  b.window.openResearchDetail(first.id);
  const oldVideo = b.ids.get('rd-media')!.children[0]!;
  assert.equal(oldVideo.playCalls, 1);
  b.ids.get('rd-next')!.emit('click');
  const current = b.ids.get('rd-media')!.children[0]!;
  assert.equal(oldVideo.pauseCalls, 1);
  assert.equal(oldVideo.src, '');
  assert.equal(current.playCalls, 1);
  rejects[0]!(new Error('late rejected playback'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.ids.get('rd-media')!.children.length, 1);
  rejects[1]!(new Error('browser blocked playback'));
  await Promise.resolve();
  await Promise.resolve();
  const hint = b.ids.get('rd-media')!.children[1]!;
  assert.match(hint.textContent, /Press Play/);
  assert.ok(!hint.textContent.includes('unavailable'));
  current.emit('playing');
  assert.equal(hint.parent, null);
  b.window.openResearchDetail(first.id);
  b.ids.get('rd-close')!.emit('click');
  rejects[2]!(new Error('closed player rejection'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(b.ids.get('rd-media')!.children.length, 0);
  assert.equal(b.ids.get('research-detail')!.open, false);
});
