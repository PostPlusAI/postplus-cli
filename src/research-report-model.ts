/** Local report projection. Collection JSON remains the evidence source. */
export type Row = Record<string, unknown>;
export const object = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const string = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : '';
const number = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
export function safeUrl(v: unknown): string {
  if (!v) return '';
  const u = new URL(string(v));
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Report URLs must use HTTP(S) without credentials.');
  return u.href;
}
export type ResearchItem = {
  id: string;
  platform: 'instagram' | 'tiktok';
  kind: 'content' | 'creator' | 'comment' | 'discovery';
  url: string;
  author: string;
  authorAvatar: string;
  fullName: string;
  verified: boolean;
  type: string;
  productType: string;
  mediaFormat:
    | 'image'
    | 'video'
    | 'reel'
    | 'carousel'
    | 'slideshow'
    | 'unknown';
  tags: string[];
  text: string;
  date: string;
  image: string;
  video: string;
  images: string[];
  availability: string;
  metrics: Record<string, number>;
  sources: string[];
  sourcePaths: { source: string; path: string }[];
  parentUrl: string;
  parentCommentId: string;
  representativeUrl: string;
  observedAt: string;
};
export type ReportInput = { name: string; payload: unknown };
export type ResearchSource = {
  name: string;
  route: string;
  status: string;
  count: number | null;
  input: Row;
  error: string;
  observedAt: string;
  finalizedCredits?: number;
  operationId: string;
};
export type ResearchReport = {
  items: ResearchItem[];
  sources: ResearchSource[];
  returned: number;
  duplicates: number;
};
const routes = new Set([
  'instagram-posts',
  'instagram-hashtags',
  'instagram-profiles',
  'instagram-search',
  'instagram-comments',
  'tiktok-videos',
  'tiktok-related-videos',
  'tiktok-profiles',
  'tiktok-users',
  'tiktok-comments',
]);
function first(...values: unknown[]) {
  return values.map(string).find(Boolean) || '';
}
function canonical(value: unknown): string {
  const valueUrl = safeUrl(value);
  if (!valueUrl) return '';
  const u = new URL(valueUrl);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}
