import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const skillsRepoRoot = process.env.POSTPLUS_SKILLS_REPO_DIR?.trim()
  ? resolve(process.env.POSTPLUS_SKILLS_REPO_DIR.trim())
  : resolve(repoRoot, '..', 'postplus-skills');
const cliEntry = resolve(repoRoot, 'src/index.ts');
const tsxBin = resolve(
  repoRoot,
  process.platform === 'win32' ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx',
);

async function loadReleaseManifestFromWorkspace() {
  const { stdout } = await execFileAsync(
    tsxBin,
    [
      '--eval',
      `import { loadReleaseManifest } from ${JSON.stringify(
        resolve(repoRoot, 'src/postplus-release.ts'),
      )};
      (async () => {
        const manifest = await loadReleaseManifest(${JSON.stringify(skillsRepoRoot)});
        console.log(JSON.stringify(manifest));
      })().catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      });`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  return JSON.parse(stdout);
}

async function loadReleaseSkillBundleFromWorkspace(skillId) {
  const { stdout } = await execFileAsync(
    tsxBin,
    [
      '--eval',
      `import { loadReleaseSkillBundle } from ${JSON.stringify(
        resolve(repoRoot, 'src/postplus-release.ts'),
      )};
      (async () => {
        const bundle = await loadReleaseSkillBundle({
          repoRoot: ${JSON.stringify(skillsRepoRoot)},
          skillId: ${JSON.stringify(skillId)},
        });
        console.log(JSON.stringify(bundle));
      })().catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      });`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  return JSON.parse(stdout);
}

async function loadJsonCommand({ args, cwd, env }) {
  try {
    const { stdout } = await execFileAsync(tsxBin, [cliEntry, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });

    return JSON.parse(stdout);
  } catch (error) {
    const commandError = error;
    const stdout =
      commandError &&
      typeof commandError === 'object' &&
      'stdout' in commandError &&
      typeof commandError.stdout === 'string'
        ? commandError.stdout
        : '';

    if (stdout.trim().length > 0) {
      return JSON.parse(stdout);
    }

    throw error;
  }
}

async function runNodeCommand({ scriptPath, args = [], cwd, env }) {
  const childEnv = Object.fromEntries(
    Object.entries(env ?? process.env).filter(([, value]) => value !== undefined),
  );

  return await execFileAsync('node', [scriptPath, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
}

async function runJsonNodeCommand(input) {
  const { stdout } = await runNodeCommand(input);
  return JSON.parse(stdout);
}

async function runBinaryCommand({ command, args = [], cwd, env }) {
  const childEnv = Object.fromEntries(
    Object.entries(env ?? process.env).filter(([, value]) => value !== undefined),
  );

  return await execFileAsync(command, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function assertNonEmptyFile(filePath) {
  const bytes = await readFile(filePath);
  assert.equal(bytes.length > 0, true);
}

async function createSampleVideo({ outputPath, cwd, env }) {
  await mkdir(dirname(outputPath), { recursive: true });
  await runBinaryCommand({
    command: 'ffmpeg',
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x284:rate=1:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-shortest',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      outputPath,
    ],
    cwd,
    env,
  });
  await assertNonEmptyFile(outputPath);
}

function normalizeIntegrityForPath(integrity) {
  return integrity.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveHostedBundleFilePath({
  bundle,
  configRoot,
  relativePath,
}) {
  return resolve(
    configRoot,
    'release-bundles',
    bundle.skillId,
    normalizeIntegrityForPath(bundle.integrity),
    relativePath,
  );
}

async function writeJsonArtifact(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

function normalizeTikTokMusicCandidates(raw, regionCode) {
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    itemCount: items.length,
    items: items.map((item, index) => ({
      fetchedAt: raw.fetchedAt || '2026-04-05T12:00:00.000Z',
      musicAuthor: item.musicAuthor || item.author || 'Unknown',
      musicId: item.musicId || `music-${index + 1}`,
      musicTitle: item.musicTitle || item.title || 'Unknown title',
      musicUrl: item.musicUrl || item.url || null,
      observedUseCount: item.observedUseCount || item.videoCount || null,
      platform: 'tiktok',
      rank: index + 1,
      recordType: 'musicCandidate',
      regionCode,
      sampleVideoUrls: Array.isArray(item.sampleVideoUrls) ? item.sampleVideoUrls : [],
      sourceActorId: raw.actorId,
      trendReason: item.trendReason || 'high regional reuse signal',
    })),
    regionCode,
  };
}

function buildTikTokMusicSampleRanking(dataset) {
  const items = Array.isArray(dataset.items) ? dataset.items : [];
  const ranked = [...items].sort(
    (left, right) => (right.playCount || 0) - (left.playCount || 0),
  );
  return {
    itemCount: ranked.length,
    items: ranked,
    topVideoUrls: ranked.map((item) => item.videoUrl || item.postUrl).filter(Boolean).slice(0, 5),
  };
}

function buildInstagramCampaignWatchlist(dataset) {
  const items = Array.isArray(dataset.items) ? dataset.items : [];
  const hashtagSet = new Set();
  const usernameSet = new Set();
  for (const item of items) {
    const hashtags = Array.isArray(item.hashtags)
      ? item.hashtags
      : String(item.caption || '')
          .match(/#[\p{L}\p{N}_]+/gu)
          ?.map((tag) => tag.slice(1)) || [];
    for (const tag of hashtags) hashtagSet.add(tag);
    if (item.ownerUsername) usernameSet.add(item.ownerUsername);
    if (item.username) usernameSet.add(item.username);
  }
  return {
    itemCount: items.length,
    topTaggedCreators: [...usernameSet],
    topHashtags: [...hashtagSet],
    watchlist: {
      hashtags: [...hashtagSet].slice(0, 5),
      usernames: [...usernameSet].slice(0, 5),
    },
  };
}

function summarize1688Research({ normalized, rankedProducts, rankedSuppliers }) {
  return {
    itemCount: normalized.itemCount || 0,
    nextStep: 'compare with channel demand before final selection',
    priceBandSnapshot: rankedProducts.items.map((item) => item.priceBand).filter(Boolean),
    supplierShortlistCount: rankedSuppliers.itemCount || 0,
    topSupplier:
      rankedSuppliers.items?.[0]?.shopName || rankedSuppliers.items?.[0]?.supplierName || null,
  };
}

function normalizeGoogleTrends(raw) {
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    itemCount: items.length,
    items: items.map((item, index) => ({
      interest: item.interest || item.score || 0,
      keyword: item.keyword || item.query || `trend-${index + 1}`,
      regionCode: item.regionCode || item.geo || 'US',
      sourceActorId: raw.actorId,
    })),
  };
}

async function createFakeLarkCli(binDir) {
  const scriptPath = resolve(binDir, 'lark-cli');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    scriptPath,
    [
      '#!/bin/sh',
      'cmd="$1"',
      'shift || true',
      'case "$cmd" in',
      '  --help)',
      '    echo "lark-cli help"',
      '    ;;',
      '  doctor)',
      '    echo "doctor ok"',
      '    ;;',
      '  config)',
      '    sub="$1"',
      '    if [ "$sub" = "show" ]; then',
      '      echo "loggedIn=true defaultDomain=feishu"',
      '    else',
      '      echo "config help"',
      '    fi',
      '    ;;',
      '  calendar)',
      '    echo "agenda ok"',
      '    ;;',
      '  contact)',
      '    echo "search-user ok"',
      '    ;;',
      '  api)',
      '    echo "ok path=$1"',
      '    ;;',
      '  *)',
      '    echo "unsupported" >&2',
      '    exit 1',
      '    ;;',
      'esac',
    ].join('\n'),
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function main() {
  const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-cli-config-'));
  const runtimeRoot = await mkdtemp(resolve(tmpdir(), 'postplus-cli-runtime-'));
  const skillsDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-skills-'));
  const codexSkillsDir = await mkdtemp(
    resolve(tmpdir(), 'postplus-cli-codex-skills-'),
  );
  const codexAppSkillsDir = await mkdtemp(
    resolve(tmpdir(), 'postplus-cli-codex-app-skills-'),
  );
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'postplus-workspace-'));
  const tiktokSkillIds = [
    'tiktok-research',
    'tiktok-shop-research',
  ];
  let acceptanceSkillIds = [];
  const cleanupTargets = [
    configRoot,
    runtimeRoot,
    skillsDir,
    codexSkillsDir,
    codexAppSkillsDir,
    workspaceRoot,
  ];

  let server;
  let activePort = null;

  try {
    const workspaceManifest = await loadReleaseManifestFromWorkspace();
    acceptanceSkillIds = workspaceManifest.skills.map((entry) => entry.skillId);
    const manifest = {
      ...workspaceManifest,
      skillCount: acceptanceSkillIds.length,
      skills: workspaceManifest.skills.filter((entry) =>
        acceptanceSkillIds.includes(entry.skillId),
      ),
    };
    const hostedBundlesBySkillId = new Map(
      await Promise.all(
        acceptanceSkillIds.map(async (skillId) => [
          skillId,
          await loadReleaseSkillBundleFromWorkspace(skillId),
        ]),
      ),
    );
    const providerEvents = [];
    let activeScenario = 'success';

    server = createServer((request, response) => {
      const url = request.url ?? '/';

      if (request.method === 'GET' && url === '/api/postplus-cli/release-manifest') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(manifest));
        return;
      }

      if (
        request.method === 'GET' &&
        url.startsWith('/api/postplus-cli/release-skills/')
      ) {
        const skillId = decodeURIComponent(
          url.slice('/api/postplus-cli/release-skills/'.length),
        );
        const bundle = hostedBundlesBySkillId.get(skillId);

        if (!bundle) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unknown released skill' }));
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(bundle));
        return;
      }

      if (request.method === 'GET' && url.startsWith('/xhs-assets/')) {
        const fileName = url.slice('/xhs-assets/'.length);
        const contentType = fileName.endsWith('.jpg')
          ? 'image/jpeg'
          : fileName.endsWith('.wav')
            ? 'audio/wav'
            : fileName.endsWith('.mp4')
              ? 'video/mp4'
              : 'application/octet-stream';
        const body = fileName.endsWith('.jpg')
          ? Buffer.from('xhs-image-bytes')
          : fileName.endsWith('.wav')
            ? Buffer.from('audio-bytes')
            : fileName.endsWith('.mp4')
              ? Buffer.from('video-bytes')
              : Buffer.from('asset-bytes');

        response.writeHead(200, { 'content-type': contentType });
        response.end(body);
        return;
      }

      if (request.method === 'GET' && url === '/api/postplus-cli/auth/whoami') {
        const authorization = request.headers.authorization ?? '';

        if (authorization !== 'Bearer test-access-token') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: 'invalid session',
              code: 'postplus_cli_auth_invalid_session',
            }),
          );
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify({
              accountId: 'account-1',
              sessionExpiresAt: 1_900_000_000,
              subscriptionStatus: 'active',
              userEmail: 'acceptance@example.com',
              userId: 'user-1',
          }),
        );
        return;
      }

      if (request.method === 'POST' && url === '/api/postplus-cli/auth/refresh') {
        const authorization = request.headers.authorization ?? '';
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (
            authorization !== 'Bearer test-access-token' ||
            body.refreshToken !== 'test-refresh-token'
          ) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error: 'invalid session',
                code: 'postplus_cli_auth_invalid_session',
              }),
            );
            return;
          }

          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              accessToken: 'test-access-token',
              accountId: 'account-1',
              refreshToken: 'test-refresh-token',
              sessionExpiresAt: 1_900_000_000,
              subscriptionStatus: 'active',
              userEmail: 'acceptance@example.com',
              userId: 'user-1',
            }),
          );
        });
        return;
      }

      if (request.method === 'POST' && url === '/api/postplus-cli/auth/revoke') {
        const authorization = request.headers.authorization ?? '';
        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (
            authorization !== 'Bearer test-access-token' ||
            body.refreshToken !== 'test-refresh-token'
          ) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error: 'invalid session',
                code: 'postplus_cli_auth_invalid_session',
              }),
            );
            return;
          }

          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      if (request.method === 'POST' && url === '/api/postplus-cli/hosted/apify') {
        const authorization = request.headers.authorization ?? '';

        if (authorization !== 'Bearer test-access-token') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: 'invalid session',
              code: 'postplus_cli_auth_invalid_session',
            }),
          );
          return;
        }

        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          let payload;

          if (body.actorId === 'clockworks/tiktok-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  id: 'video-1',
                  desc: 'POV you finally found a skincare device routine that sticks #skincare #beautytech',
                  authorMeta: {
                    name: 'skinlabcreator',
                    nickName: 'Skin Lab Creator',
                  },
                  commentCount: 48,
                  createTimeISO: '2026-04-04T12:00:00.000Z',
                  diggCount: 1240,
                  playCount: 18200,
                  searchKeyword: 'skincare device',
                  shareCount: 87,
                  videoDuration: 18,
                  webVideoUrl: 'https://www.tiktok.com/@skinlabcreator/video/1',
                },
                {
                  id: 'video-2',
                  desc: 'How to use LED beauty tech at home without overthinking it #skincare #ledmask',
                  authorMeta: {
                    name: 'dermcreator',
                    nickName: 'Derm Creator',
                  },
                  commentCount: 32,
                  createTimeISO: '2026-04-03T12:00:00.000Z',
                  diggCount: 980,
                  playCount: 14300,
                  searchKeyword: 'skincare device',
                  shareCount: 54,
                  videoDuration: 24,
                  webVideoUrl: 'https://www.tiktok.com/@dermcreator/video/2',
                },
              ],
            };
          } else if (body.actorId === 'apidojo/tweet-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  id: 'tweet-1',
                  favorite_count: 112,
                  reply_count: 14,
                  retweet_count: 27,
                  text: 'LED skincare routines are suddenly everywhere on my feed.',
                  url: 'https://x.com/demo/status/1',
                  view_count: 4300,
                  username: 'trendwatcher',
                },
                {
                  id: 'tweet-2',
                  favorite_count: 86,
                  quote_count: 6,
                  reply_count: 9,
                  retweet_count: 18,
                  text: 'Interesting how beauty device creators frame before/after proof.',
                  url: 'https://x.com/demo/status/2',
                  view_count: 3100,
                  username: 'creativelead',
                },
              ],
            };
          } else if (body.actorId === 'apidojo/twitter-user-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  description: 'Trend analyst tracking creator and beauty-tech content.',
                  followers_count: 18200,
                  friends_count: 910,
                  listed_count: 22,
                  location: 'New York, NY',
                  name: 'Trend Watcher',
                  screen_name: 'trendwatcher',
                  statuses_count: 3240,
                  url: 'https://x.com/trendwatcher',
                  verified: true,
                },
                {
                  description: 'Creative lead studying performance angles in creator campaigns.',
                  followers_count: 9400,
                  friends_count: 640,
                  listed_count: 9,
                  location: 'Los Angeles, CA',
                  name: 'Creative Lead',
                  screen_name: 'creativelead',
                  statuses_count: 1880,
                  url: 'https://x.com/creativelead',
                  verified: false,
                },
              ],
            };
          } else if (body.actorId === 'apify/instagram-search-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  caption:
                    'College skincare routine with a beauty device that actually fits a student budget. #studentcreator #skincare',
                  commentsCount: 26,
                  likesCount: 410,
                  ownerUsername: 'campusskincreator',
                  timestamp: '2026-04-04T12:00:00.000Z',
                  url: 'https://www.instagram.com/p/search-1/',
                  videoViewCount: 5400,
                },
                {
                  caption:
                    'How I test LED beauty tech between classes. #beautytech #studentlife',
                  commentsCount: 18,
                  likesCount: 355,
                  ownerUsername: 'beautylabstudent',
                  timestamp: '2026-04-03T12:00:00.000Z',
                  url: 'https://www.instagram.com/p/search-2/',
                  videoViewCount: 4600,
                },
              ],
            };
          } else if (body.actorId === 'apify/instagram-post-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  caption: 'Testing a new LED skincare flow this week.',
                  commentsCount: 14,
                  displayUrl: 'https://example.com/instagram-post-1.jpg',
                  likesCount: 240,
                  ownerUsername: 'skinlabcreator',
                  url: 'https://www.instagram.com/p/demo-1/',
                },
                {
                  caption: 'Short reel breakdown of a beauty-device routine.',
                  commentsCount: 9,
                  displayUrl: 'https://example.com/instagram-post-2.jpg',
                  likesCount: 180,
                  ownerUsername: 'beautyops',
                  url: 'https://www.instagram.com/p/demo-2/',
                },
              ],
            };
          } else if (body.actorId === 'apify/instagram-profile-scraper') {
            const usernames = Array.isArray(body.input?.usernames)
              ? body.input.usernames
              : [];
            const useDiscoveryProfiles = usernames.some(
              (entry) =>
                entry === 'campusskincreator' || entry === 'beautylabstudent',
            );
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: useDiscoveryProfiles
                ? [
                    {
                      biography:
                        'UGC creator helping students build simpler skincare routines. hello@campusskin.co',
                      categoryName: 'Digital creator',
                      followersCount: 15400,
                      followsCount: 640,
                      fullName: 'Campus Skin Creator',
                      id: 'ig-profile-creator-1',
                      postsCount: 210,
                      profileUrl:
                        'https://www.instagram.com/campusskincreator/',
                      username: 'campusskincreator',
                      website: 'https://campusskin.co',
                    },
                    {
                      biography:
                        'Student creator testing beauty tech, tutorials, and dorm-friendly routines.',
                      categoryName: 'Creator',
                      followersCount: 9800,
                      followsCount: 410,
                      fullName: 'Beauty Lab Student',
                      id: 'ig-profile-creator-2',
                      isVerified: true,
                      postsCount: 130,
                      profileUrl:
                        'https://www.instagram.com/beautylabstudent/',
                      username: 'beautylabstudent',
                      website: 'https://beautylab.example',
                    },
                  ]
                : [
                    {
                      biography:
                        'Testing beauty-device workflows and practical skincare systems. team@skinlab.co',
                      categoryName: 'Beauty',
                      followersCount: 22400,
                      followsCount: 520,
                      fullName: 'Skin Lab Creator',
                      id: 'ig-profile-account-1',
                      postsCount: 318,
                      profileUrl: 'https://www.instagram.com/skinlabcreator/',
                      username: 'skinlabcreator',
                      website: 'https://skinlab.co',
                    },
                    {
                      biography:
                        'Beauty ops examples, before-after proof, and small-team launch ideas.',
                      categoryName: 'Digital creator',
                      followersCount: 13100,
                      followsCount: 380,
                      fullName: 'Beauty Ops',
                      id: 'ig-profile-account-2',
                      postsCount: 204,
                      profileUrl: 'https://www.instagram.com/beautyops/',
                      username: 'beautyops',
                      website: 'https://beautyops.example',
                    },
                  ],
            };
          } else if (body.actorId === 'apify/instagram-comment-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 4,
              items: [
                {
                  id: 'ig-comment-1',
                  likesCount: 7,
                  postId: 'demo-post-1',
                  text: 'Where can I buy this LED mask? Need the link.',
                  timestamp: '2026-04-04T13:00:00.000Z',
                  url: 'https://www.instagram.com/p/demo-1/',
                  username: 'viewerone',
                },
                {
                  id: 'ig-comment-2',
                  likesCount: 3,
                  postId: 'demo-post-1',
                  text: 'How do you use this in a student routine?',
                  timestamp: '2026-04-04T14:00:00.000Z',
                  url: 'https://www.instagram.com/p/demo-1/',
                  username: 'viewertwo',
                },
                {
                  id: 'ig-comment-3',
                  likesCount: 5,
                  postId: 'demo-post-1',
                  text: 'This is so good, obsessed with the before and after.',
                  timestamp: '2026-04-04T15:00:00.000Z',
                  url: 'https://www.instagram.com/p/demo-1/',
                  username: 'viewerthree',
                },
                {
                  id: 'ig-comment-4',
                  likesCount: 2,
                  postId: 'demo-post-1',
                  text: 'Too expensive for me right now.',
                  timestamp: '2026-04-04T16:00:00.000Z',
                  url: 'https://www.instagram.com/p/demo-1/',
                  username: 'viewerfour',
                },
              ],
            };
          } else if (body.actorId === 'apify/instagram-hashtag-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  caption:
                    'UGC example under a branded skincare campaign. #glowlab #beautytech',
                  commentsCount: 16,
                  likesCount: 280,
                  ownerUsername: 'ugcskincreator',
                  targetUsername: 'glowlabofficial',
                  timestamp: '2026-04-04T12:00:00.000Z',
                  url: 'https://www.instagram.com/p/campaign-1/',
                },
                {
                  caption:
                    'Tagged creator post for a dorm skincare workflow. #glowlab #studentcreator',
                  commentsCount: 11,
                  likesCount: 230,
                  ownerUsername: 'studentbeautyflow',
                  targetUsername: 'glowlabofficial',
                  timestamp: '2026-04-03T12:00:00.000Z',
                  url: 'https://www.instagram.com/p/campaign-2/',
                },
              ],
            };
          } else if (body.actorId === 'codebyte/tiktok-creative-center-top-ads') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  ad_title: 'Shop now for a faster skincare routine',
                  analytics: {
                    ad_title: 'Shop now for a faster skincare routine',
                    brand_name: 'Glow Lab',
                    caption: 'Shop now and get 20% off your LED skincare routine.',
                    comment: 34,
                    cost: 48.5,
                    country_codes: ['US'],
                    ctr: 0.041,
                    cvr: 0.013,
                    highlight_text: 'Fast LED skincare routine with a discount.',
                    industry_key: 'beauty',
                    keyword_list: ['led skincare', 'beauty device'],
                    landing_page: 'https://example.com/led-device',
                    like: 412,
                    objective_key: 'conversion',
                    video_info: {
                      cover: 'https://example.com/ad-cover-1.jpg',
                      duration: 21,
                      video_url: {
                        '720p': 'https://example.com/ad-video-1.mp4',
                      },
                    },
                  },
                  id: 'ad-1',
                },
                {
                  ad_title: 'Before and after with one beauty device',
                  analytics: {
                    ad_title: 'Before and after with one beauty device',
                    brand_name: 'Derma Beam',
                    caption: 'Before and after results in one routine. Learn more.',
                    comment: 21,
                    cost: 31.2,
                    country_codes: ['US', 'CA'],
                    ctr: 0.036,
                    cvr: 0.01,
                    highlight_text: 'Before/after creative with practical proof.',
                    industry_key: 'beauty',
                    keyword_list: ['beauty device', 'before after'],
                    landing_page: 'https://example.com/derma-beam',
                    like: 356,
                    objective_key: 'traffic',
                    video_info: {
                      cover: 'https://example.com/ad-cover-2.jpg',
                      duration: 28,
                      video_url: {
                        '720p': 'https://example.com/ad-video-2.mp4',
                      },
                    },
                  },
                  id: 'ad-2',
                },
              ],
            };
          } else if (body.actorId === 'apidojo/tiktok-music-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  musicAuthor: 'Glow Sound Lab',
                  musicId: 'music-1',
                  musicTitle: 'Dorm Night Routine',
                  musicUrl: 'https://www.tiktok.com/music/music-1',
                  observedUseCount: 1200,
                  sampleVideoUrls: [
                    'https://www.tiktok.com/@creator/video/music-1-a',
                    'https://www.tiktok.com/@creator/video/music-1-b',
                  ],
                  trendReason: 'High reuse in US beauty-tech creators',
                  videoCount: 1200,
                },
                {
                  musicAuthor: 'Campus Loop',
                  musicId: 'music-2',
                  musicTitle: 'Skincare Reset',
                  musicUrl: 'https://www.tiktok.com/music/music-2',
                  observedUseCount: 860,
                  sampleVideoUrls: [
                    'https://www.tiktok.com/@creator/video/music-2-a',
                    'https://www.tiktok.com/@creator/video/music-2-b',
                  ],
                  trendReason: 'Strong creator reuse in study/lifestyle videos',
                  videoCount: 860,
                },
              ],
            };
          } else if (body.actorId === 'pratikdani/tiktok-shop-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  brand: 'Glow Lab',
                  categoryName: 'Beauty Devices',
                  currentPrice: 89.99,
                  description: 'LED skincare mask for daily home use.',
                  imageUrls: ['https://example.com/shop-product-1.jpg'],
                  orders: 320,
                  originalPrice: 119.99,
                  productId: 'shop-product-1',
                  productUrl: 'https://www.tiktok.com/shop/p/shop-product-1',
                  ratingAverage: 4.8,
                  reviewCount: 128,
                  shopId: 'shop-1',
                  shopName: 'Glow Lab Official',
                  shopUrl: 'https://www.tiktok.com/@glowlabshop',
                  title: 'Glow Lab LED Mask',
                },
                {
                  brand: 'Derma Beam',
                  categoryName: 'Beauty Devices',
                  currentPrice: 64.5,
                  description: 'Compact red light wand for skincare routines.',
                  imageUrls: ['https://example.com/shop-product-2.jpg'],
                  orders: 210,
                  originalPrice: 79.99,
                  productId: 'shop-product-2',
                  productUrl: 'https://www.tiktok.com/shop/p/shop-product-2',
                  ratingAverage: 4.6,
                  reviewCount: 74,
                  shopId: 'shop-2',
                  shopName: 'Derma Beam Store',
                  shopUrl: 'https://www.tiktok.com/@dermabeamshop',
                  title: 'Derma Beam Light Wand',
                },
              ],
            };
          } else if (
            body.actorId === 'easyapi/rednote-xiaohongshu-user-posts-scraper'
          ) {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  profileUrl:
                    'https://www.xiaohongshu.com/user/profile/639946a0000000002702b173',
                  postData: {
                    postUrl: 'https://www.xiaohongshu.com/explore/demo-note-1',
                    noteId: 'demo-note-1',
                    type: 'video',
                    displayTitle: '打工人的表演上班',
                    user: {
                      userId: '639946a0000000002702b173',
                      nickname: '显眼包小涛',
                    },
                    interactInfo: {
                      likedCount: '168',
                    },
                    cover: {
                      urlDefault: `http://127.0.0.1:${activePort}/xhs-assets/cover-1.jpg`,
                      width: 1516,
                      height: 2022,
                    },
                  },
                  scrapedAt: '2026-04-09T11:06:15.494Z',
                },
                {
                  profileUrl:
                    'https://www.xiaohongshu.com/user/profile/639946a0000000002702b173',
                  postData: {
                    postUrl: 'https://www.xiaohongshu.com/explore/demo-note-2',
                    noteId: 'demo-note-2',
                    type: 'normal',
                    displayTitle: '护肤避坑合集',
                    user: {
                      userId: '639946a0000000002702b173',
                      nickname: '护肤实验室',
                    },
                    interactInfo: {
                      likedCount: '2400',
                    },
                    cover: {
                      urlDefault: `http://127.0.0.1:${activePort}/xhs-assets/cover-2.jpg`,
                      width: 1242,
                      height: 1660,
                    },
                    imageList: [
                      {
                        width: 1242,
                        height: 1660,
                        infoList: [
                          {
                            url: `http://127.0.0.1:${activePort}/xhs-assets/cover-2.jpg`,
                          },
                        ],
                      },
                    ],
                  },
                  scrapedAt: '2026-04-09T11:06:15.494Z',
                },
              ],
            };
          } else if (body.actorId === 'ecomscrape/1688-product-search-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  detailUrl: 'https://detail.1688.com/offer/2001.html',
                  minOrderQuantity: 20,
                  price: 39.5,
                  productTitle: 'Glow Lab LED beauty device',
                  shopName: 'Yiwu Glow Factory',
                  shopUrl: 'https://shop.1688.com/glow-factory',
                },
                {
                  detailUrl: 'https://detail.1688.com/offer/2002.html',
                  minOrderQuantity: 50,
                  price: 28.8,
                  productTitle: 'Derma Beam red-light wand',
                  shopName: 'Shenzhen Beam Supply',
                  shopUrl: 'https://shop.1688.com/beam-supply',
                },
              ],
            };
          } else if (body.actorId === 'apify/google-trends-scraper') {
            payload = {
              actorId: body.actorId,
              fetchedAt: '2026-04-05T12:00:00.000Z',
              input: body.input,
              itemCount: 2,
              items: [
                {
                  geo: 'US',
                  interest: 87,
                  keyword: 'led skincare device',
                },
                {
                  geo: 'US',
                  interest: 61,
                  keyword: 'red light wand',
                },
              ],
            };
          } else {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error: `unsupported hosted apify actor: ${body.actorId}`,
              }),
            );
            return;
          }

          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              accountId: 'account-1',
              operationId: `mock-apify:${body.actorId}`,
              payload,
              runHandle: null,
              status: 'completed',
              subscriptionStatus: 'active',
            }),
          );
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url === '/api/postplus-cli/hosted/provider'
      ) {
        const authorization = request.headers.authorization ?? '';

        if (authorization !== 'Bearer test-access-token') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: 'invalid session',
              code: 'postplus_cli_auth_invalid_session',
            }),
          );
          return;
        }

        const chunks = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          if (
            activeScenario === 'missing-capability' &&
            (body.family === 'brightdata' || body.family === 'gmail')
          ) {
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                error:
                  body.family === 'brightdata'
                    ? 'Hosted Bright Data is not configured on the hosted boundary.'
                    : 'Hosted Gmail OAuth is not configured on the hosted boundary.',
                code: 'postplus_cli_hosted_provider_capability_unavailable',
              }),
            );
            return;
          }

          providerEvents.push({
            chargeable:
              body.family === 'gmail' ||
              body.family === 'brightdata' ||
              body.family === 'llm' ||
              body.family === 'google-workspace' ||
              body.family === 'postiz' ||
              (body.family === 'wavespeed' &&
                body.operation === 'json-request' &&
                body.billing?.charge !== false),
            family: body.family,
            operation: body.operation,
          });

          if (body.family === 'postiz') {
            if (body.operation === 'json-request' && body.url.endsWith('/integrations')) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify([
                  {
                    accountId: 'account-1',
                    output: [
                      {
                        id: 'discord-1',
                        identifier: 'discord',
                        name: 'Acceptance Discord',
                        disabled: false,
                      },
                    ],
                    subscriptionStatus: 'active',
                  },
                ][0]),
              );
              return;
            }

            if (body.operation === 'json-request' && body.url.endsWith('/posts')) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: [
                    {
                      integration: 'discord-1',
                      postId: 'post-1',
                    },
                  ],
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }
          }

          if (body.family === 'brightdata') {
            if (
              body.operation === 'dataset-scrape' &&
              body.datasetId === 'gd_lyy3tktm25m4avu764'
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: [
                    {
                      id: 'linkedin-post-1',
                      url: 'https://www.linkedin.com/posts/demo-1',
                      user_id: 'demo-linkedin',
                      use_url: 'https://www.linkedin.com/in/demo-linkedin',
                      date_posted: '2026-04-01T00:00:00.000Z',
                      headline: 'LinkedIn demo post',
                      post_text: 'A public LinkedIn post about skincare devices.',
                      images: ['https://example.com/linkedin-1.jpg'],
                      videos: [],
                      num_likes: 42,
                      num_comments: 7,
                      num_shares: 3,
                      timestamp: '2026-04-05T12:00:00.000Z',
                    },
                  ],
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'dataset-scrape' &&
              body.datasetId === 'gd_lk56epmy2i5g7lzu0k'
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: [
                    {
                      channel_url: 'https://www.youtube.com/@demo-channel',
                      date_posted: '2026-04-01T00:00:00.000Z',
                      description: 'A YouTube demo video about skincare devices.',
                      handle_name: '@demo-channel',
                      likes: 120,
                      num_comments: 11,
                      preview_image: 'https://example.com/youtube-1.jpg',
                      timestamp: '2026-04-05T12:00:00.000Z',
                      title: 'Skincare device routine demo',
                      url: 'https://www.youtube.com/watch?v=demo123',
                      video_id: 'demo123',
                      video_url: 'https://example.com/youtube-1.mp4',
                      views: 1800,
                    },
                  ],
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'dataset-scrape' &&
              [
                'gd_lkaxegm826bjpoo9m5',
                'gd_lz11l67o2cb3r0lkj3',
                'gd_lyclm1571iy3mv57zw',
              ].includes(body.datasetId)
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: [
                    {
                      content:
                        'Facebook demo post about a compact beauty device routine.',
                      date_posted: '2026-04-01T00:00:00.000Z',
                      input: body.input?.[0] ?? { url: 'https://www.facebook.com/demo/posts/1' },
                      likes: 88,
                      num_comments: 6,
                      num_shares: 4,
                      page_name: 'Demo Beauty',
                      page_url: 'https://www.facebook.com/demo',
                      post_id: 'facebook-post-1',
                      post_image: 'https://example.com/facebook-1.jpg',
                      timestamp: '2026-04-05T12:00:00.000Z',
                      url: 'https://www.facebook.com/demo/posts/1',
                    },
                  ],
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (body.operation === 'mcp-call' && body.toolName === 'search_engine') {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    organic: [
                      {
                        link: 'https://www.linkedin.com/posts/demo-1',
                      },
                    ],
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }
          }

          if (body.family === 'google-workspace') {
            if (
              body.operation === 'json-request' &&
              body.url === 'https://sheets.googleapis.com/v4/spreadsheets'
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    properties: {
                      title: body.body?.properties?.title ?? 'Acceptance Sheet',
                    },
                    spreadsheetId: 'sheet-1',
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.includes('/values/') &&
              (body.method === 'POST' || body.method === 'PUT')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    updated: true,
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.startsWith('https://www.googleapis.com/drive/v3/files')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    files: [
                      {
                        id: 'drive-file-1',
                        mimeType: 'application/vnd.google-apps.spreadsheet',
                        name: 'Acceptance Sheet',
                        webViewLink:
                          'https://docs.google.com/spreadsheets/d/sheet-1/edit',
                      },
                    ],
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }
          }

          if (body.family === 'gmail') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                accountId: 'account-1',
                output: {
                  id: 'gmail-message-1',
                },
                subscriptionStatus: 'active',
              }),
            );
            return;
          }

          if (body.family === 'llm') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                accountId: 'account-1',
                output: {
                  candidates: [
                    {
                      content: {
                        parts: [
                          {
                            text: JSON.stringify({
                              summaryZh: '总结',
                              hookZh: '钩子',
                              contentPromiseZh: '承诺',
                              structureTypeZh: '结构',
                              visualStyleZh: '风格',
                              ctaZh: '行动',
                              whyItWorksZh: ['点 1', '点 2'],
                              openingLineExact: 'Open line',
                              closingLineApprox: 'Close line',
                              spokenAudioFlowZh: '音频节奏',
                              shots: [
                                {
                                  audio: 'Audio',
                                  durationSeconds: 3,
                                  endTime: '00:03',
                                  startTime: '00:00',
                                  visual: '画面',
                                },
                              ],
                              uncertaintiesZh: [],
                            }),
                          },
                        ],
                      },
                    },
                  ],
                  usageMetadata: {
                    candidatesTokenCount: 80,
                    promptTokenCount: 40,
                    totalTokenCount: 120,
                  },
                },
                subscriptionStatus: 'active',
              }),
            );
            return;
          }

          if (body.family === 'wavespeed') {
            if (
              body.operation === 'json-request' &&
              body.url.endsWith('/wavespeed-ai/openai-whisper')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    id: 'pred-audio-stt-1',
                    status: 'completed',
                    segments: [
                      {
                        start: 0,
                        end: 1,
                        text: 'Hello world',
                      },
                    ],
                    outputs: [
                      {
                        srt: '1\\n00:00:00,000 --> 00:00:01,000\\nHello world\\n',
                        text: 'Hello world',
                        text_details: [
                          {
                            start: 0,
                            end: 1,
                            text: 'Hello world',
                          },
                        ],
                      },
                    ],
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.endsWith('/wavespeed-ai/openai-whisper-with-video')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    id: 'pred-video-stt-1',
                    status: 'completed',
                    segments: [
                      {
                        start: 0,
                        end: 1.2,
                        text: 'Video transcript',
                      },
                    ],
                    outputs: [
                      {
                        srt: '1\\n00:00:00,000 --> 00:00:01,200\\nVideo transcript\\n',
                        text: 'Video transcript',
                        text_details: [
                          {
                            start: 0,
                            end: 1.2,
                            text: 'Video transcript',
                          },
                        ],
                      },
                    ],
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.endsWith('/google/nano-banana-2/text-to-image')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    data: {
                      id: 'pred-image-1',
                      outputs: [Buffer.from('acceptance-image').toString('base64')],
                      status: 'completed',
                      urls: {},
                    },
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.endsWith('/wavespeed-ai/qwen3-tts/voice-design')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    data: {
                      id: 'pred-voice-1',
                      outputs: ['https://api.wavespeed.ai/files/voice.wav'],
                      status: 'completed',
                      urls: {},
                    },
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'json-request' &&
              body.url.endsWith('/wavespeed-ai/infinitetalk')
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    data: {
                      id: 'pred-video-1',
                      outputs: ['https://api.wavespeed.ai/files/render.mp4'],
                      status: 'completed',
                      urls: {},
                    },
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'download-file' &&
              body.url === 'https://api.wavespeed.ai/files/voice.wav'
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    contentBase64: Buffer.from('voice-bytes').toString('base64'),
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }

            if (
              body.operation === 'download-file' &&
              body.url === 'https://api.wavespeed.ai/files/render.mp4'
            ) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  accountId: 'account-1',
                  output: {
                    contentBase64: Buffer.from('video-bytes').toString('base64'),
                  },
                  subscriptionStatus: 'active',
                }),
              );
              return;
            }
          }

          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: 'unsupported hosted provider request',
            }),
          );
        });
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise((resolvePromise) =>
      server.listen(0, '127.0.0.1', resolvePromise),
    );

    const address = server.address();
    const port =
      address && typeof address === 'object' ? address.port : null;

    assert.notEqual(port, null);
    activePort = port;

    const env = {
      ...process.env,
      POSTPLUS_CONFIG_DIR: configRoot,
      POSTPLUS_API_BASE_URL: `http://127.0.0.1:${port}`,
      POSTPLUS_CLAUDE_SKILLS_DIR: skillsDir,
      POSTPLUS_CODEX_SKILLS_DIR: codexSkillsDir,
      POSTPLUS_CODEX_APP_SKILLS_DIR: codexAppSkillsDir,
    };
    delete env.POSTPLUS_SKILLS_REPO_DIR;
    delete env.POSTPLUS_PROFILE;

    const guideReport = await loadJsonCommand({
      args: ['guide', 'install', ...tiktokSkillIds, '--json'],
      cwd: runtimeRoot,
      env,
    });
    assert.equal(
      guideReport.installCommand,
      'postplus install tiktok-research tiktok-shop-research',
    );
    assert.equal(guideReport.sourceKind, 'hosted-release');

    const installReport = await loadJsonCommand({
      args: ['install', ...acceptanceSkillIds, '--json'],
      cwd: runtimeRoot,
      env,
    });
    assert.equal(installReport.mode, 'apply');
    assert.equal(installReport.sourceKind, 'hosted-release');

    const configPath = resolve(configRoot, 'config.json');
    const existingConfig = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ...existingConfig,
          accessToken: 'test-access-token',
          refreshToken: 'test-refresh-token',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const validateReport = await loadJsonCommand({
      args: ['auth', 'validate', '--json'],
      cwd: runtimeRoot,
      env,
    });
    assert.equal(validateReport.accountId, 'account-1');
    assert.equal(validateReport.sessionExpiresAt, 1_900_000_000);

    const statusReport = await loadJsonCommand({
      args: ['status', '--json'],
      cwd: runtimeRoot,
      env,
    });
    assert.equal(statusReport.install.ok, true);
    assert.equal(
      statusReport.install.targets.every((target) => target.ok),
      true,
    );
    assert.equal(statusReport.auth.ok, true);
    assert.equal(statusReport.update.ok, true);
    assert.equal(
      (await lstat(resolve(codexSkillsDir, 'skill-finder-cn'))).isSymbolicLink(),
      true,
    );
    assert.equal(
      (await lstat(resolve(codexAppSkillsDir, 'skill-finder-cn')))
        .isSymbolicLink(),
      true,
    );

    const listReport = await loadJsonCommand({
      args: ['list', '--json'],
      cwd: runtimeRoot,
      env,
    });
    assert.equal(
      listReport.skills.some((entry) => entry.skillId === 'skill-finder-cn'),
      true,
    );

    const amazonBundle = hostedBundlesBySkillId.get('amazon-research');
    const instagramToolsBundle = hostedBundlesBySkillId.get('instagram-tools');
    const imageBatchRunnerBundle = hostedBundlesBySkillId.get(
      'image-batch-runner',
    );
    assert.ok(amazonBundle);
    assert.ok(instagramToolsBundle);
    assert.ok(imageBatchRunnerBundle);
    assert.match(
      await readFile(
        resolveHostedBundleFilePath({
          bundle: amazonBundle,
          configRoot,
          relativePath: 'skills/shared-apify/scripts/apify_actor_run.mjs',
        }),
        'utf8',
      ),
      /runHostedApifyActor/,
    );
    assert.match(
      await readFile(
        resolveHostedBundleFilePath({
          bundle: instagramToolsBundle,
          configRoot,
          relativePath: 'skills/instagram-references/actor-selection.md',
        }),
        'utf8',
      ),
      /Instagram/,
    );
    assert.match(
      await readFile(
        resolveHostedBundleFilePath({
          bundle: imageBatchRunnerBundle,
          configRoot,
          relativePath: 'skills/shared-runtime/scripts/lib/hosted_provider_bridge.mjs',
        }),
        'utf8',
      ),
      /runHostedProviderOperation/,
    );

    const scriptEnv = {
      ...env,
      POSTPLUS_ACCESS_TOKEN: undefined,
      POSTPLUS_REFRESH_TOKEN: undefined,
    };
    const invalidAuthEnv = {
      ...scriptEnv,
      POSTPLUS_ACCESS_TOKEN: 'bad-access-token',
      POSTPLUS_REFRESH_TOKEN: 'bad-refresh-token',
    };

    const socialMediaExtractorPath = resolve(
      workspaceRoot,
      '.postplus/social-media-extractor/route.json',
    );
    const socialMediaExtractorInputPath = resolve(
      workspaceRoot,
      '.postplus/social-media-extractor/input.json',
    );
    await writeJsonArtifact(socialMediaExtractorInputPath, {
      goal: 'creator-shortlist',
      platforms: ['tiktok', 'instagram', 'x'],
    });
    await runNodeCommand({
      args: [
        '--input',
        socialMediaExtractorInputPath,
        '--output',
        socialMediaExtractorPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'social-media-extractor/scripts/route_social_media_extractor.mjs',
      ),
    });
    const socialMediaExtractorOutput = JSON.parse(
      await readFile(socialMediaExtractorPath, 'utf8'),
    );
    assert.equal(socialMediaExtractorOutput.routePlan.length, 3);
    assert.equal(socialMediaExtractorOutput.nextSkill, 'creator-discovery-router');

    const creatorDiscoveryRouterPath = resolve(
      workspaceRoot,
      '.postplus/creator-discovery-router/route.json',
    );
    const creatorDiscoveryRouterInputPath = resolve(
      workspaceRoot,
      '.postplus/creator-discovery-router/input.json',
    );
    await writeJsonArtifact(creatorDiscoveryRouterInputPath, {
      followerRange: '5k-20k',
      platform: 'tiktok',
      topic: 'beauty device',
    });
    await runNodeCommand({
      args: [
        '--input',
        creatorDiscoveryRouterInputPath,
        '--output',
        creatorDiscoveryRouterPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'creator-discovery-router/scripts/route_creator_discovery.mjs',
      ),
    });
    const creatorDiscoveryRoute = JSON.parse(
      await readFile(creatorDiscoveryRouterPath, 'utf8'),
    );
    assert.equal(creatorDiscoveryRoute.primarySkill, 'tiktok-research');
    assert.equal(creatorDiscoveryRoute.handoffReady, true);

    const patternRouterPath = resolve(
      workspaceRoot,
      '.postplus/pattern-router/route.json',
    );
    const patternRouterInputPath = resolve(
      workspaceRoot,
      '.postplus/pattern-router/input.json',
    );
    await writeJsonArtifact(patternRouterInputPath, {
      segmentType: 'hook',
      target: 'request',
    });
    await runNodeCommand({
      args: ['--input', patternRouterInputPath, '--output', patternRouterPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'pattern-router/scripts/route_pattern_job.mjs',
      ),
    });
    const patternRoute = JSON.parse(await readFile(patternRouterPath, 'utf8'));
    assert.equal(patternRoute.primaryPattern, 'problem-first');
    assert.equal(patternRoute.nextSkill, 'video-request-architect');

    const preflightQaPath = resolve(
      workspaceRoot,
      '.postplus/prompt-preflight-qa/report.json',
    );
    const preflightQaInputPath = resolve(
      workspaceRoot,
      '.postplus/prompt-preflight-qa/input.json',
    );
    await writeJsonArtifact(preflightQaInputPath, {
      prompt:
        'Show a creator talking about the workflow. Keep it premium and nice.',
    });
    await runNodeCommand({
      args: ['--input', preflightQaInputPath, '--output', preflightQaPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'prompt-preflight-qa/scripts/run_prompt_preflight.mjs',
      ),
    });
    const preflightQa = JSON.parse(await readFile(preflightQaPath, 'utf8'));
    assert.equal(preflightQa.verdict, 'risky');
    assert.equal(preflightQa.missingFields.includes('opening mechanism'), true);

    const referenceDecodePath = resolve(
      workspaceRoot,
      '.postplus/reference-decode/decode.json',
    );
    const referenceDecodeInputPath = resolve(
      workspaceRoot,
      '.postplus/reference-decode/input.json',
    );
    await writeJsonArtifact(referenceDecodeInputPath, {});
    await runNodeCommand({
      args: [
        '--input',
        referenceDecodeInputPath,
        '--output',
        referenceDecodePath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'reference-decode/scripts/decode_reference.mjs',
      ),
    });
    const referenceDecode = JSON.parse(await readFile(referenceDecodePath, 'utf8'));
    assert.equal(referenceDecode.mustCopyVisualGrammar.length > 0, true);

    const referenceContractPath = resolve(
      workspaceRoot,
      '.postplus/reference-contract-builder/contract.json',
    );
    const referenceContractInputPath = resolve(
      workspaceRoot,
      '.postplus/reference-contract-builder/input.json',
    );
    await writeJsonArtifact(referenceContractInputPath, {
      excludedReferences: ['full style board'],
      testPurpose: 'hook rhythm only',
    });
    await runNodeCommand({
      args: [
        '--input',
        referenceContractInputPath,
        '--output',
        referenceContractPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'reference-contract-builder/scripts/build_reference_contract.mjs',
      ),
    });
    const referenceContract = JSON.parse(
      await readFile(referenceContractPath, 'utf8'),
    );
    assert.equal(referenceContract.mustNotCopy.includes('exact identity'), true);

    const videoRequestArchitectPath = resolve(
      workspaceRoot,
      '.postplus/video-request-architect/request.json',
    );
    const videoRequestArchitectInputPath = resolve(
      workspaceRoot,
      '.postplus/video-request-architect/input.json',
    );
    await writeJsonArtifact(videoRequestArchitectInputPath, {
      duration: 8,
      goal: 'hook replication',
      segmentType: 'hook',
    });
    await runNodeCommand({
      args: [
        '--input',
        videoRequestArchitectInputPath,
        '--output',
        videoRequestArchitectPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'video-request-architect/scripts/build_video_request_architecture.mjs',
      ),
    });
    const videoRequestArchitecture = JSON.parse(
      await readFile(videoRequestArchitectPath, 'utf8'),
    );
    assert.equal(videoRequestArchitecture.segmentType, 'hook');
    assert.equal(videoRequestArchitecture.skeleton.timecodedBeatSheet, true);

    const benchmarkToBriefPath = resolve(
      workspaceRoot,
      '.postplus/benchmark-to-brief/brief.json',
    );
    const benchmarkToBriefInputPath = resolve(
      workspaceRoot,
      '.postplus/benchmark-to-brief/input.json',
    );
    await writeJsonArtifact(benchmarkToBriefInputPath, {
      corePromise: 'Keep the workflow in context instead of switching tabs.',
    });
    await runNodeCommand({
      args: [
        '--input',
        benchmarkToBriefInputPath,
        '--output',
        benchmarkToBriefPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'benchmark-to-brief/scripts/build_benchmark_brief.mjs',
      ),
    });
    const benchmarkBrief = JSON.parse(await readFile(benchmarkToBriefPath, 'utf8'));
    assert.equal(benchmarkBrief.brief.hookOptions.length > 0, true);

    const personaPackPath = resolve(
      workspaceRoot,
      '.postplus/persona-pack/personas.json',
    );
    const personaPackInputPath = resolve(
      workspaceRoot,
      '.postplus/persona-pack/input.json',
    );
    await writeJsonArtifact(personaPackInputPath, {});
    await runNodeCommand({
      args: ['--input', personaPackInputPath, '--output', personaPackPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'persona-pack/scripts/build_persona_pack.mjs',
      ),
    });
    const personaPack = JSON.parse(await readFile(personaPackPath, 'utf8'));
    assert.equal(personaPack.personas[0]?.proofNeed?.length > 0, true);

    const visualHookPath = resolve(
      workspaceRoot,
      '.postplus/visual-hook/review.json',
    );
    const visualHookInputPath = resolve(
      workspaceRoot,
      '.postplus/visual-hook/input.json',
    );
    await writeJsonArtifact(visualHookInputPath, {});
    await runNodeCommand({
      args: ['--input', visualHookInputPath, '--output', visualHookPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'visual-hook/scripts/build_visual_hook_review.mjs',
      ),
    });
    const visualHookReview = JSON.parse(await readFile(visualHookPath, 'utf8'));
    assert.equal(visualHookReview.doNext.includes('cut the generic intro'), true);

    const creativeQaPath = resolve(
      workspaceRoot,
      '.postplus/creative-qa/qa-v1.json',
    );
    const creativeQaInputPath = resolve(
      workspaceRoot,
      '.postplus/creative-qa/input.json',
    );
    await writeJsonArtifact(creativeQaInputPath, {});
    await runNodeCommand({
      args: ['--input', creativeQaInputPath, '--output', creativeQaPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'creative-qa/scripts/build_creative_qa_record.mjs',
      ),
    });
    const creativeQaRecord = JSON.parse(await readFile(creativeQaPath, 'utf8'));
    assert.equal(creativeQaRecord.checklistVersion, 'qa-v1');

    const xhsCardNotesPath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-card-notes/cards.json',
    );
    const xhsCardNotesInputPath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-card-notes/input.json',
    );
    await writeJsonArtifact(xhsCardNotesInputPath, {});
    await runNodeCommand({
      args: ['--input', xhsCardNotesInputPath, '--output', xhsCardNotesPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-card-notes/scripts/build_xhs_card_notes_package.mjs',
      ),
    });
    const xhsCardNotes = JSON.parse(await readFile(xhsCardNotesPath, 'utf8'));
    assert.equal(xhsCardNotes.cardCount, 2);

    const xhsArticlePackagePath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-article-packager/package.json',
    );
    const xhsArticlePackageInputPath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-article-packager/input.json',
    );
    await writeJsonArtifact(xhsArticlePackageInputPath, {});
    await runNodeCommand({
      args: [
        '--input',
        xhsArticlePackageInputPath,
        '--output',
        xhsArticlePackagePath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-article-packager/scripts/build_xhs_article_package.mjs',
      ),
    });
    const xhsArticlePackage = JSON.parse(
      await readFile(xhsArticlePackagePath, 'utf8'),
    );
    assert.equal(xhsArticlePackage.files.includes('05-layout-brief.md'), true);

    const xhsNotesPath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-notes/note.json',
    );
    const xhsNotesInputPath = resolve(
      workspaceRoot,
      '.postplus/xiaohongshu-notes/input.json',
    );
    await writeJsonArtifact(xhsNotesInputPath, {});
    await runNodeCommand({
      args: ['--input', xhsNotesInputPath, '--output', xhsNotesPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-notes/scripts/build_xhs_note_draft.mjs',
      ),
    });
    const xhsNoteDraft = JSON.parse(await readFile(xhsNotesPath, 'utf8'));
    assert.equal(xhsNoteDraft.sections.length >= 4, true);

    await runBinaryCommand({
      command: 'python3',
      args: ['--version'],
      cwd: workspaceRoot,
      env: scriptEnv,
    });
    await runBinaryCommand({
      command: 'python3',
      args: ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)'],
      cwd: workspaceRoot,
      env: scriptEnv,
    });
    await runBinaryCommand({
      command: 'ffmpeg',
      args: ['-version'],
      cwd: workspaceRoot,
      env: scriptEnv,
    });
    await runBinaryCommand({
      command: 'ffprobe',
      args: ['-version'],
      cwd: workspaceRoot,
      env: scriptEnv,
    });

    const sampleVideoPath = resolve(
      workspaceRoot,
      '.postplus/local-media/sample-with-audio.mp4',
    );
    await createSampleVideo({
      outputPath: sampleVideoPath,
      cwd: workspaceRoot,
      env: scriptEnv,
    });

    const frameOutputPath = resolve(
      workspaceRoot,
      '.postplus/frame-extraction/frames/frame-001.jpg',
    );
    await mkdir(dirname(frameOutputPath), { recursive: true });
    await runBinaryCommand({
      command: 'ffmpeg',
      args: [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '0',
        '-i',
        sampleVideoPath,
        '-frames:v',
        '1',
        frameOutputPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
    });
    await assertNonEmptyFile(frameOutputPath);

    const mediaRouteBriefPath = resolve(
      workspaceRoot,
      '.postplus/media-route-brief.json',
    );
    await writeFile(
      mediaRouteBriefPath,
      JSON.stringify(
        {
          goal: 'subtitles',
          inputType: 'video',
          jobId: 'media-route-1',
          needsTimestamps: true,
          quality: 'rough',
          costMode: 'cheap-first',
        },
        null,
        2,
      ),
    );
    const mediaRoute = await runJsonNodeCommand({
      args: ['--brief', mediaRouteBriefPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'media-router/scripts/route_media_job.mjs'),
    });
    assert.equal(mediaRoute.primarySkill, 'video-transcription');
    assert.equal(mediaRoute.route, 'subtitle-ready');

    const audioTranscriptionRequestPath = resolve(
      workspaceRoot,
      '.postplus/audio-transcription-request.json',
    );
    await writeFile(
      audioTranscriptionRequestPath,
      JSON.stringify(
        {
          audio: 'https://example.com/audio.wav',
          durationSeconds: 1,
          enableTimestamps: true,
          jobId: 'audio-transcription-1',
          localOutputDir: resolve(workspaceRoot, '.postplus/audio-transcription-output'),
        },
        null,
        2,
      ),
    );
    const audioTranscriptionManifest = await runJsonNodeCommand({
      args: ['--request', audioTranscriptionRequestPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'audio-transcription/scripts/transcribe_audio.mjs',
      ),
    });
    assert.equal(audioTranscriptionManifest.segmentCount, 1);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: ['--request', audioTranscriptionRequestPath],
          cwd: workspaceRoot,
          env: {
            ...scriptEnv,
            POSTPLUS_ACCESS_TOKEN: 'bad-access-token',
          },
          scriptPath: resolve(
            skillsDir,
            'audio-transcription/scripts/transcribe_audio.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );

    const videoTranscriptionRequestPath = resolve(
      workspaceRoot,
      '.postplus/video-transcription-request.json',
    );
    await writeFile(
      videoTranscriptionRequestPath,
      JSON.stringify(
        {
          durationSeconds: 2,
          enableTimestamps: true,
          jobId: 'video-transcription-1',
          localOutputDir: resolve(workspaceRoot, '.postplus/video-transcription-output'),
          video: 'https://example.com/video.mp4',
        },
        null,
        2,
      ),
    );
    const videoTranscriptionManifest = await runJsonNodeCommand({
      args: ['--request', videoTranscriptionRequestPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'video-transcription/scripts/transcribe_video.mjs',
      ),
    });
    assert.equal(videoTranscriptionManifest.segmentCount, 1);

    const normalizedTranscriptPath = resolve(
      workspaceRoot,
      '.postplus/video-transcription-output/normalized-transcript.json',
    );
    const subtitleOutputPath = resolve(workspaceRoot, 'acceptance-subtitles.srt');
    const subtitleResult = await runJsonNodeCommand({
      args: ['--input', normalizedTranscriptPath, '--output', subtitleOutputPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'subtitle-packager/scripts/transcript_json_to_srt.mjs',
      ),
    });
    assert.equal(subtitleResult.segmentCount, 1);
    assert.match(await readFile(subtitleOutputPath, 'utf8'), /Video transcript/);

    const brollInputDir = resolve(workspaceRoot, '.postplus/broll-source');
    const brollVideoPath = resolve(brollInputDir, 'gmail-workflow-proof.mp4');
    await createSampleVideo({
      outputPath: brollVideoPath,
      cwd: workspaceRoot,
      env: scriptEnv,
    });
    await writeFile(
      resolve(brollInputDir, 'gmail-workflow-proof.md'),
      [
        'Core content: Gmail reply workflow proof with Clico shortcut.',
        'What this B-roll is good for: UI demo and workflow bridge.',
      ].join('\n'),
    );
    const brollCatalogPath = resolve(workspaceRoot, '.postplus/broll-catalog.json');
    const brollCatalogSummary = await runJsonNodeCommand({
      args: ['--input-dir', brollInputDir, '--output', brollCatalogPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'broll-catalog-builder/scripts/run_build_broll_catalog.mjs',
      ),
    });
    assert.equal(brollCatalogSummary.assetCount, 1);

    const brollChunksPath = resolve(workspaceRoot, '.postplus/broll-chunks.json');
    await writeFile(
      brollChunksPath,
      JSON.stringify(
        {
          jobId: 'broll-demo',
          schemaVersion: 'subtitle-normalized/v1',
          segments: [
            {
              id: 'beat-001',
              start: 0,
              end: 1.2,
              text: 'Leave Gmail, paste the thread into another AI tool, then come back.',
            },
            {
              id: 'beat-002',
              start: 1.2,
              end: 2.4,
              text: 'Clico writes a warmer reply directly in the Gmail workflow.',
            },
          ],
        },
        null,
        2,
      ),
    );
    const brollPlanPath = resolve(workspaceRoot, 'broll-plan.json');
    const brollPlanSummary = await runJsonNodeCommand({
      args: [
        '--chunks',
        brollChunksPath,
        '--catalog',
        brollCatalogPath,
        '--output',
        brollPlanPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'broll-match-engine/scripts/run_match_broll_plan.mjs',
      ),
    });
    assert.equal(brollPlanSummary.beatCount, 2);
    assert.equal(brollPlanSummary.matchedBeatCount > 0, true);

    const editEnhancementPath = resolve(
      workspaceRoot,
      'edit-enhancement-package.json',
    );
    const editEnhancementSummary = await runJsonNodeCommand({
      args: [
        '--broll-plan',
        brollPlanPath,
        '--output',
        editEnhancementPath,
        '--aspect-ratio',
        '9:16',
        '--style-profile',
        'basic',
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'edit-enhancement-packager/scripts/run_package_edit_enhancements.mjs',
      ),
    });
    assert.equal(editEnhancementSummary.beatCount, 2);

    const editingDecisionPath = resolve(
      workspaceRoot,
      'editing-decision-package.json',
    );
    const editingDecisionInputPath = resolve(
      workspaceRoot,
      'editing-decision-input.json',
    );
    await writeJsonArtifact(editingDecisionInputPath, {
      beats: JSON.parse(await readFile(brollChunksPath, 'utf8')).segments,
      editThesis: 'stay on face for claim, cut to proof for workflow evidence',
    });
    await runNodeCommand({
      args: [
        '--input',
        editingDecisionInputPath,
        '--output',
        editingDecisionPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'editing-decision-engine/scripts/build_editing_decision_package.mjs',
      ),
    });
    const editingDecisionPackage = JSON.parse(
      await readFile(editingDecisionPath, 'utf8'),
    );
    assert.equal(editingDecisionPackage.beatCount, 2);
    assert.equal(editingDecisionPackage.items[1]?.cutDecision, 'insert-b-roll');

    const tiktokResearchInputPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-research-input.json',
    );
    const tiktokResearchRawPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-research-raw.json',
    );
    const tiktokResearchNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-research-normalized.json',
    );
    const tiktokResearchAnalysisPath = resolve(
      workspaceRoot,
      'tiktok-research-analysis.json',
    );
    await runNodeCommand({
      args: [
        '--query',
        'skincare device',
        '--limit',
        '6',
        '--actor',
        'clockworks/tiktok-scraper',
        '--output',
        tiktokResearchInputPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'tiktok-research/scripts/build_tiktok_actor_input.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--actor',
        'clockworks/tiktok-scraper',
        '--input',
        tiktokResearchInputPath,
        '--output',
        tiktokResearchRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'tiktok-research/scripts/apify_actor_run.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        tiktokResearchRawPath,
        '--output',
        tiktokResearchNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'tiktok-research/scripts/normalize_tiktok_dataset.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--input',
        tiktokResearchNormalizedPath,
        '--output',
        tiktokResearchAnalysisPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'tiktok-research/scripts/analyze_tiktok_dataset.mjs',
      ),
    });
    const tiktokResearchAnalysis = JSON.parse(
      await readFile(tiktokResearchAnalysisPath, 'utf8'),
    );
    assert.equal(tiktokResearchAnalysis.datasetType, 'videos');
    assert.equal(tiktokResearchAnalysis.itemCount, 2);

    const tiktokShopRawPath = resolve(workspaceRoot, '.postplus/tiktok-shop-raw.json');
    const tiktokShopNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-shop-normalized.json',
    );
    const tiktokShopAnalysisPath = resolve(
      workspaceRoot,
      'tiktok-shop-analysis.json',
    );
    await runNodeCommand({
      args: [
        '--actor',
        'pratikdani/tiktok-shop-scraper',
        '--input',
        resolve(
          skillsDir,
          'tiktok-shop-research/templates/pratikdani-product-urls.json',
        ),
        '--output',
        tiktokShopRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'tiktok-shop-research/scripts/apify_actor_run.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        tiktokShopRawPath,
        '--actor',
        'pratikdani/tiktok-shop-scraper',
        '--output',
        tiktokShopNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'tiktok-shop-research/scripts/normalize_tiktok_shop_dataset.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--input',
        tiktokShopNormalizedPath,
        '--output',
        tiktokShopAnalysisPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'tiktok-shop-research/scripts/analyze_tiktok_shop_dataset.mjs',
      ),
    });
    const tiktokShopAnalysis = JSON.parse(
      await readFile(tiktokShopAnalysisPath, 'utf8'),
    );
    assert.equal(tiktokShopAnalysis.itemCount, 2);
    assert.equal(tiktokShopAnalysis.topShops.length > 0, true);

    const tiktokMusicTrendInputPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-music-trend-input.json',
    );
    const tiktokMusicTrendRawPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-music-trend-raw.json',
    );
    const tiktokMusicTrendNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-music-trend-normalized.json',
    );
    await writeFile(
      tiktokMusicTrendInputPath,
      JSON.stringify(
        {
          geo: 'US',
          keyword: 'beauty tech sound',
          limit: 20,
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--actor',
        'apidojo/tiktok-music-scraper',
        '--input',
        tiktokMusicTrendInputPath,
        '--output',
        tiktokMusicTrendRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'tiktok-research/scripts/apify_actor_run.mjs'),
    });
    const tiktokMusicTrendRaw = JSON.parse(
      await readFile(tiktokMusicTrendRawPath, 'utf8'),
    );
    const tiktokMusicTrendNormalized = normalizeTikTokMusicCandidates(
      tiktokMusicTrendRaw,
      'US',
    );
    await writeJsonArtifact(
      tiktokMusicTrendNormalizedPath,
      tiktokMusicTrendNormalized,
    );
    assert.equal(tiktokMusicTrendNormalized.itemCount, 2);
    assert.equal(tiktokMusicTrendNormalized.items[0]?.recordType, 'musicCandidate');

    const tiktokMusicSamplesPath = resolve(
      workspaceRoot,
      '.postplus/tiktok-music-samples.json',
    );
    const tiktokMusicSampleRankingPath = resolve(
      workspaceRoot,
      'tiktok-music-sample-ranking.json',
    );
    const tiktokMusicSamples = {
      itemCount: tiktokMusicTrendNormalized.items.length,
      items: tiktokMusicTrendNormalized.items.flatMap((item) =>
        item.sampleVideoUrls.map((videoUrl, index) => ({
          musicId: item.musicId,
          musicTitle: item.musicTitle,
          playCount: (item.observedUseCount || 0) - index * 100,
          postUrl: videoUrl,
          videoUrl,
        })),
      ),
    };
    await writeJsonArtifact(tiktokMusicSamplesPath, tiktokMusicSamples);
    const tiktokMusicSampleRanking = buildTikTokMusicSampleRanking(
      tiktokMusicSamples,
    );
    await writeJsonArtifact(
      tiktokMusicSampleRankingPath,
      tiktokMusicSampleRanking,
    );
    assert.equal(tiktokMusicSampleRanking.itemCount > 0, true);
    assert.equal(tiktokMusicSampleRanking.topVideoUrls.length > 0, true);

    const xActorInputPath = resolve(workspaceRoot, '.postplus/x-actor-input.json');
    const xRawPath = resolve(workspaceRoot, '.postplus/x-raw.json');
    await writeFile(
      xActorInputPath,
      JSON.stringify(
        {
          queries: ['skincare device'],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--actor',
        'apidojo/tweet-scraper',
        '--input',
        xActorInputPath,
        '--output',
        xRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/run_x_actor.mjs'),
    });
    const xRaw = JSON.parse(await readFile(xRawPath, 'utf8'));
    assert.equal(xRaw.itemCount, 2);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: [
            '--actor',
            'apidojo/tweet-scraper',
            '--input',
            xActorInputPath,
            '--output',
            resolve(workspaceRoot, '.postplus/x-invalid-auth.json'),
          ],
          cwd: workspaceRoot,
          env: invalidAuthEnv,
          scriptPath: resolve(skillsDir, 'x-tools/scripts/run_x_actor.mjs'),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );

    const xNormalizedTweetsPath = resolve(
      workspaceRoot,
      '.postplus/x-normalized-tweets.json',
    );
    await runNodeCommand({
      args: [
        '--input',
        xRawPath,
        '--actor',
        'apidojo/tweet-scraper',
        '--output',
        xNormalizedTweetsPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/normalize_x_dataset.mjs'),
    });
    const xRankedPostsPath = resolve(workspaceRoot, 'x-ranked-posts.json');
    await runNodeCommand({
      args: [
        '--input',
        xNormalizedTweetsPath,
        '--query',
        'skincare,beauty device',
        '--top',
        '5',
        '--output',
        xRankedPostsPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/rank_x_posts.mjs'),
    });
    const xRankedPosts = JSON.parse(await readFile(xRankedPostsPath, 'utf8'));
    assert.equal(xRankedPosts.itemCount, 2);
    assert.equal(xRankedPosts.topTweetUrls.length > 0, true);

    const xProfilesInputPath = resolve(
      workspaceRoot,
      '.postplus/x-profiles-input.json',
    );
    const xProfilesRawPath = resolve(workspaceRoot, '.postplus/x-profiles-raw.json');
    const xProfilesNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/x-profiles-normalized.json',
    );
    await writeFile(
      xProfilesInputPath,
      JSON.stringify(
        {
          usernames: ['trendwatcher', 'creativelead'],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--actor',
        'apidojo/twitter-user-scraper',
        '--input',
        xProfilesInputPath,
        '--output',
        xProfilesRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/run_x_actor.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        xProfilesRawPath,
        '--actor',
        'apidojo/twitter-user-scraper',
        '--output',
        xProfilesNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/normalize_x_dataset.mjs'),
    });
    const xRankedAccountsPath = resolve(workspaceRoot, 'x-ranked-accounts.json');
    await runNodeCommand({
      args: [
        '--profiles',
        xProfilesNormalizedPath,
        '--tweets',
        xNormalizedTweetsPath,
        '--output',
        xRankedAccountsPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'x-tools/scripts/rank_x_accounts.mjs'),
    });
    const xRankedAccounts = JSON.parse(
      await readFile(xRankedAccountsPath, 'utf8'),
    );
    assert.equal(xRankedAccounts.itemCount, 2);
    assert.equal(xRankedAccounts.topUsernames.includes('trendwatcher'), true);

    const instagramActorInputPath = resolve(
      workspaceRoot,
      '.postplus/instagram-actor-input.json',
    );
    const instagramRawPath = resolve(workspaceRoot, '.postplus/instagram-raw.json');
    await writeFile(
      instagramActorInputPath,
      JSON.stringify(
        {
          directUrls: ['https://www.instagram.com/p/demo-1/'],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--actor',
        'apify/instagram-post-scraper',
        '--input',
        instagramActorInputPath,
        '--output',
        instagramRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'instagram-tools/scripts/run_instagram_actor.mjs'),
    });
    const instagramRaw = JSON.parse(await readFile(instagramRawPath, 'utf8'));
    assert.equal(instagramRaw.itemCount, 2);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: [
            '--actor',
            'apify/instagram-post-scraper',
            '--input',
            instagramActorInputPath,
            '--output',
            resolve(workspaceRoot, '.postplus/instagram-invalid-auth.json'),
          ],
          cwd: workspaceRoot,
          env: invalidAuthEnv,
          scriptPath: resolve(
            skillsDir,
            'instagram-tools/scripts/run_instagram_actor.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );

    const instagramPostsNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/instagram-posts-normalized.json',
    );
    await runNodeCommand({
      args: [
        '--input',
        instagramRawPath,
        '--actor',
        'apify/instagram-post-scraper',
        '--output',
        instagramPostsNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/normalize_instagram_dataset.mjs',
      ),
    });
    const instagramPostRankingPath = resolve(
      workspaceRoot,
      'instagram-post-ranking.json',
    );
    await runNodeCommand({
      args: [
        '--input',
        instagramPostsNormalizedPath,
        '--theme',
        'skincare,beauty tech',
        '--shortlist-size',
        '5',
        '--output',
        instagramPostRankingPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/rank_instagram_posts.mjs',
      ),
    });
    const instagramPostRanking = JSON.parse(
      await readFile(instagramPostRankingPath, 'utf8'),
    );
    assert.equal(instagramPostRanking.itemCount, 2);
    assert.equal(instagramPostRanking.shortlistCount > 0, true);

    const instagramProfilesBriefPath = resolve(
      workspaceRoot,
      '.postplus/instagram-profiles-brief.json',
    );
    const instagramProfilesInputPath = resolve(
      workspaceRoot,
      '.postplus/instagram-profiles-input.json',
    );
    const instagramProfilesRawPath = resolve(
      workspaceRoot,
      '.postplus/instagram-profiles-raw.json',
    );
    const instagramProfilesNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/instagram-profiles-normalized.json',
    );
    await writeFile(
      instagramProfilesBriefPath,
      JSON.stringify(
        {
          limit: 10,
          usernames: ['skinlabcreator', 'beautyops'],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--brief',
        instagramProfilesBriefPath,
        '--actor',
        'apify/instagram-profile-scraper',
        '--output',
        instagramProfilesInputPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/build_instagram_actor_input.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--actor',
        'apify/instagram-profile-scraper',
        '--input',
        instagramProfilesInputPath,
        '--output',
        instagramProfilesRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'instagram-tools/scripts/run_instagram_actor.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramProfilesRawPath,
        '--actor',
        'apify/instagram-profile-scraper',
        '--dataset-type',
        'profiles',
        '--output',
        instagramProfilesNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/normalize_instagram_dataset.mjs',
      ),
    });
    const instagramAccountRankingPath = resolve(
      workspaceRoot,
      'instagram-account-ranking.json',
    );
    await runNodeCommand({
      args: [
        '--profiles',
        instagramProfilesNormalizedPath,
        '--posts',
        instagramPostsNormalizedPath,
        '--output',
        instagramAccountRankingPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/rank_instagram_accounts.mjs',
      ),
    });
    const instagramAccountRanking = JSON.parse(
      await readFile(instagramAccountRankingPath, 'utf8'),
    );
    assert.equal(instagramAccountRanking.itemCount, 2);
    assert.equal(
      instagramAccountRanking.topUsernames.includes('skinlabcreator'),
      true,
    );

    const instagramCommentsInputPath = resolve(
      workspaceRoot,
      '.postplus/instagram-comments-input.json',
    );
    const instagramCommentsRawPath = resolve(
      workspaceRoot,
      '.postplus/instagram-comments-raw.json',
    );
    const instagramCommentsNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/instagram-comments-normalized.json',
    );
    const instagramCommentClustersPath = resolve(
      workspaceRoot,
      'instagram-comment-clusters.json',
    );
    await writeFile(
      instagramCommentsInputPath,
      JSON.stringify(
        {
          directUrls: ['https://www.instagram.com/p/demo-1/'],
          resultsLimit: 20,
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--actor',
        'apify/instagram-comment-scraper',
        '--input',
        instagramCommentsInputPath,
        '--output',
        instagramCommentsRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'instagram-tools/scripts/run_instagram_actor.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramCommentsRawPath,
        '--actor',
        'apify/instagram-comment-scraper',
        '--dataset-type',
        'comments',
        '--output',
        instagramCommentsNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/normalize_instagram_dataset.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramCommentsNormalizedPath,
        '--output',
        instagramCommentClustersPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/cluster_instagram_comments.mjs',
      ),
    });
    const instagramCommentClusters = JSON.parse(
      await readFile(instagramCommentClustersPath, 'utf8'),
    );
    assert.equal(instagramCommentClusters.clusterCount > 0, true);
    assert.equal(
      instagramCommentClusters.clusters.some(
        (entry) => entry.bucket === 'purchase-intent',
      ),
      true,
    );

    const instagramDiscoveryBriefPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-brief.json',
    );
    const instagramDiscoveryInputPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-input.json',
    );
    const instagramDiscoveryRawPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-raw.json',
    );
    const instagramDiscoveryNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-normalized.json',
    );
    const instagramDiscoveryCandidatesPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-candidates.json',
    );
    const instagramDiscoveryProfilesBriefPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-profiles-brief.json',
    );
    const instagramDiscoveryProfilesInputPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-profiles-input.json',
    );
    const instagramDiscoveryProfilesRawPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-profiles-raw.json',
    );
    const instagramDiscoveryProfilesNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/instagram-discovery-profiles-normalized.json',
    );
    const instagramCreatorRankingPath = resolve(
      workspaceRoot,
      'instagram-creator-ranking.json',
    );
    await writeFile(
      instagramDiscoveryBriefPath,
      JSON.stringify(
        {
          limit: 8,
          queries: ['student skincare creator'],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--brief',
        instagramDiscoveryBriefPath,
        '--actor',
        'apify/instagram-search-scraper',
        '--output',
        instagramDiscoveryInputPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/build_instagram_actor_input.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--actor',
        'apify/instagram-search-scraper',
        '--input',
        instagramDiscoveryInputPath,
        '--output',
        instagramDiscoveryRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'instagram-tools/scripts/run_instagram_actor.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramDiscoveryRawPath,
        '--actor',
        'apify/instagram-search-scraper',
        '--dataset-type',
        'search',
        '--output',
        instagramDiscoveryNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/normalize_instagram_dataset.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramDiscoveryNormalizedPath,
        '--route',
        'content-first',
        '--output',
        instagramDiscoveryCandidatesPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/extract_instagram_candidate_usernames.mjs',
      ),
    });
    const instagramDiscoveryCandidates = JSON.parse(
      await readFile(instagramDiscoveryCandidatesPath, 'utf8'),
    );
    await writeFile(
      instagramDiscoveryProfilesBriefPath,
      JSON.stringify(
        {
          limit: 8,
          usernames: instagramDiscoveryCandidates.usernames,
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--brief',
        instagramDiscoveryProfilesBriefPath,
        '--actor',
        'apify/instagram-profile-scraper',
        '--output',
        instagramDiscoveryProfilesInputPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/build_instagram_actor_input.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--actor',
        'apify/instagram-profile-scraper',
        '--input',
        instagramDiscoveryProfilesInputPath,
        '--output',
        instagramDiscoveryProfilesRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'instagram-tools/scripts/run_instagram_actor.mjs'),
    });
    await runNodeCommand({
      args: [
        '--input',
        instagramDiscoveryProfilesRawPath,
        '--actor',
        'apify/instagram-profile-scraper',
        '--dataset-type',
        'profiles',
        '--output',
        instagramDiscoveryProfilesNormalizedPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/normalize_instagram_dataset.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--profiles',
        instagramDiscoveryProfilesNormalizedPath,
        '--content',
        instagramDiscoveryNormalizedPath,
        '--candidates',
        instagramDiscoveryCandidatesPath,
        '--route',
        'content-first',
        '--output',
        instagramCreatorRankingPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'instagram-tools/scripts/rank_instagram_creators.mjs',
      ),
    });
    const instagramCreatorRanking = JSON.parse(
      await readFile(instagramCreatorRankingPath, 'utf8'),
    );
    assert.equal(instagramCreatorRanking.shortlistCount, 2);
    assert.equal(
      instagramCreatorRanking.research_pool.length,
      2,
    );
    assert.equal(
      (instagramCreatorRanking.shortlist[0]?.score || 0) > 0,
      true,
    );

    const xhsActorInputPath = resolve(
      workspaceRoot,
      '.postplus/xhs-actor-input.json',
    );
    const xhsRawPath = resolve(workspaceRoot, '.postplus/xhs-raw.json');
    const xhsNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/xhs-normalized.json',
    );
    const xhsMediaManifestPath = resolve(
      workspaceRoot,
      '.postplus/xhs-media-manifest.json',
    );
    const xhsMediaOutputDir = resolve(
      workspaceRoot,
      '.postplus/xhs-media-assets',
    );
    const xhsMediaReportPath = resolve(
      workspaceRoot,
      '.postplus/xhs-media-download-report.json',
    );
    await writeJsonArtifact(xhsActorInputPath, {
      profileUrls: [
        'https://www.xiaohongshu.com/user/profile/639946a0000000002702b173',
      ],
      maxItems: 12,
    });
    await runNodeCommand({
      args: [
        '--actor',
        'easyapi/rednote-xiaohongshu-user-posts-scraper',
        '--input',
        xhsActorInputPath,
        '--output',
        xhsRawPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, 'xiaohongshu-tools/scripts/run_xhs_actor.mjs'),
    });
    await runNodeCommand({
      args: ['--input', xhsRawPath, '--output', xhsNormalizedPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/normalize_xhs_dataset.mjs',
      ),
    });

    await runNodeCommand({
      args: [
        '--input',
        xhsNormalizedPath,
        '--limit',
        '1',
        '--output',
        xhsMediaManifestPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xhs-media-collector/scripts/build_xhs_media_manifest.mjs',
      ),
    });
    await runNodeCommand({
      args: [
        '--manifest',
        xhsMediaManifestPath,
        '--output-dir',
        xhsMediaOutputDir,
        '--output',
        xhsMediaReportPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xhs-media-collector/scripts/download_xhs_media_assets.mjs',
      ),
    });
    const xhsMediaVerify = await runJsonNodeCommand({
      args: ['--manifest', xhsMediaReportPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xhs-media-collector/scripts/verify_xhs_media_manifest.mjs',
      ),
    });
    assert.equal(xhsMediaVerify.failedCount, 0);

    const xhsProfilesFixturePath = resolve(
      workspaceRoot,
      '.postplus/xhs-profiles-fixture.json',
    );
    const xhsCommentsFixturePath = resolve(
      workspaceRoot,
      '.postplus/xhs-comments-fixture.json',
    );
    const xhsCommentsClusteredPath = resolve(
      workspaceRoot,
      '.postplus/xhs-comments-clustered.json',
    );
    const xhsProductsFixturePath = resolve(
      workspaceRoot,
      '.postplus/xhs-products-fixture.json',
    );
    await writeFile(
      xhsProfilesFixturePath,
      JSON.stringify(
        {
          generatedAt: '2026-04-05T12:00:00.000Z',
          itemCount: 1,
          items: [
            {
              followersCount: 12800,
              followingCount: 420,
              likesAndCollectionsCount: 52000,
              location: 'Shanghai',
              nickname: '护肤实验室',
              profileId: '639946a0000000002702b173',
              profileUrl:
                'https://www.xiaohongshu.com/user/profile/639946a0000000002702b173',
              redId: 'beauty-lab',
              description: '好物种草与护肤产品池整理',
            },
          ],
          platform: 'xiaohongshu',
        },
        null,
        2,
      ),
    );
    await writeFile(
      xhsCommentsFixturePath,
      JSON.stringify(
        {
          generatedAt: '2026-04-05T12:00:00.000Z',
          itemCount: 3,
          items: [
            {
              likeCount: 12,
              ownerNickname: '评论用户A',
              postId: 'demo-note-1',
              postUrl: 'https://www.xiaohongshu.com/explore/demo-note-1',
              text: '多少钱，求链接',
            },
            {
              likeCount: 4,
              ownerNickname: '评论用户B',
              postId: 'demo-note-1',
              postUrl: 'https://www.xiaohongshu.com/explore/demo-note-1',
              text: '这个怎么买到，想买',
            },
            {
              likeCount: 3,
              ownerNickname: '评论用户C',
              postId: 'demo-note-2',
              postUrl: 'https://www.xiaohongshu.com/explore/demo-note-2',
              text: '求教程和品牌名',
            },
          ],
          platform: 'xiaohongshu',
        },
        null,
        2,
      ),
    );
    await writeFile(
      xhsProductsFixturePath,
      JSON.stringify(
        {
          generatedAt: '2026-04-05T12:00:00.000Z',
          itemCount: 2,
          items: [
            {
              brand: 'Glow Lab',
              category: 'Beauty Devices',
              ownerNickname: '护肤实验室',
              ownerProfileId: '639946a0000000002702b173',
              price: 129,
              priceTag: '爆款',
              productId: 'xhs-product-1',
              productUrl: 'https://www.xiaohongshu.com/store/items/xhs-product-1',
              salesText: '已售 520',
              title: 'Glow Lab LED 美容仪',
            },
            {
              brand: 'Derma Beam',
              category: 'Beauty Devices',
              ownerNickname: '护肤实验室',
              ownerProfileId: '639946a0000000002702b173',
              price: 69,
              productId: 'xhs-product-2',
              productUrl: 'https://www.xiaohongshu.com/store/items/xhs-product-2',
              salesText: '销量 180',
              title: 'Derma Beam 红光导入棒',
            },
          ],
          platform: 'xiaohongshu',
        },
        null,
        2,
      ),
    );
    const xhsTopicMapPath = resolve(workspaceRoot, 'xhs-topic-map.json');
    await runNodeCommand({
      args: ['--input', xhsNormalizedPath, '--output', xhsTopicMapPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/build_xhs_topic_map.mjs',
      ),
    });
    const xhsTopicMap = JSON.parse(await readFile(xhsTopicMapPath, 'utf8'));
    assert.equal(xhsTopicMap.itemCount, 2);
    assert.equal(xhsTopicMap.topContentPillars.length > 0, true);

    const xhsResearchAccountRankingPath = resolve(
      workspaceRoot,
      'xhs-account-ranking.json',
    );
    await runNodeCommand({
      args: [
        '--profiles',
        xhsProfilesFixturePath,
        '--posts',
        xhsNormalizedPath,
        '--products',
        xhsProductsFixturePath,
        '--output',
        xhsResearchAccountRankingPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/rank_xhs_accounts.mjs',
      ),
    });
    const xhsResearchAccountRanking = JSON.parse(
      await readFile(xhsResearchAccountRankingPath, 'utf8'),
    );
    assert.equal(xhsResearchAccountRanking.itemCount, 1);
    assert.equal(xhsResearchAccountRanking.topProfiles[0], '护肤实验室');

    await runNodeCommand({
      args: ['--input', xhsCommentsFixturePath, '--output', xhsCommentsClusteredPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/cluster_xhs_comments.mjs',
      ),
    });
    const xhsCommentClusters = JSON.parse(
      await readFile(xhsCommentsClusteredPath, 'utf8'),
    );
    assert.equal(xhsCommentClusters.clusterCount > 0, true);
    assert.equal(
      xhsCommentClusters.clusters.some(
        (entry) => entry.bucket === 'purchase-intent',
      ),
      true,
    );

    const xhsProductRankingPath = resolve(
      workspaceRoot,
      'xhs-product-ranking.json',
    );
    await runNodeCommand({
      args: ['--input', xhsProductsFixturePath, '--output', xhsProductRankingPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/rank_xhs_products.mjs',
      ),
    });
    const xhsProductRanking = JSON.parse(
      await readFile(xhsProductRankingPath, 'utf8'),
    );
    assert.equal(xhsProductRanking.itemCount, 2);
    assert.equal(xhsProductRanking.topProductIds[0], 'xhs-product-1');

    const xhsMerchantReportPath = resolve(workspaceRoot, 'xhs-merchant-report.json');
    await runNodeCommand({
      args: [
        '--profiles',
        xhsProfilesFixturePath,
        '--posts',
        xhsNormalizedPath,
        '--comments',
        xhsCommentsClusteredPath,
        '--products',
        xhsProductsFixturePath,
        '--profile-id',
        '639946a0000000002702b173',
        '--output',
        xhsMerchantReportPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'xiaohongshu-tools/scripts/build_xhs_merchant_report.mjs',
      ),
    });
    const xhsMerchantReport = JSON.parse(
      await readFile(xhsMerchantReportPath, 'utf8'),
    );
    assert.equal(xhsMerchantReport.productPool.productCount, 2);
    assert.equal(xhsMerchantReport.audienceVoice.commentCount, 3);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: [
            '--actor',
            'easyapi/rednote-xiaohongshu-user-posts-scraper',
            '--input',
            xhsActorInputPath,
            '--output',
            resolve(workspaceRoot, '.postplus/xhs-invalid-auth.json'),
          ],
          cwd: workspaceRoot,
          env: invalidAuthEnv,
          scriptPath: resolve(
            skillsDir,
            'xiaohongshu-tools/scripts/run_xhs_actor.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );

    const creatorInputsPath = resolve(
      workspaceRoot,
      '.postplus/creator-inputs.json',
    );
    const creatorLeadsPath = resolve(
      workspaceRoot,
      '.postplus/creator-leads.json',
    );
    const creatorBriefPath = resolve(
      workspaceRoot,
      '.postplus/creator-brief.json',
    );
    const creatorDraftsPath = resolve(
      workspaceRoot,
      'creator-outreach-drafts.json',
    );
    await writeFile(
      creatorInputsPath,
      JSON.stringify(
        {
          items: [
            {
              accountType: 'creator',
              displayName: 'Creator One',
              followersCount: 12400,
              platform: 'tiktok',
              profileUrl: 'https://www.tiktok.com/@creator-one',
              recordType: 'profile',
              suggestedAngle: 'helping students build skincare routines',
              topicFit: 0.92,
              username: 'creator-one',
            },
          ],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: ['--inputs', creatorInputsPath, '--output', creatorLeadsPath],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/creator-outreach/scripts/build_creator_leads.mjs',
      ),
    });
    await writeFile(
      creatorBriefPath,
      JSON.stringify(
        {
          brandName: 'Glow Lab',
          cta: 'Would you be open to a short intro call next week?',
          niche: 'student skincare routines',
          offer: 'a paid creator collaboration',
          productName: 'Glow Lab LED Mask',
          signature: 'Glow Lab Team',
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--leads',
        creatorLeadsPath,
        '--brief',
        creatorBriefPath,
        '--output',
        creatorDraftsPath,
      ],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/creator-outreach/scripts/generate_outreach_drafts.mjs',
      ),
    });
    const creatorDrafts = JSON.parse(await readFile(creatorDraftsPath, 'utf8'));
    assert.equal(creatorDrafts.itemCount, 1);
    assert.match(creatorDrafts.items[0]?.draftBody ?? '', /Glow Lab/);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: ['--leads', creatorLeadsPath],
          cwd: repoRoot,
          env: scriptEnv,
          scriptPath: resolve(
            skillsRepoRoot,
            'skills/creator-outreach/scripts/generate_outreach_drafts.mjs',
          ),
        }),
      (error) => {
        assert.match(String(error.stderr ?? error.message ?? error), /Usage:/);
        return true;
      },
    );

    const amazonAnalysisInputPath = resolve(
      workspaceRoot,
      '.postplus/amazon-normalized.json',
    );
    const amazonAnalysisOutputPath = resolve(
      workspaceRoot,
      'amazon-analysis.json',
    );
    await writeFile(
      amazonAnalysisInputPath,
      JSON.stringify(
        {
          itemCount: 1,
          items: [
            {
              entityType: 'product',
              identity: {
                asin: 'B0001',
                brand: 'Glow Lab',
                productUrl: 'https://www.amazon.com/dp/B0001',
                title: 'Glow Lab LED Mask',
              },
              merchandising: {
                category: 'Beauty Devices',
              },
              pricing: {
                currentPrice: 89.99,
              },
              proof: {
                bestsellerRank: 320,
                boughtPastMonth: 42,
                ratingAverage: 4.7,
                reviewCount: 128,
              },
              review: {},
              seller: {
                sellerName: 'Glow Lab Official',
              },
            },
          ],
          schemaVersion: '1.0.0',
          source: {
            actorId: 'junglee/amazon-asins-scraper',
          },
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: ['--input', amazonAnalysisInputPath, '--output', amazonAnalysisOutputPath],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/amazon-research/scripts/analyze_amazon_dataset.mjs',
      ),
    });
    const amazonAnalysis = JSON.parse(
      await readFile(amazonAnalysisOutputPath, 'utf8'),
    );
    assert.equal(amazonAnalysis.itemCount, 1);
    assert.equal(amazonAnalysis.productSummary.itemCount, 1);

    const googleTrendsInputPath = resolve(
      workspaceRoot,
      '.postplus/google-trends-input.json',
    );
    const googleTrendsRawPath = resolve(
      workspaceRoot,
      '.postplus/google-trends-raw.json',
    );
    const googleTrendsNormalizedPath = resolve(
      workspaceRoot,
      '.postplus/google-trends-normalized.json',
    );
    await writeFile(
      googleTrendsInputPath,
      JSON.stringify(
        {
          geo: 'US',
          searchTerms: ['led skincare device', 'red light wand'],
        },
        null,
        2,
      ),
    );
    const googleTrendsRaw = {
      actorId: 'apify/google-trends-scraper',
      fetchedAt: '2026-04-05T12:00:00.000Z',
      input: JSON.parse(await readFile(googleTrendsInputPath, 'utf8')),
      itemCount: 2,
      items: [
        {
          geo: 'US',
          interest: 87,
          keyword: 'led skincare device',
        },
        {
          geo: 'US',
          interest: 61,
          keyword: 'red light wand',
        },
      ],
    };
    await writeJsonArtifact(googleTrendsRawPath, googleTrendsRaw);
    const googleTrendsNormalized = normalizeGoogleTrends(googleTrendsRaw);
    await writeJsonArtifact(
      googleTrendsNormalizedPath,
      googleTrendsNormalized,
    );
    assert.equal(googleTrendsNormalized.itemCount, 2);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: [],
          cwd: repoRoot,
          env: scriptEnv,
          scriptPath: resolve(
            skillsRepoRoot,
            'skills/amazon-research/scripts/analyze_amazon_dataset.mjs',
          ),
        }),
      (error) => {
        assert.match(String(error.stderr ?? error.message ?? error), /Usage:/);
        return true;
      },
    );

    const raw1688Path = resolve(workspaceRoot, '.postplus/1688-raw.json');
    const normalized1688Path = resolve(workspaceRoot, '.postplus/1688-normalized.json');
    const ranked1688ProductsPath = resolve(
      workspaceRoot,
      '1688-ranked-products.json',
    );
    const ranked1688SuppliersPath = resolve(
      workspaceRoot,
      '1688-ranked-suppliers.json',
    );
    await writeFile(
      raw1688Path,
      JSON.stringify(
        {
          actorId: 'ecomscrape/1688-product-search-scraper',
          fetchedAt: '2026-04-05T12:00:00.000Z',
          input: {
            query: 'LED skincare mask',
          },
          items: [
            {
              badges: ['source factory'],
              categoryName: 'Beauty Devices',
              companyName: 'Shenzhen Glow Factory',
              currency: 'CNY',
              minOrder: 5,
              price: '38.8',
              productId: 'offer-1',
              productUrl: 'https://detail.1688.com/offer/123.html',
              salesCount: 1280,
              shopAgeText: '8 years',
              shopUrl: 'https://shop.1688.com/demo',
              supplierBadges: ['factory'],
              supplierId: 'supplier-1',
              supportsCustomization: true,
              title: 'LED skincare mask OEM',
            },
          ],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: ['--input', raw1688Path, '--output', normalized1688Path],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, '1688-tools/scripts/normalize_1688_dataset.mjs'),
    });
    const normalized1688 = JSON.parse(await readFile(normalized1688Path, 'utf8'));
    assert.equal(normalized1688.itemCount, 1);
    await runNodeCommand({
      args: ['--input', normalized1688Path, '--output', ranked1688ProductsPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, '1688-tools/scripts/rank_1688_products.mjs'),
    });
    const ranked1688Products = JSON.parse(
      await readFile(ranked1688ProductsPath, 'utf8'),
    );
    assert.equal(ranked1688Products.items[0]?.shortlistScore > 0, true);
    await runNodeCommand({
      args: ['--input', normalized1688Path, '--output', ranked1688SuppliersPath],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(skillsDir, '1688-tools/scripts/rank_1688_suppliers.mjs'),
    });
    const ranked1688Suppliers = JSON.parse(
      await readFile(ranked1688SuppliersPath, 'utf8'),
    );
    assert.equal(ranked1688Suppliers.itemCount, 1);

    const research1688SummaryPath = resolve(
      workspaceRoot,
      '1688-research-summary.json',
    );
    const research1688Summary = summarize1688Research({
      normalized: normalized1688,
      rankedProducts: ranked1688Products,
      rankedSuppliers: ranked1688Suppliers,
    });
    await writeJsonArtifact(research1688SummaryPath, research1688Summary);
    assert.equal(research1688Summary.supplierShortlistCount, 1);
    assert.equal(research1688Summary.topSupplier !== null, true);

    const sourcingSelectionPath = resolve(
      workspaceRoot,
      'sourcing-selection.json',
    );
    const sourcingSelectionInputPath = resolve(
      workspaceRoot,
      'sourcing-selection-input.json',
    );
    await writeJsonArtifact(sourcingSelectionInputPath, {
      demandSignals: googleTrendsNormalized.items.map((item) => item.keyword),
      supplySignals: [
        research1688Summary.topSupplier,
        `amazon:${amazonAnalysis.productSummary.itemCount}`,
      ],
    });
    await runNodeCommand({
      args: [
        '--input',
        sourcingSelectionInputPath,
        '--output',
        sourcingSelectionPath,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'sourcing-selection/scripts/build_sourcing_selection.mjs',
      ),
    });
    const sourcingSelection = JSON.parse(
      await readFile(sourcingSelectionPath, 'utf8'),
    );
    assert.equal(sourcingSelection.decision, 'investigate_further');
    assert.equal(sourcingSelection.supplySignals.length >= 2, true);

    const linkedinPlanPath = resolve(workspaceRoot, '.postplus/linkedin-plan.json');
    const linkedinOutputDir = resolve(workspaceRoot, 'linkedin-output');
    await writeFile(
      linkedinPlanPath,
      JSON.stringify(
        {
          itemCount: 1,
          items: [
            {
              datasetId: 'gd_lyy3tktm25m4avu764',
              input: {
                url: 'https://www.linkedin.com/posts/demo-1',
              },
              platform: 'linkedin',
              url: 'https://www.linkedin.com/posts/demo-1',
            },
          ],
        },
        null,
        2,
      ),
    );
    await runNodeCommand({
      args: [
        '--plan',
        linkedinPlanPath,
        '--output-dir',
        linkedinOutputDir,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'linkedin-research/internal/brightdata/scripts/collect_public_posts.mjs',
      ),
    });
    const linkedinCollectionReport = JSON.parse(
      await readFile(
        resolve(linkedinOutputDir, 'collection-report.json'),
        'utf8',
      ),
    );
    const linkedinRaw = JSON.parse(
      await readFile(resolve(linkedinOutputDir, 'raw/linkedin.json'), 'utf8'),
    );
    assert.equal(linkedinCollectionReport.summary.linkedin.itemCount, 1);
    assert.equal(linkedinRaw.length, 1);
    assert.equal(linkedinRaw[0]?.url, 'https://www.linkedin.com/posts/demo-1');

    const youtubeOutputDir = resolve(workspaceRoot, 'youtube-output');
    await runNodeCommand({
      args: [
        '--urls',
        'https://www.youtube.com/watch?v=demo123',
        '--output-dir',
        youtubeOutputDir,
      ],
      cwd: workspaceRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsDir,
        'youtube-research/scripts/run_youtube_video_collection.mjs',
      ),
    });
    const youtubeNormalized = JSON.parse(
      await readFile(resolve(youtubeOutputDir, 'normalized/posts.json'), 'utf8'),
    );
    assert.equal(youtubeNormalized.itemCount, 1);
    assert.equal(youtubeNormalized.items[0]?.platform, 'youtube');

    const imageAssetDir = resolve(workspaceRoot, 'image-asset');
    const imageRequestPath = resolve(workspaceRoot, 'image-request.json');
    await writeFile(
      imageRequestPath,
      JSON.stringify(
        {
          assetId: 'asset-1',
          enableBase64Output: true,
          localAssetDir: imageAssetDir,
          prompt: 'Generate an image',
          resolution: '2k',
          runId: 'image-run-1',
        },
        null,
        2,
      ),
    );
    const imageManifest = await runJsonNodeCommand({
      args: ['--request', imageRequestPath],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/image-batch-runner/scripts/generate_image.mjs',
      ),
    });
    assert.equal(imageManifest.assets.length, 1);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: ['--request', imageRequestPath],
          cwd: repoRoot,
          env: invalidAuthEnv,
          scriptPath: resolve(
            skillsRepoRoot,
            'skills/image-batch-runner/scripts/generate_image.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );

    const voiceRequestPath = resolve(workspaceRoot, 'voice-request.json');
    await writeFile(
      voiceRequestPath,
      JSON.stringify(
        {
          jobId: 'voice-run-1',
          localOutputDir: resolve(workspaceRoot, 'voice-output'),
          text: 'hello world',
          voiceDescription: 'calm narrator',
        },
        null,
        2,
      ),
    );
    const voiceManifest = await runJsonNodeCommand({
      args: ['--request', voiceRequestPath],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/voice-batch-runner/scripts/design_voice.mjs',
      ),
    });
    assert.equal(voiceManifest.audioPath.endsWith('.wav'), true);

    const videoRequestPath = resolve(workspaceRoot, 'video-request.json');
    await writeFile(
      videoRequestPath,
      JSON.stringify(
        {
          audio: 'https://example.com/audio.wav',
          image: 'https://example.com/image.png',
          jobId: 'video-run-1',
          localOutputDir: resolve(workspaceRoot, 'video-output'),
        },
        null,
        2,
      ),
    );
    const videoManifest = await runJsonNodeCommand({
      args: ['--request', videoRequestPath],
      cwd: repoRoot,
      env: scriptEnv,
      scriptPath: resolve(
        skillsRepoRoot,
        'skills/video-batch-runner/scripts/generate_video_from_image_audio.mjs',
      ),
    });
    assert.equal(videoManifest.assets.length, 1);

    await assert.rejects(
      () =>
        runNodeCommand({
          args: [
            '--actor',
            'clockworks/tiktok-scraper',
            '--input',
            tiktokResearchInputPath,
            '--output',
            resolve(workspaceRoot, '.postplus/tiktok-invalid-auth.json'),
          ],
          cwd: workspaceRoot,
          env: invalidAuthEnv,
          scriptPath: resolve(
            skillsDir,
            'tiktok-research/scripts/apify_actor_run.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /unauthorized|invalid session/i,
        );
        return true;
      },
    );
    activeScenario = 'missing-capability';
    await assert.rejects(
      () =>
        runNodeCommand({
          args: [
            '--plan',
            linkedinPlanPath,
            '--output-dir',
            resolve(workspaceRoot, 'linkedin-output-missing-capability'),
          ],
          cwd: workspaceRoot,
          env: scriptEnv,
          scriptPath: resolve(
            skillsDir,
            'linkedin-research/internal/brightdata/scripts/collect_public_posts.mjs',
          ),
        }),
      (error) => {
        assert.match(
          String(error.stderr ?? error.message ?? error),
          /Hosted Bright Data is not configured/,
        );
        return true;
      },
    );
    const chargeableFamilies = new Set(
      providerEvents
        .filter((event) => event.chargeable)
        .map((event) => event.family),
    );
    assert.deepEqual(
      [...chargeableFamilies].sort(),
      ['brightdata', 'wavespeed'],
    );

    assert.match(
      await readFile(resolve(skillsDir, 'tiktok-research/SKILL.md'), 'utf8'),
      /TikTok Research Skill/,
    );
    process.stdout.write('PostPlus CLI acceptance passed.\n');
  } finally {
    await new Promise((resolvePromise) =>
      server ? server.close(resolvePromise) : resolvePromise(),
    );
    await Promise.all(
      cleanupTargets.map((target) => rm(target, { recursive: true, force: true })),
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