function profileUrl(platform: string, handle: string) {
  return handle
    ? `https://www.${platform === 'instagram' ? 'instagram.com/' : 'tiktok.com/@'}${encodeURIComponent(handle.replace(/^@/, ''))}`
    : '';
}
function project(
  route: string,
  value: unknown,
  source: string,
  input: Row,
): ResearchItem {
  const row = object(value),
    platform = route.startsWith('instagram') ? 'instagram' : 'tiktok';
  const authorMeta = object(row.authorMeta),
    user = object(row.user),
    owner = object(row.owner),
    videoMeta = object(row.videoMeta);
  const profileRoute = route.endsWith('-profiles') || route === 'tiktok-users';
  const searchProfile = route === 'instagram-search' && Boolean(row.username);
  const kind: ResearchItem['kind'] = route.endsWith('-comments')
    ? 'comment'
    : profileRoute || searchProfile
      ? 'creator'
      : route === 'instagram-search' && !row.shortCode && !row.caption
        ? 'discovery'
        : 'content';
  const author =
    kind === 'comment'
      ? first(
          row.ownerUsername,
          row.uniqueId,
          user.uniqueId,
          row.username,
          row.authorUsername,
          owner.username,
        )
      : first(
          platform === 'instagram' ? row.ownerUsername : authorMeta.name,
          row.username,
          row.authorUsername,
          authorMeta.uniqueId,
          user.uniqueId,
          row.uniqueId,
        );
  const sourceUrls = array(input.urls || input.postURLs || input.directUrls);
  let url = first(row.webVideoUrl, row.url, row.videoWebUrl, row.inputUrl);
  if (kind === 'creator')
    url = first(
      authorMeta.profileUrl,
      row.profileUrl,
      profileUrl(platform, author),
      row.url,
      row.inputUrl,
    );
  if (!url && platform === 'instagram' && row.shortCode)
    url = `https://www.instagram.com/p/${encodeURIComponent(string(row.shortCode))}/`;
  const parentUrl =
    kind === 'comment'
      ? safeUrl(
          first(
            row.videoWebUrl,
            row.postUrl,
            row.postURL,
            sourceUrls.length === 1 ? sourceUrls[0] : '',
          ),
        )
      : '';
  const nativeId =
    kind === 'creator'
      ? first(
          authorMeta.id,
          row.userId,
          row.pk,
          platform === 'instagram' ? row.id : '',
          author.toLowerCase(),
        )
      : kind === 'comment'
        ? first(row.cid, row.id, row.pk)
        : first(row.id, row.pk, row.shortCode);
  const identity =
    nativeId ||
    (kind !== 'comment' ? canonical(url) : '') ||
    (kind === 'discovery' ? first(row.name, row.hashtag) : '');
  if (!identity)
    throw new Error(
      `Missing stable ${platform} ${kind} identity in ${source}.`,
    );
  const id = `${platform}:${kind}:${identity}`;
  const images = array(row.images)
    .map((v) => safeUrl(typeof v === 'string' ? v : object(v).url))
    .filter(Boolean);
  for (const child of array(row.childPosts)) {
    const image = safeUrl(object(child).displayUrl);
    if (image) images.push(image);
  }
  const authorAvatar = safeUrl(
    kind === 'comment'
      ? first(
          row.avatarThumbnail,
          row.ownerProfilePicUrl,
          owner.profile_pic_url,
          user.avatarThumb,
          user.avatarLarger,
        )
      : first(
          authorMeta.avatar,
          authorMeta.originalAvatarUrl,
          authorMeta.avatarLarger,
          row.profilePicUrlHD,
          row.profilePicUrl,
        ),
  );
  const image =
    kind === 'creator'
      ? authorAvatar
      : safeUrl(
          first(
            row.displayUrl,
            row.imageUrl,
            videoMeta.coverUrl,
            videoMeta.originalCoverUrl,
            row.coverUrl,
          ),
        );
  const returnedVideo = safeUrl(
    first(row.videoUrl, videoMeta.downloadAddr, videoMeta.playAddr),
  );
  const videoPage = returnedVideo ? new URL(returnedVideo) : null;
  const video =
    videoPage &&
    ((videoPage.hostname.endsWith('tiktok.com') &&
      (/^\/@/.test(videoPage.pathname) ||
        /^\/player\//.test(videoPage.pathname))) ||
      (videoPage.hostname.endsWith('instagram.com') &&
        /^\/(p|reel|reels)\//.test(videoPage.pathname)))
      ? ''
      : returnedVideo;
  const tags = [
    ...new Set(
      array(row.hashtags)
        .map((tag) => first(typeof tag === 'string' ? tag : object(tag).name))
        .map((tag) => tag.replace(/^#/, '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const metrics: Record<string, number> = {};
  const metricFields: Record<string, unknown> =
    kind === 'creator'
      ? {
          followers: firstNumber(
            row.followersCount,
            row.fans,
            authorMeta.fans,
            user.followerCount,
          ),
          posts: firstNumber(row.postsCount, authorMeta.video),
          likes: firstNumber(authorMeta.heart, row.heart),
        }
      : {
          likes: firstNumber(row.likesCount, row.diggCount),
          comments: firstNumber(row.commentsCount, row.commentCount),
          views: firstNumber(
            row.videoViewCount,
            row.videoPlayCount,
            row.playCount,
          ),
          shares: row.shareCount,
        };
  for (const [key, v] of Object.entries(metricFields)) {
    const n = number(v);
    if (n !== undefined) metrics[key] = n;
  }
  const text =
    kind === 'creator'
      ? first(row.biography, authorMeta.signature, row.signature, row.bio)
      : first(row.caption, row.text, row.name, row.hashtag);
  return {
    id,
    platform,
    kind,
    url: safeUrl(url),
    author,
    authorAvatar,
    fullName:
      kind === 'comment'
        ? first(row.fullName, row.nickname, user.nickname, owner.full_name)
        : first(row.fullName, authorMeta.nickName, row.nickname),
    verified:
      row.verified === true ||
      (kind === 'comment'
        ? user.verified === true || owner.is_verified === true
        : authorMeta.verified === true),
    type: string(row.type),
    productType: string(row.productType),
    mediaFormat:
      platform === 'tiktok' && row.isSlideshow === true
        ? 'slideshow'
        : row.productType === 'clips'
          ? 'reel'
          : row.productType === 'carousel_container' ||
              ['Sidecar', 'Carousel'].includes(string(row.type))
            ? 'carousel'
            : row.type === 'Video'
              ? 'video'
              : row.type === 'Image'
                ? 'image'
                : 'unknown',
    tags,
    text,
    date: first(row.timestamp, row.createTimeISO, row.createTime),
    image,
    video,
    images: [...new Set(images)],
    availability: first(row.errorDescription, row.error),
    metrics,
    sources: [source],
    sourcePaths: [],
    parentUrl,
    parentCommentId:
      first(row.repliesToId, row.parentCommentId, row.parent_comment_id) === '0'
        ? ''
        : first(row.repliesToId, row.parentCommentId, row.parent_comment_id),
    representativeUrl:
      kind === 'creator'
        ? safeUrl(first(row.webVideoUrl, row.videoWebUrl))
        : '',
    observedAt: '',
  };
}
function firstNumber(...values: unknown[]) {
  return values.find((v) => number(v) !== undefined);
}
export function normalizeResearchReport(inputs: ReportInput[]): ResearchReport {
  const items = new Map<string, ResearchItem>(),
    sources: ResearchSource[] = [];
  let returned = 0,
    duplicates = 0;
  const names = new Set<string>();
  for (const { name, payload } of inputs) {
    if (names.has(name)) throw new Error(`Duplicate input identity: ${name}`);
    names.add(name);
    const envelope = object(payload),
      route = string(envelope.routeKey),
      status = string(envelope.status);
    // HTTP errors written by the CLI are typed error-only envelopes, not runs.
    const bareError = object(envelope.error);
    if (
      !route &&
      !status &&
      Object.keys(envelope).length === 1 &&
      /^postplus_[a-z0-9_]+$/.test(string(bareError.code)) &&
      typeof bareError.message === 'string' &&
      bareError.message.trim()
    ) {
      sources.push({
        name,
        route: 'unknown route',
        status: 'failed',
        count: null,
        input: {},
        error: `${string(bareError.code)}: ${bareError.message}`,
        observedAt: '',
        operationId: string(bareError.operationId),
      });
      continue;
    }
    if (!routes.has(route))
      throw new Error(
        `Unsupported research report route in ${name}: ${route || '(missing)'}`,
      );
    if (
      ![
        'completed',
        'failed',
        'pending',
        'running',
        'submitted',
        'cancelled',
        'canceled',
        'processing',
      ].includes(status)
    )
      throw new Error(
        `Unknown research status in ${name}: ${status || '(missing)'}`,
      );
    const output = object(envelope.output),
      input = object(envelope.input || output.input),
      error = object(envelope.error);
    const source: ResearchSource = {
      name,
      route,
      status,
      count: null,
      input: publicSeeds(input),
      error: first(error.message, error.code, envelope.error),
      observedAt: string(output.fetchedAt),
      finalizedCredits: number(object(envelope.billing).finalizedCredits),
      operationId: string(envelope.operationId),
    };
    sources.push(source);
    if (status !== 'completed') continue;
    if (!Array.isArray(output.items))
      throw new Error(`Completed research input has no items: ${name}`);
    source.count = output.items.length;
    returned += output.items.length;
    for (const [rawIndex, raw] of output.items.entries()) {
      const row = object(raw),
        rawPath = `output.items[${rawIndex}]`;
      const records: {
        value: unknown;
        path: string;
        parentCommentId?: string;
        parentUrl?: string;
      }[] =
        route === 'instagram-search'
          ? ['users', 'hashtags', 'posts'].flatMap((field) =>
              array(row[field]).map((value, index) => ({
                value,
                path: `${rawPath}.${field}[${index}]`,
              })),
            )
          : [];
      if (!records.length) records.push({ value: raw, path: rawPath });
      if (route.endsWith('-comments')) {
        for (let i = 0; i < records.length; i++) {
          const entry = records[i]!;
          records.push(
            ...array(object(entry.value).replies).map((value, index) => ({
              value,
              path: `${entry.path}.replies[${index}]`,
              parentCommentId: first(
                object(entry.value).cid,
                object(entry.value).id,
                object(entry.value).pk,
              ),
              parentUrl: first(
                object(entry.value).videoWebUrl,
                object(entry.value).postUrl,
                object(entry.value).postURL,
                entry.parentUrl,
              ),
            })),
          );
        }
      }
      for (const {
        value: record,
        path: rawPath,
        parentCommentId,
        parentUrl,
      } of records) {
        const item = project(route, record, name, input),
          existing = items.get(item.id);
        if (item.kind === 'comment') {
          if (
            !item.parentCommentId &&
            parentCommentId &&
            parentCommentId !== '0'
          )
            item.parentCommentId = parentCommentId;
          if (!item.parentUrl && parentUrl) item.parentUrl = safeUrl(parentUrl);
        }
        item.observedAt = source.observedAt;
        item.sourcePaths = [{ source: name, path: rawPath }];
        if (existing) {
          duplicates++;
          const allSources = [...new Set([...existing.sources, name])];
          const allPaths = [
            ...existing.sourcePaths,
            ...item.sourcePaths,
          ].filter(
            (entry, index, entries) =>
              entries.findIndex(
                (other) =>
                  other.source === entry.source && other.path === entry.path,
              ) === index,
          );
          const previousTime = Date.parse(existing.observedAt),
            nextTime = Date.parse(item.observedAt);
          if (
            Number.isFinite(previousTime) &&
            Number.isFinite(nextTime) &&
            nextTime > previousTime
          ) {
            item.sources = allSources;
            item.sourcePaths = allPaths;
            items.set(item.id, item);
          } else {
            existing.sources = allSources;
            existing.sourcePaths = allPaths;
          }
        } else items.set(item.id, item);
      }
    }
  }
  return { items: [...items.values()], sources, returned, duplicates };
}

function publicSeeds(input: Row): Row {
  const result: Row = {};
  const mappings: [string, string[]][] = [
    ['queries', ['queries', 'searchQueries', 'search']],
    ['handles', ['handles', 'profiles', 'usernames']],
    ['hashtags', ['hashtags']],
    ['urls', ['urls', 'postURLs', 'directUrls']],
    [
      'limit',
      [
        'limit',
        'resultsLimit',
        'resultsPerPage',
        'commentsPerPost',
        'maxProfilesPerQuery',
        'searchLimit',
      ],
    ],
  ];
  for (const [label, keys] of mappings) {
    const key = keys.find((key) => input[key] !== undefined);
    if (key) result[label] = input[key];
  }
  return result;
}
