import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type ReadStream, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { refreshRemoteAuth, revokeRemoteAuth } from './auth-lifecycle.js';
import {
  CLI_AUTH_BROWSER_OPEN_TIMEOUT_MS,
  CLI_AUTH_LOGIN_POLL_BUDGET_MS,
  formatCloudAuthLoginPrompt,
  pollCloudAuthLogin,
  resolveCloudAuthBrowserCommand,
  startCloudAuthLogin,
} from './auth-login.js';
import {
  formatAuthValidateReport,
  validateRemoteAuth,
} from './auth-validate.js';
import { formatAuthStatusReport, generateAuthStatusReport } from './auth.js';
import {
  POSTPLUS_CLIENT_COMPATIBILITY_HEADERS,
  POSTPLUS_CLIENT_CONTRACT_VERSION,
  POSTPLUS_CLI_UPDATE_COMMAND,
  POSTPLUS_UPDATE_COMMAND,
  PostPlusClientUpgradeRequiredError,
  formatPostPlusClientUpgradeError,
} from './client-compatibility.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import {
  buildRunsListPath,
  fetchHostedBalance,
  fetchHostedRunDetail,
  fetchHostedRunsList,
  formatHostedBalanceReport,
  formatHostedRunDetailReport,
  formatHostedRunsListReport,
  parseRunsListOptions,
  runBalanceCommand,
  runRunsCommand,
} from './hosted-account-commands.js';
import { HostedQuoteConfirmationRequiredError } from './hosted-command-runtime.js';
import {
  runHostedDomainCommand,
  runMediaFileCommand,
  runWorkflowCommand,
} from './hosted-domain-commands.js';
import { runHostedRequest } from './hosted-lib.js';
import { HostedMediaTransferError, createMediaFileFingerprint, uploadHostedMediaFile } from './hosted-media-transfer.js';
import { buildHostedRequestSchemaReport } from './hosted-request-schemas.js';
import { generateLocalDependencyReport } from './local-dependencies.js';
import {
  readLocalConfig,
  setLocalSession,
  withPostPlusUpdateLock,
  writeLocalConfig,
  writeManagedSkillBaseline,
  readManagedSkillBaseline,
} from './local-state.js';
import {
  QuoteAutoConfirmCeilingExceededError,
  QuoteConfirmationNonInteractiveError,
  buildLargeCreditConfirmationPrompt,
  readLargeCreditQuoteConfirmationChallenge,
  resolveLargeCreditQuoteConfirmation,
} from './quote-confirmation.js';
import {
  POSTPLUS_SKILLS_AGENT_TARGETS,
  POSTPLUS_SKILLS_CATALOG_URL_ENV,
  POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND,
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  POSTPLUS_SKILLS_SOURCE_ENV,
  type PublicSkillRequirements,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import {
  buildPostPlusSkillUninstallArgs,
  buildPostPlusSkillUpdateArgs,
  formatSkillBaselineVerifyReport,
  generateSkillInstallStatusReport,
  runPostPlusSkillUninstall,
  runPostPlusSkillUpdate,
  runPostPlusSkillVerify,
} from './skill-management.js';
import {
  formatStatusReport,
  generateStatusReportWithDependencies,
} from './status.js';
import { resolveStudioRoot } from './studio.js';
import {
  POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV,
  POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV,
  generateUpdateStatusReport,
  resolvePostPlusUpdatePlan,
  runCliSelfUpdateIfOutdated,
  runPostPlusClientUpgradeRecovery,
} from './update-check.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const execFileAsync = promisify(execFile);
const CURRENT_CLI_VERSION = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
).version as string;
const NEXT_CLI_VERSION = CURRENT_CLI_VERSION.replace(
  /\.(\d+)$/,
  (_match, patch: string) => `.${Number(patch) + 1}`,
);

function createEmptySkillRequirements(): PublicSkillRequirements {
  return {
    accountConnections: [],
    capabilities: [],
    endpointKeys: [],
    localDependencies: [],
    modelKeys: [],
    routeKeys: [],
  };
}

function computeSingleFileGitTreeHash(
  fileName: string,
  content: string,
): string {
  const fileContent = Buffer.from(content);
  const blobHash = createHash('sha1')
    .update(`blob ${fileContent.length}\0`)
    .update(fileContent)
    .digest();
  const treeContent = Buffer.concat([
    Buffer.from(`100644 ${fileName}\0`),
    blobHash,
  ]);

  return createHash('sha1')
    .update(`tree ${treeContent.length}\0`)
    .update(treeContent)
    .digest('hex');
}

function isPublicCatalogUrl(url: string): boolean {
  return url.includes('PostPlusAI/postplus-skills/main/skills/catalog.json');
}

function createPublicCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'demo-skill',
          path: 'skills/demo-skill/SKILL.md',
          requirements: {
            localDependencies: [],
          },
          status: 'released',
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createPublicProductBrief() {
  return {
    schemaVersion: 1,
    paragraphs: [
      'Marketing should not begin with a maze of tools. It should begin with an ambition.',
      'PostPlus gives individuals and lean teams the operating power of a much larger marketing organization.',
    ],
  };
}

function createVideoAnalysisCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'media-analysis',
          path: 'skills/media-analysis/SKILL.md',
          requirements: {
            capabilities: ['media'],
            modelKeys: ['video-analysis'],
            localDependencies: [],
          },
          status: 'released',
        },
        {
          name: 'image-batch-runner',
          path: 'skills/image-batch-runner/SKILL.md',
          requirements: {
            endpointKeys: ['image-bad'],
            capabilities: ['media'],
            localDependencies: [],
          },
          status: 'released',
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createSocialPublishingCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'social-media-publisher',
          path: 'skills/50-publishing/social-media-publisher/SKILL.md',
          requirements: {
            accountConnections: ['social-publishing-workspace'],
            capabilities: ['publishing'],
            localDependencies: [],
          },
          status: 'released',
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createWhoamiResponse(): Response {
  return new Response(
    JSON.stringify({
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      sessionExpiresAt: 1_900_000_000,
      subscriptionStatus: 'active',
      userEmail: 'user@example.com',
      userId: 'user-1',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function buildLargeCreditChallenge(input: {
  requiredTierMillicredits: number;
}) {
  return {
    accountId: 'account-1',
    action: 'generate',
    billingUnit: 'credit',
    drivers: [
      { key: 'duration', label: 'Duration', value: 10 },
      { key: 'resolution', label: 'Resolution', value: '1080p' },
    ],
    estimatedCredits: 288,
    estimatedMillicredits: 288_000,
    estimatedOnly: true,
    featureLabel: 'Video generation',
    operationId: 'operation-1',
    requiredTierCredits: input.requiredTierMillicredits / 1_000,
    requiredTierMillicredits: input.requiredTierMillicredits,
    reservedCredits: 432,
    reservedMillicredits: 432_000,
    serviceLabel: 'Media generation service',
    token: `token-${input.requiredTierMillicredits}`,
  };
}

function createMediaReadinessResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      subscriptionActive: true,
      subscriptionStatus: 'active',
      capabilities: [
        {
          id: 'media-file:create-upload-url',
          label: 'Media file: create-upload-url',
          mediaFileOperation: 'create-upload-url',
          ok: true,
          required: true,
        },
        {
          id: 'media-file:download-to-storage',
          label: 'Media file: download-to-storage',
          mediaFileOperation: 'download-to-storage',
          ok: true,
          required: true,
        },
        {
          id: 'video-analysis:video-analysis',
          label: 'Video analysis: video-analysis',
          modelKey: 'video-analysis',
          ok: true,
          required: true,
        },
        {
          checks: [
            {
              id: 'provider_configuration',
              label: 'Provider configuration',
              ok: false,
              required: true,
            },
          ],
          id: 'media-generation:image-bad',
          label: 'Media generation: image-bad',
          ok: false,
          required: true,
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createSocialPublishingReadinessResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      subscriptionActive: false,
      subscriptionStatus: null,
      capabilities: [
        {
          checks: [
            {
              id: 'subscription',
              label: 'PostPlus subscription',
              ok: false,
              required: false,
            },
          ],
          id: 'social-publishing:list-channels',
          label: 'Social publishing: list-channels',
          ok: true,
          operation: 'list-channels',
          required: true,
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createYoutubeResearchCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 2,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'youtube-research',
          path: 'skills/20-research/youtube-research/SKILL.md',
          requirements: {
            routeKeys: [
              'youtube-channel-summary',
              'youtube-comments',
              'youtube-video-download',
              'youtube-videos',
            ],
            capabilities: ['research'],
            localDependencies: [],
          },
          status: 'released',
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function createYoutubeResearchReadinessResponse(): Response {
  const okCapability = (
    id: string,
    label: string,
    extra: Record<string, unknown>,
  ) => ({ id, label, ok: true, required: true, ...extra });

  return new Response(
    JSON.stringify({
      ok: true,
      subscriptionActive: true,
      subscriptionStatus: 'active',
      capabilities: [
        okCapability(
          'hosted-collection:youtube-channel-summary',
          'Hosted collection: youtube-channel-summary',
          { collectionKey: 'youtube-channel-summary' },
        ),
        okCapability(
          'hosted-collection:youtube-comments',
          'Hosted collection: youtube-comments',
          { collectionKey: 'youtube-comments' },
        ),
        okCapability(
          'hosted-collection:youtube-video-download',
          'Hosted collection: youtube-video-download',
          { collectionKey: 'youtube-video-download' },
        ),
        okCapability(
          'public-content-collection:youtube-videos',
          'Public content source: youtube-videos',
          { sourceKey: 'youtube-videos' },
        ),
        // The discovery surface emits a tool-suffixed id with no requirement-key
        // binding; requiring the bare `public-content-discovery` family must match it.
        okCapability(
          'public-content-discovery:web-search',
          'Public content discovery: web-search',
          { toolKey: 'web-search' },
        ),
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

const subscriptionStatusCases: {
  name: string;
  payload: Record<string, unknown>;
  expectedLabel: string;
}[] = [
  {
    name: 'null',
    payload: {
      subscriptionStatus: null,
    },
    expectedLabel: 'none',
  },
  {
    name: 'missing',
    payload: {},
    expectedLabel: 'unknown',
  },
  {
    name: 'invalid',
    payload: {
      subscriptionStatus: 42,
    },
    expectedLabel: 'invalid',
  },
  {
    name: 'string',
    payload: {
      subscriptionStatus: 'trialing',
    },
    expectedLabel: 'trialing',
  },
];

async function withMockedSubscriptionStatusCloud<T>(
  testCase: (typeof subscriptionStatusCases)[number],
  callback: () => Promise<T>,
): Promise<T> {
  await setLocalSession({
    cliSessionToken: 'cli-session-token-value',
    accountId: 'account-1',
    accountName: 'Team Workspace',
    accountSlug: 'team-workspace',
    accountType: 'team',
    apiBaseUrl: 'https://postplus.example.com',
    sessionExpiresAt: 1_900_000_000,
    userEmail: 'user@example.com',
    userId: 'user-1',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (isPublicCatalogUrl(url)) {
      return createPublicCatalogResponse();
    }

    if (url.endsWith('/api/postplus-cli/auth/whoami')) {
      return new Response(
        JSON.stringify({
          accountId: 'account-1',
          accountName: 'Team Workspace',
          accountSlug: 'team-workspace',
          accountType: 'team',
          sessionExpiresAt: 1_900_000_000,
          ...testCase.payload,
          userEmail: 'user@example.com',
          userId: 'user-1',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
      return new Response(
        JSON.stringify({
          ok: true,
          subscriptionActive: testCase.payload.subscriptionStatus !== null,
          ...testCase.payload,
          capabilities: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected url' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function selfUpdateInstallationFixture() {
  const installationRoot = resolve(
    await realpath(process.env.POSTPLUS_CONFIG_DIR!),
    'node_modules',
  );
  const currentCliEntryPath = resolve(
    installationRoot,
    '@postplus/cli/build/index.js',
  );
  await mkdir(resolve(installationRoot, '@postplus/cli/build'), {
    recursive: true,
  });
  await writeFile(currentCliEntryPath, '// isolated package entry fixture\n');
  await writeFile(
    resolve(installationRoot, '@postplus/cli/package.json'),
    JSON.stringify({ version: CURRENT_CLI_VERSION }),
  );
  return {
    currentCliEntryPath,
    runCommand: async (_command: string, args: string[]) => ({
      stdout:
        args[0] === 'view'
          ? JSON.stringify(NEXT_CLI_VERSION)
          : installationRoot,
      stderr: '',
    }),
  };
}

async function generateFixtureUpdateStatus(input: { force?: boolean } = {}) {
  return generateUpdateStatusReport(input, {
    fetchFn: globalThis.fetch,
    runCommand: async (_command, args) => ({
      stdout:
        args[0] === 'view'
          ? JSON.stringify(CURRENT_CLI_VERSION)
          : 'https://registry.fixture.invalid/',
      stderr: '',
    }),
  });
}

async function tinyVideoFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'postplus-google-video-'));
  tempDirs.push(directory);
  const filePath = resolve(directory, 'clip.mp4');
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=32x32:r=10',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '0.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-y',
    filePath,
  ]);
  return { filePath, bytes: await readFile(filePath) };
}

function withGoogleVideoUpload(
  next: typeof fetch,
  fixture: { filePath: string; bytes: Buffer },
): typeof fetch {
  const uploadUrl =
    'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=local-test';
  let operationId: string | undefined;
  let uploads = 0;
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.has('x-goog-api-key'),
      false,
      'the CLI never receives a Google key',
    );
    if (String(url) === uploadUrl) {
      assert.equal(init?.method, 'POST');
      assert.equal(headers.get('x-goog-upload-command'), 'upload, finalize');
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as unknown as ReadStream)
        chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), fixture.bytes);
      uploads++;
      assert.equal(uploads, 1);
      return Response.json({ file: { name: 'files/local-test' } });
    }
    const body = JSON.parse(String(init?.body));
    assert.notEqual(
      body.capability,
      'media-file',
      'video analysis must not stage to PostPlus Storage',
    );
    if (body.operation === 'prepare-upload') {
      assert.equal(body.capability, 'video-analysis');
      assert.equal(operationId, undefined, 'one upload preparation per call');
      operationId = body.operationId;
      assert.equal(body.input.metadata.bytes, fixture.bytes.length);
      assert.equal(
        body.input.metadata.sha256,
        createHash('sha256').update(fixture.bytes).digest('hex'),
      );
      assert.equal(body.input.metadata.hasVideo, true);
      assert.equal(body.input.metadata.hasAudio, true);
      return Response.json({
        output: {
          uploadUrl,
          uploadToken: 'sealed-test-token',
          expiresAt: Date.now() + 60_000,
        },
      });
    }
    if (body.operation === 'analyze') {
      assert.equal(body.operationId, operationId);
      assert.equal(
        body.input.video,
        'postplus-video://sealed-test-token/files/local-test',
      );
      assert.equal(uploads, 1);
    }
    return next(url, init);
  };
}

beforeEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  const configDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-test-'));
  const stateDir = await mkdtemp(resolve(tmpdir(), 'postplus-skills-state-'));
  tempDirs.push(configDir);
  tempDirs.push(stateDir);
  process.env.POSTPLUS_CONFIG_DIR = configDir;
  process.env.HOME = configDir;
  process.env.USERPROFILE = configDir;
  // The test host declares proxy variables; production Node requires this at
  // process start. Unit requests are mocked, and this keeps them aligned with
  // the explicit transport preflight contract.
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.XDG_STATE_HOME = stateDir;
});

after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe('doctor and status', () => {
  it('reports PostPlus Cloud auth readiness with skill and update state', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer cli-session-token-value',
        );
        assert.equal(
          (init?.headers as Record<string, string>)[
            POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.cliVersion
          ],
          CURRENT_CLI_VERSION,
        );
        assert.equal(
          (init?.headers as Record<string, string>)[
            POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.contractVersion
          ],
          String(POSTPLUS_CLIENT_CONTRACT_VERSION),
        );
        assert.equal(
          (init?.headers as Record<string, string>)[
            POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.runtime
          ],
          'postplus-cli',
        );

        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            sessionExpiresAt: 1_900_000_000,
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return new Response(
          JSON.stringify({
            ok: true,
            subscriptionActive: true,
            subscriptionStatus: 'active',
            capabilities: [
              {
                id: 'media-generation',
                label: 'Hosted media generation',
                ok: true,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateSkillStatus: async () => ({
          ok: true,
          error: null,
          installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
          installedCount: 2,
          managedSkillsReleaseId: 'catalog-1',
          missingSkills: [],
          requiredCount: 2,
          retiredManagedSkills: [],
          scopes: ['project'],
          source: 'PostPlusAI/postplus-skills',
          updateCommand: 'postplus update',
          uninstallCommand: 'postplus uninstall',
        }),
        generateUpdateStatus: async () => ({
          checkedAt: '2026-04-29T00:00:00.000Z',
          ok: true,
          source: 'remote',
          cli: {
            currentVersion: CURRENT_CLI_VERSION,
            latestVersion: CURRENT_CLI_VERSION,
            updateAvailable: false,
            updateCommand: 'npm install -g @postplus/cli@latest',
          },
          skills: {
            currentReleaseId: 'abc123',
            latestReleaseId: 'abc123',
            updateAvailable: false,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      assert.equal(status.schemaVersion, 1);
      assert.equal((await readLocalConfig())?.cliVersion, CURRENT_CLI_VERSION);
      assert.equal(status.ok, true);
      assert.equal(status.doctor.schemaVersion, 3);
      assert.equal(status.auth.ok, true);
      assert.equal(status.doctor.ok, true);
      assert.equal(status.skills.ok, true);
      assert.match(formatStatusReport(status), /PostPlus CLI status/);
      assert.match(formatStatusReport(status), /PostPlus skills status/);
      assert.match(formatStatusReport(status), /PostPlus update status/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not promote an old account baseline from matching names during status', async () => {
    await writeLocalConfig({
      apiBaseUrl: 'https://postplus.example.com',
      accountId: 'account-1',
      cliSessionToken: 'cli-session-token-value',
      managedSkills: {
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      },
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const fakeBinDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-bin-'));
    tempDirs.push(fakeBinDir);
    await mkdir(fakeBinDir, { recursive: true });
    const fakeNpxPath = resolve(fakeBinDir, 'npx');
    await writeFile(
      fakeNpxPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === '-y skills list --json') {
  console.log(JSON.stringify([{ agents: ['Codex'], name: 'demo-skill', path: '/project/demo-skill', scope: 'project' }]));
  process.exit(0);
}
if (args === '-y skills list --json --global') {
  console.log(JSON.stringify([{ agents: ['Codex'], name: 'demo-skill', path: '/global/demo-skill', scope: 'global' }]));
  process.exit(0);
}
console.error('Unexpected npx args: ' + args);
process.exit(1);
`,
      {
        encoding: 'utf8',
        mode: 0o755,
      },
    );
    process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ''}`;

    const originalFetch = globalThis.fetch;
    const hostedSkillsReleaseIds: (string | undefined)[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            releaseId: 'catalog-2',
            source: 'PostPlusAI/postplus-skills',
            skills: [
              {
                name: 'demo-skill',
                path: 'skills/demo-skill/SKILL.md',
                requirements: {
                  localDependencies: [],
                },
                status: 'released',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        const headers = init?.headers as Record<string, string>;
        const skillsReleaseId =
          headers[POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillsReleaseId];
        hostedSkillsReleaseIds.push(skillsReleaseId);

        if (skillsReleaseId !== 'catalog-2') {
          return new Response(
            JSON.stringify({
              code: 'postplus_client_upgrade_required',
              error: 'Your PostPlus CLI or PostPlus skills are out of date.',
              compatibility: {
                upgrade: {
                  cli: { command: 'npm install -g @postplus/cli@latest' },
                  skills: { command: 'postplus update' },
                  restartAgentSession: true,
                },
              },
            }),
            {
              status: 409,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            subscriptionActive: true,
            subscriptionStatus: 'active',
            capabilities: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateUpdateStatus: generateFixtureUpdateStatus,
      });

      assert.equal(status.ok, false);
      assert.equal(status.skills.managedSkillsReleaseId, null);
      assert.deepEqual(status.skills.scopes, ['global']);
      assert.equal(status.updates.skills.currentReleaseId, null);
      assert.equal(status.updates.skills.latestReleaseId, 'catalog-2');
      assert.equal(status.updates.skills.updateAvailable, true);
      assert.deepEqual(hostedSkillsReleaseIds, [undefined]);
      assert.equal(
        (await readManagedSkillBaseline())?.releaseId,
        null,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports inactive subscriptions without failing hosted readiness', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            sessionExpiresAt: 1_900_000_000,
            subscriptionStatus: null,
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return new Response(
          JSON.stringify({
            ok: true,
            subscriptionActive: false,
            subscriptionStatus: null,
            capabilities: [
              {
                id: 'media-generation',
                label: 'Hosted media generation',
                ok: true,
                required: true,
              },
              {
                id: 'social-publishing',
                label: 'Hosted social publishing',
                ok: true,
                required: false,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateSkillStatus: async () => ({
          ok: true,
          error: null,
          installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
          installedCount: 2,
          managedSkillsReleaseId: 'catalog-1',
          missingSkills: [],
          requiredCount: 2,
          retiredManagedSkills: [],
          scopes: ['project'],
          source: 'PostPlusAI/postplus-skills',
          updateCommand: 'postplus update',
          uninstallCommand: 'postplus uninstall',
        }),
        generateUpdateStatus: async () => ({
          checkedAt: '2026-04-29T00:00:00.000Z',
          ok: true,
          source: 'cache',
          cli: {
            currentVersion: '0.1.12',
            latestVersion: '0.1.13',
            updateAvailable: true,
            updateCommand: POSTPLUS_UPDATE_COMMAND,
          },
          skills: {
            currentReleaseId: 'abc123',
            latestReleaseId: 'def456',
            updateAvailable: true,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      const formatted = formatStatusReport(status);

      assert.equal(status.ok, true);
      assert.match(formatted, /subscription none/);
      assert.doesNotMatch(formatted, /subscription unknown/);
      assert.doesNotMatch(formatted, /Not ready: subscription/);
      assert.match(formatted, /postplus update/);
      assert.doesNotMatch(formatted, /npm install -g @postplus\/cli/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const testCase of subscriptionStatusCases) {
    it(`renders ${testCase.name} subscription status in doctor output`, async () => {
      await withMockedSubscriptionStatusCloud(testCase, async () => {
        const formatted = formatDoctorReport(await generateDoctorReport());

        assert.match(
          formatted,
          new RegExp(
            `Remote auth: Team Workspace \\(team\\); account account-1; user user@example.com; subscription ${testCase.expectedLabel}`,
          ),
        );
        assert.match(
          formatted,
          new RegExp(
            `Hosted capabilities: Ready \\(0 capability checks passed; subscription ${testCase.expectedLabel}\\)`,
          ),
        );
      });
    });

    it(`renders ${testCase.name} subscription status in auth validate output`, async () => {
      await withMockedSubscriptionStatusCloud(testCase, async () => {
        const formatted = formatAuthValidateReport(await validateRemoteAuth());

        assert.match(
          formatted,
          new RegExp(`Subscription: ${testCase.expectedLabel}`),
        );
      });
    });

    it(`renders ${testCase.name} subscription status in status output`, async () => {
      await withMockedSubscriptionStatusCloud(testCase, async () => {
        const status = await generateStatusReportWithDependencies({
          generateSkillStatus: async () => ({
            ok: true,
            error: null,
            installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
            installedCount: 1,
            managedSkillsReleaseId: 'catalog-1',
            missingSkills: [],
            requiredCount: 1,
            retiredManagedSkills: [],
            scopes: ['global'],
            source: 'PostPlusAI/postplus-skills',
            updateCommand: 'postplus update',
            uninstallCommand: 'postplus uninstall',
          }),
          generateUpdateStatus: async () => ({
            checkedAt: '2026-04-29T00:00:00.000Z',
            ok: true,
            source: 'cache',
            cli: {
              currentVersion: '0.1.28',
              latestVersion: '0.1.28',
              updateAvailable: false,
              updateCommand: 'npm install -g @postplus/cli@latest',
            },
            skills: {
              currentReleaseId: 'catalog-1',
              latestReleaseId: 'catalog-1',
              updateAvailable: false,
              updateCommand: 'postplus update',
            },
            warning: null,
          }),
        });
        const formatted = formatStatusReport(status);

        assert.equal(status.ok, true);
        assert.match(
          formatted,
          new RegExp(`subscription ${testCase.expectedLabel}`),
        );
      });
    });
  }

  it('fails fast when auth validate receives an invalid success payload', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            accountId: null,
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () => validateRemoteAuth(),
        /accountId must be a non-empty string/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces server upgrade guidance in status output', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            code: 'postplus_client_upgrade_required',
            error: 'Your PostPlus CLI or PostPlus skills are out of date.',
            compatibility: {
              schemaVersion: 2,
              upgrade: {
                command: 'postplus update',
                cli: {
                  command: 'npm install -g @postplus/cli@latest',
                  required: true,
                },
                restartAgentSession: true,
                skills: {
                  command: 'postplus update',
                  required: false,
                },
              },
            },
          }),
          {
            status: 426,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateSkillStatus: async () => ({
          ok: true,
          error: null,
          installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
          installedCount: 1,
          managedSkillsReleaseId: 'catalog-1',
          missingSkills: [],
          requiredCount: 1,
          retiredManagedSkills: [],
          scopes: ['global'],
          source: 'PostPlusAI/postplus-skills',
          updateCommand: 'postplus update',
          uninstallCommand: 'postplus uninstall',
        }),
        generateUpdateStatus: async () => ({
          checkedAt: '2026-04-29T00:00:00.000Z',
          ok: true,
          source: 'remote',
          cli: {
            currentVersion: '0.1.28',
            latestVersion: '0.1.28',
            updateAvailable: false,
            updateCommand: 'npm install -g @postplus/cli@latest',
          },
          skills: {
            currentReleaseId: 'catalog-1',
            latestReleaseId: 'catalog-1',
            updateAvailable: false,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      const formatted = formatStatusReport(status);
      const compatibilityCheck = status.doctor.checks.find(
        (check) => check.id === 'client_compatibility',
      );

      assert.equal(status.ok, false);
      assert.equal(compatibilityCheck?.label, 'Client compatibility');
      assert.match(formatted, /postplus update/);
      assert.match(formatted, /restart your agent session/i);
      assert.doesNotMatch(formatted, /npm install -g @postplus\/cli/);
      assert.doesNotMatch(formatted, /postplus auth login/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces cloud release progress without upgrade commands in status output', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            code: 'postplus_cli_cloud_release_in_progress',
            error:
              'PostPlus Cloud is updating. Please retry in about one minute.',
          }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json',
              'retry-after': '60',
            },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateSkillStatus: async () => ({
          ok: true,
          error: null,
          installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
          installedCount: 1,
          managedSkillsReleaseId: 'catalog-1',
          missingSkills: [],
          requiredCount: 1,
          retiredManagedSkills: [],
          scopes: ['global'],
          source: 'PostPlusAI/postplus-skills',
          updateCommand: 'postplus update',
          uninstallCommand: 'postplus uninstall',
        }),
        generateUpdateStatus: async () => ({
          checkedAt: '2026-04-29T00:00:00.000Z',
          ok: true,
          source: 'remote',
          cli: {
            currentVersion: '0.1.28',
            latestVersion: '0.1.28',
            updateAvailable: false,
            updateCommand: 'npm install -g @postplus/cli@latest',
          },
          skills: {
            currentReleaseId: 'catalog-1',
            latestReleaseId: 'catalog-1',
            updateAvailable: false,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      const formatted = formatStatusReport(status);
      const compatibilityCheck = status.doctor.checks.find(
        (check) => check.id === 'client_compatibility',
      );

      assert.equal(status.ok, false);
      assert.equal(compatibilityCheck?.label, 'Client compatibility');
      assert.match(formatted, /PostPlus Cloud is updating/);
      assert.doesNotMatch(compatibilityCheck?.detail ?? '', /postplus update/);
      assert.doesNotMatch(formatted, /npm install -g @postplus\/cli/);
      assert.doesNotMatch(formatted, /postplus auth login/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('classifies hosted readiness compatibility failures separately from auth', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return new Response(
          JSON.stringify({
            code: 'postplus_client_upgrade_required',
            error: 'Your PostPlus skills are out of date.',
            compatibility: {
              schemaVersion: 2,
              upgrade: {
                command: POSTPLUS_UPDATE_COMMAND,
                cli: {
                  command: POSTPLUS_CLI_UPDATE_COMMAND,
                  required: false,
                },
                restartAgentSession: true,
                skills: {
                  command: POSTPLUS_UPDATE_COMMAND,
                  required: true,
                },
              },
            },
          }),
          {
            status: 426,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport();
      const formatted = formatDoctorReport(report);
      const remoteAuthCheck = report.checks.find(
        (check) => check.id === 'remote_auth',
      );
      const compatibilityCheck = report.checks.find(
        (check) => check.id === 'client_compatibility',
      );

      assert.equal(remoteAuthCheck?.status, 'pass');
      assert.equal(compatibilityCheck?.status, 'fail');
      assert.equal(
        report.checks.some((check) => check.id === 'hosted_capabilities'),
        false,
      );
      assert.match(formatted, /postplus update/);
      assert.doesNotMatch(formatted, /postplus auth login/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps status usable when only task-specific local dependencies are missing', async () => {
    const status = await generateStatusReportWithDependencies({
      generateDoctor: async () => ({
        schemaVersion: 3,
        ok: false,
        requiredOk: true,
        checks: [
          {
            id: 'local_dependencies',
            label: 'Task-specific local media dependencies',
            status: 'fail',
            severity: 'task_specific',
            detail: 'Missing 1/2: ffmpeg for media-analysis',
            fix: 'Run the affected PostPlus skill in a local agent.',
            metadata: {
              bootstrapRule: 'postplus-shared',
              missingDependencies: [
                {
                  dependency: 'ffmpeg',
                  detail: 'not found',
                  skillIds: ['media-analysis'],
                },
              ],
            },
          },
        ],
      }),
      generateAuthStatus: async () => ({
        ok: true,
        cliSessionToken: {
          source: 'config',
          present: true,
          maskedValue: 'abc',
        },
        apiBaseUrl: {
          source: 'default',
          present: true,
          value: 'https://postplus.io',
        },
        config: {
          path: '/tmp/postplus/config.json',
          exists: true,
          accountId: 'account-1',
          accountName: 'Team Workspace',
          accountSlug: 'team-workspace',
          accountType: 'team',
          sessionExpiresAt: 1_900_000_000,
          userEmail: 'user@example.com',
          userId: 'user-1',
        },
      }),
      generateSkillStatus: async () => ({
        ok: true,
        error: null,
        installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
        installedCount: 1,
        managedSkillsReleaseId: 'catalog-1',
        missingSkills: [],
        requiredCount: 1,
        retiredManagedSkills: [],
        scopes: ['global'],
        source: 'PostPlusAI/postplus-skills',
        updateCommand: 'postplus update',
        uninstallCommand: 'postplus uninstall',
      }),
      generateUpdateStatus: async () => ({
        checkedAt: '2026-04-29T00:00:00.000Z',
        ok: true,
        source: 'cache',
        cli: {
          currentVersion: '0.1.19',
          latestVersion: '0.1.19',
          updateAvailable: false,
          updateCommand: 'npm install -g @postplus/cli@latest',
        },
        skills: {
          currentReleaseId: 'catalog-1',
          latestReleaseId: 'catalog-1',
          updateAvailable: false,
          updateCommand: 'postplus update',
        },
        warning: null,
      }),
    });

    const formatted = formatStatusReport(status);

    assert.equal(status.ok, true);
    assert.equal(status.doctor.ok, false);
    assert.equal(status.doctor.requiredOk, true);
    assert.match(
      formatted,
      /Overall: OK \(task-specific checks need attention\)/,
    );
    assert.match(formatted, /\[WARN\] Task-specific local media dependencies/);
    assert.match(
      formatted,
      /Doctor incomplete: task-specific checks need attention\./,
    );
  });

  it('formats nested hosted readiness check failures', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return new Response(
          JSON.stringify({
            ok: false,
            subscriptionActive: true,
            subscriptionStatus: 'active',
            capabilities: [
              {
                checks: [
                  {
                    id: 'provider_configuration',
                    label: 'Provider configuration',
                    ok: false,
                    required: true,
                  },
                ],
                id: 'media-generation:image-nano-banana-2-text',
                label: 'Media generation: image-nano-banana-2-text',
                ok: false,
                required: true,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport();
      const formatted = formatDoctorReport(report);

      assert.equal(report.schemaVersion, 3);
      assert.equal(report.ok, false);
      assert.match(
        formatted,
        /Media generation: image-nano-banana-2-text \(Provider configuration\)/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces degraded field-level readiness without failing required checks', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return new Response(
          JSON.stringify({
            ok: true,
            degraded: true,
            schemaVersion: 2,
            subscriptionActive: true,
            subscriptionStatus: 'active',
            capabilities: [
              {
                checks: [
                  {
                    id: 'released_surface',
                    label: 'Released surface',
                    ok: true,
                    status: 'degraded',
                    required: true,
                  },
                ],
                degraded: true,
                id: 'media-generation:image-nano-banana-2-text',
                label: 'Media generation: image-nano-banana-2-text',
                ok: true,
                required: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport();
      const formatted = formatDoctorReport(report);

      const hostedCheck = report.checks.find(
        (check) => check.id === 'hosted_capabilities',
      );
      assert.ok(hostedCheck);
      // Degraded surfaces distinctly but does not fail the required gate.
      assert.equal(hostedCheck.status, 'degraded');
      assert.equal(report.requiredOk, true);
      assert.equal(report.ok, false);
      assert.match(
        formatted,
        /\[DEGRADED\] Hosted capabilities: Ready with field-level coverage gaps: Media generation: image-nano-banana-2-text \(Released surface\)/,
      );
      assert.match(formatted, /known field-level coverage gaps/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters skill-scoped hosted readiness to the selected skill requirements', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createVideoAnalysisCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return createMediaReadinessResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport({ skillId: 'media-analysis' });
      const formatted = formatDoctorReport(report);

      assert.equal(report.skillId, 'media-analysis');
      assert.equal(report.ok, true);
      assert.equal(report.requiredOk, true);
      assert.match(formatted, /Hosted capabilities for media-analysis/);
      assert.doesNotMatch(formatted, /Media generation: image-bad/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('matches social publishing operation readiness to the social publishing skill', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createSocialPublishingCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return createSocialPublishingReadinessResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport({
        skillId: 'social-media-publisher',
      });
      const formatted = formatDoctorReport(report);

      assert.equal(report.skillId, 'social-media-publisher');
      assert.equal(report.ok, false);
      assert.equal(report.requiredOk, false);
      assert.match(
        formatted,
        /PostPlus Plus or Pro plan required; current subscription none/,
      );
      assert.doesNotMatch(formatted, /readiness check missing/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('matches public-content-discovery readiness to a skill that requires the discovery family', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createYoutubeResearchCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return createYoutubeResearchReadinessResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport({
        skillId: 'youtube-research',
      });
      const formatted = formatDoctorReport(report);

      // The discovery family row is matched, so doctor must not report it missing.
      assert.doesNotMatch(formatted, /readiness check missing/);
      assert.match(formatted, /Hosted capabilities for youtube-research/);
      assert.equal(report.ok, true);
      assert.equal(report.requiredOk, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps global status OK when unrelated hosted readiness is not ready', async () => {
    await setLocalSession({
      cliSessionToken: 'cli-session-token-value',
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createVideoAnalysisCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return createWhoamiResponse();
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        return createMediaReadinessResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const status = await generateStatusReportWithDependencies({
        generateSkillStatus: async () => ({
          ok: true,
          error: null,
          installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
          installedCount: 2,
          managedSkillsReleaseId: 'catalog-1',
          missingSkills: [],
          requiredCount: 2,
          retiredManagedSkills: [],
          scopes: ['global'],
          source: 'PostPlusAI/postplus-skills',
          updateCommand: 'postplus update',
          uninstallCommand: 'postplus uninstall',
        }),
        generateUpdateStatus: async () => ({
          checkedAt: '2026-04-29T00:00:00.000Z',
          ok: true,
          source: 'cache',
          cli: {
            currentVersion: '0.1.28',
            latestVersion: '0.1.28',
            updateAvailable: false,
            updateCommand: 'npm install -g @postplus/cli@latest',
          },
          skills: {
            currentReleaseId: 'catalog-1',
            latestReleaseId: 'catalog-1',
            updateAvailable: false,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      const formatted = formatStatusReport(status);

      assert.equal(status.ok, true);
      assert.equal(status.doctor.ok, false);
      assert.equal(status.doctor.requiredOk, true);
      assert.match(
        formatted,
        /Overall: OK \(task-specific checks need attention\)/,
      );
      assert.match(formatted, /\[WARN\] Hosted capabilities/);
      assert.match(formatted, /Media generation: image-bad/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails with an actionable error for unknown skill ids', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createVideoAnalysisCatalogResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () => generateDoctorReport({ skillId: 'missing-skill' }),
        /Unknown PostPlus skill: missing-skill.*postplus list/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('doctor fails fast until the user signs in', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport();
      const formatted = formatDoctorReport(report);

      assert.equal(report.schemaVersion, 3);
      assert.equal(report.ok, false);
      assert.match(formatted, /PostPlus Cloud/);
      assert.match(formatted, /postplus auth login/);
      assert.doesNotMatch(formatted, /skills add/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('auth status remains incomplete until the user signs in', async () => {
    const report = await generateAuthStatusReport();

    assert.equal(report.ok, false);
    assert.equal(report.cliSessionToken.present, false);
  });

  it('does not accept legacy Supabase token config as CLI auth', async () => {
    await writeLocalConfig({
      accessToken: 'legacy-access-token',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'legacy-refresh-token',
    });

    await assert.rejects(() => validateRemoteAuth(), /postplus auth login/);
  });

  it('shows CLI session expiry in auth status output', async () => {
    await setLocalSession({
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      cliSessionToken: 'cli-session-token-value',
      sessionExpiresAt: Math.floor(Date.now() / 1_000) + 3600,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const formatted = formatAuthStatusReport(await generateAuthStatusReport());

    assert.match(formatted, /Workspace: Team Workspace \(team\)/);
    assert.match(formatted, /Workspace slug: team-workspace/);
    assert.match(formatted, /Account ID: account-1/);
    assert.match(formatted, /Expires:/);
  });

  it('uses account wording for personal CLI auth status output', async () => {
    await setLocalSession({
      accountId: 'user-1',
      accountName: 'Personal Account',
      accountSlug: null,
      accountType: 'personal',
      apiBaseUrl: 'https://postplus.example.com',
      cliSessionToken: 'cli-session-token-value',
      sessionExpiresAt: Math.floor(Date.now() / 1_000) + 3600,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const formatted = formatAuthStatusReport(await generateAuthStatusReport());

    assert.match(formatted, /Account: Personal Account/);
    assert.match(formatted, /Account ID: user-1/);
    assert.doesNotMatch(formatted, /Workspace:/);
    assert.doesNotMatch(formatted, /Workspace slug:/);
  });

  it('keeps an environment API override process-local and binds the session to its origin', async () => {
    await writeLocalConfig({ apiBaseUrl: 'https://postplus.example.com' });
    process.env.POSTPLUS_API_BASE_URL = 'https://staging.postplus.example.com';
    await setLocalSession({
      accountId: 'account-staging',
      accountName: 'Staging',
      accountSlug: null,
      accountType: 'team',
      apiBaseUrl: 'https://staging.postplus.example.com',
      cliSessionToken: 'staging-session',
      sessionExpiresAt: null,
      userEmail: 'user@example.com',
      userId: 'user-1',
      persistApiBaseUrl: false,
    });
    const stagedConfig = await readLocalConfig();
    assert.equal(stagedConfig?.apiBaseUrl, 'https://postplus.example.com');
    assert.equal(
      stagedConfig?.sessionApiBaseUrl,
      'https://staging.postplus.example.com',
    );

    delete process.env.POSTPLUS_API_BASE_URL;
    await assert.rejects(
      () => validateRemoteAuth(),
      /session belongs to https:\/\/staging\.postplus\.example\.com, but this process targets https:\/\/postplus\.example\.com/u,
    );
  });

  it('fails immediately when proxy variables exist but Node environment proxy support is disabled', async () => {
    await setLocalSession({
      accountId: 'account-1',
      accountName: 'Account',
      accountSlug: null,
      accountType: 'personal',
      apiBaseUrl: 'https://postplus.example.com',
      cliSessionToken: 'session',
      sessionExpiresAt: null,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    // Keep this contract hermetic: hosted runners can define NO_PROXY entries
    // that would otherwise (correctly) exempt the synthetic test origin.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.NODE_USE_ENV_PROXY;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    };
    try {
      await assert.rejects(() => validateRemoteAuth(), /NODE_USE_ENV_PROXY=1/u);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes a rejected CLI session before doctor checks remote auth', async () => {
    process.env.POSTPLUS_ACCESS_TOKEN = 'stale-env-access-token';
    process.env.POSTPLUS_REFRESH_TOKEN = 'stale-env-refresh-token';
    await setLocalSession({
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      cliSessionToken: 'cli-session-token-value',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    let readinessCount = 0;
    let refreshCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (isPublicCatalogUrl(url)) {
        return createPublicCatalogResponse();
      }

      if (url.endsWith('/api/postplus-cli/auth/refresh')) {
        refreshCount += 1;
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          refreshCount === 1
            ? 'Bearer cli-session-token-value'
            : 'Bearer cli-session-token-refreshed',
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {});

        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            cliSessionToken: 'cli-session-token-refreshed',
            sessionExpiresAt: Math.floor(Date.now() / 1_000) + 3600,
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          requestedUrls.filter((value) =>
            value.endsWith('/api/postplus-cli/auth/whoami'),
          ).length === 1
            ? 'Bearer cli-session-token-value'
            : 'Bearer cli-session-token-refreshed',
        );

        if (
          requestedUrls.filter((value) =>
            value.endsWith('/api/postplus-cli/auth/whoami'),
          ).length === 1
        ) {
          return new Response(JSON.stringify({ error: 'expired' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/postplus-cli/hosted/readiness')) {
        readinessCount += 1;
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          readinessCount === 1
            ? 'Bearer cli-session-token-value'
            : 'Bearer cli-session-token-refreshed',
        );

        if (readinessCount === 1) {
          return new Response(JSON.stringify({ error: 'expired' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            ok: true,
            subscriptionActive: true,
            subscriptionStatus: 'active',
            capabilities: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateDoctorReport();
      const config = await readLocalConfig();

      assert.equal(report.ok, true);
      assert.deepEqual(
        requestedUrls.filter((url) => !isPublicCatalogUrl(url)),
        [
          'https://postplus.example.com/api/postplus-cli/auth/whoami',
          'https://postplus.example.com/api/postplus-cli/auth/refresh',
          'https://postplus.example.com/api/postplus-cli/auth/whoami',
          'https://postplus.example.com/api/postplus-cli/hosted/readiness',
          'https://postplus.example.com/api/postplus-cli/auth/refresh',
          'https://postplus.example.com/api/postplus-cli/hosted/readiness',
        ],
      );
      assert.equal(config?.cliSessionToken, 'cli-session-token-refreshed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes a rejected CLI session before auth validate', async () => {
    await setLocalSession({
      accountId: 'account-1',
      accountName: 'Team Workspace',
      accountSlug: 'team-workspace',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.example.com',
      cliSessionToken: 'cli-session-token-value',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const originalFetch = globalThis.fetch;
    let whoamiCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);

      if (url.endsWith('/api/postplus-cli/auth/refresh')) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer cli-session-token-value',
        );

        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            cliSessionToken: 'cli-session-token-refreshed',
            sessionExpiresAt: Math.floor(Date.now() / 1_000) + 3600,
            subscriptionStatus: 'active',
            userEmail: 'user@example.com',
            userId: 'user-1',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      assert.equal(
        url,
        'https://postplus.example.com/api/postplus-cli/auth/whoami',
      );
      whoamiCount += 1;
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        whoamiCount === 1
          ? 'Bearer cli-session-token-value'
          : 'Bearer cli-session-token-refreshed',
      );

      if (whoamiCount === 1) {
        return new Response(JSON.stringify({ error: 'expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          accountId: 'account-1',
          accountName: 'Team Workspace',
          accountSlug: 'team-workspace',
          accountType: 'team',
          subscriptionStatus: 'active',
          userEmail: 'user@example.com',
          userId: 'user-1',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const report = await validateRemoteAuth();

      assert.equal(report.ok, true);
      assert.equal(report.accountId, 'account-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('cloud auth handoff', () => {
  async function runLoginAgainstMockServer(
    options: {
      args?: string[];
      browser?: 'success' | 'failure' | 'timeout';
      loseAcknowledgement?: boolean;
      losePollResponse?: boolean;
      acknowledgementFailure?: 'lost' | 'expired';
      terminal?:
        | 'cancelled'
        | 'expired'
        | 'malformed'
        | 'missing-expiry'
        | 'invalid-session';
      verificationUrl?: string;
    } = {},
  ) {
    const fixtureDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-auth-browser-'),
    );
    tempDirs.push(fixtureDir);
    const openerLog = resolve(fixtureDir, 'opened.json');
    const preloadPath = resolve(fixtureDir, 'browser.mjs');
    // Intercept only the OS opener. Start, poll and whoami still use real HTTP
    // in the CLI child, and timeout exercises a real bounded child process.
    await writeFile(
      preloadPath,
      `
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command !== 'postplus-test-browser') {
    return originalSpawn(command, args, options);
  }
  writeFileSync(process.env.POSTPLUS_TEST_OPENER_LOG, JSON.stringify({ command, args, options }));
  const mode = process.env.POSTPLUS_TEST_OPENER_MODE;
  const source = mode === 'timeout'
    ? 'setInterval(() => {}, 1000)'
    : mode === 'failure' ? 'process.exit(1)' : '';
  return originalSpawn(process.execPath, ['-e', source], options);
};
syncBuiltinESMExports();
`,
    );

    const requests: { path: string; body: string; authorization?: string }[] =
      [];
    const account = {
      accountId: 'account-1',
      accountName: 'Personal Workspace',
      accountSlug: null,
      accountType: 'personal',
      sessionExpiresAt: 1_900_000_000,
      subscriptionStatus: 'active',
      userEmail: 'user@example.com',
      userId: 'user-1',
    };
    let baseUrl: string;
    let pollCount = 0;
    let acknowledgementCount = 0;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url ?? '',
        body,
        authorization: request.headers.authorization,
      });
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      switch (request.url) {
        case '/api/postplus-cli/auth/login/start':
          reply(200, {
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            pollIntervalSeconds: 1,
            pollSecret: 'poll-secret',
            requestId: 'request-1',
            userCode: '123456',
            verificationUrl:
              options.verificationUrl ??
              `${baseUrl}/auth/cli-login?requestId=request-1&userCode=123456`,
          });
          break;
        case '/api/postplus-cli/auth/login/poll':
          pollCount += 1;
          if (
            options.terminal === 'cancelled' ||
            options.terminal === 'expired'
          ) {
            reply(410, { error: `Login request ${options.terminal}.` });
          } else if (options.terminal === 'malformed') {
            reply(200, { status: 'completed' });
          } else if (options.terminal === 'missing-expiry') {
            reply(200, {
              ...account,
              status: 'completed',
              cliSessionToken: 'cli-session-token-value',
              sessionExpiresAt: undefined,
            });
          } else if (options.losePollResponse && pollCount === 2) {
            response.destroy();
          } else if (pollCount === 1) {
            reply(202, { status: 'pending' });
          } else {
            reply(200, {
              ...account,
              status: 'completed',
              cliSessionToken: 'cli-session-token-value',
            });
          }
          break;
        case '/api/postplus-cli/auth/login/acknowledge':
          acknowledgementCount++;
          assert.equal(
            (await readLocalConfig())?.cliSessionToken,
            'cli-session-token-value',
            'CLI must atomically save before activation',
          );
          assert.deepEqual(JSON.parse(body), {
            requestId: 'request-1',
            pollSecret: 'poll-secret',
            cliSessionToken: 'cli-session-token-value',
          });
          if (options.acknowledgementFailure === 'expired') {
            reply(410, { error: 'Login request expired.' });
          } else if (
            options.acknowledgementFailure === 'lost' ||
            (options.loseAcknowledgement && acknowledgementCount === 1)
          ) {
            response.destroy();
          } else {
            reply(200, { ok: true });
          }
          break;
        case '/api/postplus-cli/auth/whoami':
          if (options.terminal === 'invalid-session') {
            reply(401, { error: 'Session validation failed.' });
          } else {
            reply(200, account);
          }
          break;
        default:
          reply(404, { error: 'Unexpected request.' });
      }
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      ({ stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          '--import',
          pathToFileURL(preloadPath).href,
          '--import',
          'tsx',
          'src/index.ts',
          'auth',
          'login',
          ...(options.args ?? []),
        ],
        {
          env: {
            ...process.env,
            POSTPLUS_API_BASE_URL: baseUrl,
            POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND: 'postplus-test-browser',
            POSTPLUS_TEST_OPENER_LOG: openerLog,
            POSTPLUS_TEST_OPENER_MODE: options.browser ?? 'success',
            NO_PROXY: '*',
          },
          timeout: 20_000,
        },
      ));
    } catch (error) {
      const failed = error as Error & {
        code?: number;
        stdout: string;
        stderr: string;
      };
      if (typeof failed.code !== 'number') throw error;
      exitCode = failed.code;
      stdout = failed.stdout;
      stderr = failed.stderr;
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
    const opener = await readFile(openerLog, 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    return { stdout, stderr, exitCode, opener, requests, baseUrl };
  }

  it('keeps the CLI login fallback poll budget at 30 minutes', () => {
    assert.equal(CLI_AUTH_LOGIN_POLL_BUDGET_MS, 30 * 60 * 1000);
  });

  it('prints auth login help without starting browser sign-in', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'auth',
      'login',
      '--help',
    ]);

    assert.match(stdout, /postplus auth login/u);
    assert.doesNotMatch(stdout, /auth\/cli-login/u);
    assert.doesNotMatch(stdout, /Waiting for approval/u);
    assert.match(stdout, /--no-browser/u);
  });

  it('starts a cloud sign-in request without binding a local bridge', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.example.com/api/postplus-cli/auth/login/start',
      );
      assert.equal(init?.method, 'POST');

      return new Response(
        JSON.stringify({
          expiresAt: '2026-04-30T09:00:00.000Z',
          pollIntervalSeconds: 3,
          pollSecret: 'poll-secret',
          requestId: 'request-1',
          userCode: '123456',
          verificationUrl:
            'https://postplus.example.com/auth/cli-login?requestId=request-1&userCode=123456',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const started = await startCloudAuthLogin('https://postplus.example.com');

      assert.equal(started.requestId, 'request-1');
      assert.equal(started.pollSecret, 'poll-secret');
      assert.equal(started.userCode, '123456');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves typed upgrade rejection only before an authorization request starts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_client_upgrade_required',
          error: 'Update required.',
        }),
        { status: 426 },
      );
    try {
      await assert.rejects(
        startCloudAuthLogin('https://postplus.example.com'),
        PostPlusClientUpgradeRequiredError,
      );
      await assert.rejects(
        pollCloudAuthLogin({
          apiBaseUrl: 'https://postplus.example.com',
          requestId: 'existing-request',
          pollSecret: 'existing-secret',
        }),
        (error: unknown) =>
          error instanceof Error &&
          !(error instanceof PostPlusClientUpgradeRequiredError),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-object start responses with a product error instead of a TypeError', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const payload of [null, 'unexpected', 42]) {
        globalThis.fetch = async () => new Response(JSON.stringify(payload));
        await assert.rejects(
          startCloudAuthLogin('https://postplus.example.com'),
          /PostPlus CLI sign-in start returned incomplete data/u,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders the real cloud sign-in URL without a separate code challenge', () => {
    assert.equal(
      formatCloudAuthLoginPrompt({
        verificationUrl:
          'https://postplus.example.com/auth/cli-login?requestId=request-1&userCode=123456',
      }),
      [
        'Opening browser for authentication...',
        'If browser does not open, visit:',
        'https://postplus.example.com/auth/cli-login?requestId=request-1&userCode=123456',
        '',
      ].join('\n'),
    );
  });

  it('uses the native browser opener on macOS, Windows, and desktop Linux', () => {
    const url =
      'https://postplus.example.com/auth/cli-login?requestId=1&userCode=123456';
    assert.deepEqual(resolveCloudAuthBrowserCommand(url, 'darwin', {}), {
      command: 'open',
      args: [url],
    });
    assert.deepEqual(resolveCloudAuthBrowserCommand(url, 'win32', {}), {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
    for (const env of [{ DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }]) {
      assert.deepEqual(resolveCloudAuthBrowserCommand(url, 'linux', env), {
        command: 'xdg-open',
        args: [url],
      });
    }
    assert.equal(resolveCloudAuthBrowserCommand(url, 'linux', {}), null);
    assert.equal(resolveCloudAuthBrowserCommand(url, 'aix', {}), null);
    assert.deepEqual(
      resolveCloudAuthBrowserCommand(url, 'linux', {
        POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND: 'custom-browser',
      }),
      { command: 'custom-browser', args: [url] },
    );
  });

  it('rejects non-web protocols and control characters before opening a browser', () => {
    for (const url of [
      'file:///tmp/file',
      'javascript:alert(1)',
      'not a URL',
      'https://example.com/\n',
    ]) {
      assert.throws(
        () => resolveCloudAuthBrowserCommand(url, 'darwin', {}),
        /invalid browser URL/u,
      );
    }
  });

  it('opens the browser, saves before acknowledgement, then validates before success', async () => {
    const result = await runLoginAgainstMockServer();
    const url = `${result.baseUrl}/auth/cli-login?requestId=request-1&userCode=123456`;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'Opening browser for authentication...',
        'If browser does not open, visit:',
        url,
        'Waiting for approval...',
        'Successfully authenticated.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(result.opener.args, [url]);
    assert.equal(result.opener.options.shell, false);
    assert.equal(result.opener.options.stdio, 'ignore');
    assert.equal(
      result.opener.options.timeout,
      CLI_AUTH_BROWSER_OPEN_TIMEOUT_MS,
    );
    assert.deepEqual(
      result.requests.map((r) => r.path),
      [
        '/api/postplus-cli/auth/login/start',
        '/api/postplus-cli/auth/login/poll',
        '/api/postplus-cli/auth/login/poll',
        '/api/postplus-cli/auth/login/acknowledge',
        '/api/postplus-cli/auth/whoami',
      ],
    );
    assert.deepEqual(JSON.parse(result.requests[1]!.body), {
      pollSecret: 'poll-secret',
      requestId: 'request-1',
    });
    assert.equal(
      result.requests[4]!.authorization,
      'Bearer cli-session-token-value',
    );
    assert.equal(
      (await readLocalConfig())?.cliSessionToken,
      'cli-session-token-value',
    );
    assert.doesNotMatch(result.stdout, /Code:|poll-secret|cli-session-token/u);
  });

  it('repeats the same saved delivery acknowledgement after a lost response without starting another login', async () => {
    const result = await runLoginAgainstMockServer({
      loseAcknowledgement: true,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.requests.filter((r) => r.path.endsWith('/start')).length,
      1,
    );
    const acknowledgements = result.requests.filter((r) =>
      r.path.endsWith('/acknowledge'),
    );
    assert.equal(acknowledgements.length, 2);
    assert.equal(acknowledgements[0]!.body, acknowledgements[1]!.body);
    assert.match(result.stdout, /Successfully authenticated/u);
  });

  it('retries a lost poll response on the same request before saving and acknowledging', async () => {
    const result = await runLoginAgainstMockServer({ losePollResponse: true });
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.requests.filter((r) => r.path.endsWith('/start')).length,
      1,
    );
    const polls = result.requests.filter((r) => r.path.endsWith('/poll'));
    assert.equal(polls.length, 3);
    assert.equal(polls[1]!.body, polls[2]!.body);
    assert.equal(
      result.requests.filter((r) => r.path.endsWith('/acknowledge')).length,
      1,
    );
  });

  for (const acknowledgementFailure of ['lost', 'expired'] as const) {
    it(`does not report successful login or restart authorization after acknowledgement ${acknowledgementFailure}`, async () => {
      const result = await runLoginAgainstMockServer({
        acknowledgementFailure,
      });
      assert.equal(result.exitCode, 1);
      assert.doesNotMatch(result.stdout, /Successfully authenticated/u);
      assert.equal(
        result.requests.filter((r) => r.path.endsWith('/start')).length,
        1,
      );
      assert.equal(
        result.requests.filter((r) => r.path.endsWith('/acknowledge')).length,
        acknowledgementFailure === 'lost' ? 2 : 1,
      );
      assert.equal(
        result.requests.filter((r) => r.path.endsWith('/whoami')).length,
        0,
      );
      assert.equal(
        (await readLocalConfig())?.cliSessionToken,
        'cli-session-token-value',
        'saved credential must not be deleted after an ambiguous response',
      );
      if (acknowledgementFailure === 'lost')
        assert.match(result.stderr, /auth validate/u);
    });
  }

  for (const browser of ['failure', 'timeout'] as const) {
    it(`keeps cloud polling usable after browser ${browser}`, async () => {
      const result = await runLoginAgainstMockServer({ browser });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Could not open a browser automatically/u);
      assert.ok(
        result.stdout.includes(
          `${result.baseUrl}/auth/cli-login?requestId=request-1&userCode=123456`,
        ),
      );
      assert.match(
        result.stdout,
        /Waiting for approval\.\.\.\nSuccessfully authenticated\.\n$/u,
      );
      assert.equal(
        (await readLocalConfig())?.cliSessionToken,
        'cli-session-token-value',
      );
    });
  }

  it('prints the link and completes authorization without an opener when --no-browser is set', async () => {
    const result = await runLoginAgainstMockServer({ args: ['--no-browser'] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.opener, null);
    assert.match(
      result.stdout,
      /^Open this URL in your browser to connect PostPlus:/u,
    );
    assert.ok(
      result.stdout.includes(
        `${result.baseUrl}/auth/cli-login?requestId=request-1&userCode=123456`,
      ),
    );
    assert.doesNotMatch(result.stdout, /Opening browser|Could not open/u);
    assert.match(result.stdout, /Successfully authenticated/u);
  });

  for (const terminal of [
    'cancelled',
    'expired',
    'malformed',
    'missing-expiry',
    'invalid-session',
  ] as const) {
    it(`does not report success for a ${terminal} login`, async () => {
      const result = await runLoginAgainstMockServer({ terminal });
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /Waiting for approval/u);
      assert.doesNotMatch(result.stdout, /Successfully authenticated/u);
      assert.ok(result.stderr.trim().length > 0);
      if (terminal !== 'invalid-session') {
        assert.equal(
          result.requests.filter((r) => r.path.endsWith('/acknowledge')).length,
          0,
        );
      }
      assert.equal(
        (await readLocalConfig())?.cliSessionToken ?? null,
        terminal === 'invalid-session' ? 'cli-session-token-value' : null,
      );
    });
  }

  it('rejects unsafe server login URLs even when --no-browser is used', async () => {
    const result = await runLoginAgainstMockServer({
      args: ['--no-browser'],
      verificationUrl: 'file:///tmp/browser',
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid browser URL/u);
    assert.equal(result.requests.length, 1);
    assert.equal(result.opener, null);
    assert.equal(await readLocalConfig(), null);
  });

  it('continues rejecting unknown login flags before starting auth', async () => {
    const result = await runLoginAgainstMockServer({
      args: ['--no-browser', '--json'],
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown auth login option: --json/u);
    assert.equal(result.requests.length, 0);
    assert.equal(result.opener, null);
  });

  it('polls a completed cloud sign-in request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.example.com/api/postplus-cli/auth/login/poll',
      );
      assert.equal(init?.method, 'POST');

      return new Response(
        JSON.stringify({
          accountId: 'account-1',
          accountName: 'Team Workspace',
          accountSlug: 'team-workspace',
          accountType: 'team',
          cliSessionToken: 'cli-session-token-value',
          sessionExpiresAt: 1_900_000_000,
          status: 'completed',
          subscriptionStatus: 'active',
          userEmail: 'user@example.com',
          userId: 'user-1',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const completed = await pollCloudAuthLogin({
        apiBaseUrl: 'https://postplus.example.com',
        pollSecret: 'poll-secret',
        requestId: 'request-1',
      });

      assert.equal(completed.status, 'completed');
      assert.equal(completed.cliSessionToken, 'cli-session-token-value');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps pending cloud sign-in requests pollable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });

    try {
      const pending = await pollCloudAuthLogin({
        apiBaseUrl: 'https://postplus.example.com',
        pollSecret: 'poll-secret',
        requestId: 'request-1',
      });

      assert.equal(pending.status, 'pending');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('public skill catalog', () => {
  it('loads and parses the public skill catalog', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-1',
          releaseNotes: {
            schemaVersion: 1,
            releaseId: 'catalog-1',
            title: 'A smoother PostPlus update',
            summary: 'Agents can continue routine work after updating.',
            highlights: ['One bounded retry after a safe update.'],
          },
          productBrief: createPublicProductBrief(),
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              requirements: {
                routeKeys: ['facebook-post-by-url', 'instagram-posts'],
                endpointKeys: ['image-demo'],
                capabilities: ['media', 'research'],
                localDependencies: ['ffmpeg', 'python3:yt_dlp'],
                modelKeys: ['video-analysis'],
              },
              status: 'released',
            },
            {
              name: 'second-skill',
              path: 'skills/second-skill/SKILL.md',
              status: 'released/router',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      const catalog = await loadPublicSkillCatalog();

      assert.equal(catalog.source, 'PostPlusAI/postplus-skills');
      assert.equal(catalog.releaseId, 'catalog-1');
      assert.deepEqual(catalog.releaseNotes, {
        schemaVersion: 1,
        releaseId: 'catalog-1',
        title: 'A smoother PostPlus update',
        summary: 'Agents can continue routine work after updating.',
        highlights: ['One bounded retry after a safe update.'],
      });
      assert.deepEqual(catalog.productBrief, createPublicProductBrief());
      assert.equal(catalog.installCommand, POSTPLUS_SKILLS_INSTALL_COMMAND);
      assert.deepEqual(catalog.skills, [
        {
          localDependencies: ['ffmpeg', 'python3:yt_dlp'],
          requirements: {
            ...createEmptySkillRequirements(),
            capabilities: ['media', 'research'],
            endpointKeys: ['image-demo'],
            localDependencies: ['ffmpeg', 'python3:yt_dlp'],
            modelKeys: ['video-analysis'],
            routeKeys: ['facebook-post-by-url', 'instagram-posts'],
          },
          skillId: 'demo-skill',
          path: 'skills/demo-skill/SKILL.md',
        },
        {
          localDependencies: [],
          requirements: createEmptySkillRequirements(),
          skillId: 'second-skill',
          path: 'skills/second-skill/SKILL.md',
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill catalog metadata is invalid', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ schemaVersion: 1, skills: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /metadata is invalid/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects release notes that belong to a different skills release', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-current',
          releaseNotes: {
            schemaVersion: 1,
            releaseId: 'catalog-previous',
            title: 'Old notes',
            summary: 'These notes must not describe the current update.',
            highlights: ['Stale release detail.'],
          },
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /invalid release notes/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an empty product brief', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-current',
          productBrief: { schemaVersion: 1, paragraphs: [] },
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /invalid product brief/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill catalog exposes private routing requirements', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-private-routing',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              requirements: {
                collectionKeys: ['facebook-posts'],
              },
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /unsupported requirements: collectionKeys/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill catalog uses a non-semantic capability', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-private-capability',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              requirements: {
                capabilities: ['hosted-collection'],
              },
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /unsupported capabilities/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails with a catalog-specific error when the catalog endpoint returns HTML', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<!DOCTYPE html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /returned HTML instead of JSON/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill catalog has an empty release list', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-1',
          source: 'PostPlusAI/postplus-skills',
          skills: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /no released skills were found/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('can load a staged public skill catalog without reading production main', async () => {
    const originalFetch = globalThis.fetch;
    const stagedCatalogUrl =
      'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/fde913331ef113e3a3eb1065b45faff614136608/skills/catalog.json';
    process.env[POSTPLUS_SKILLS_CATALOG_URL_ENV] = stagedCatalogUrl;
    process.env[POSTPLUS_SKILLS_SOURCE_ENV] =
      'PostPlusAI/postplus-skills#fde913331ef113e3a3eb1065b45faff614136608';
    globalThis.fetch = async (url) => {
      assert.equal(url, stagedCatalogUrl);

      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'skills-1-a9d5f9215864e899',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const catalog = await loadPublicSkillCatalog();

      assert.equal(catalog.catalogUrl, stagedCatalogUrl);
      assert.equal(
        catalog.source,
        'PostPlusAI/postplus-skills#fde913331ef113e3a3eb1065b45faff614136608',
      );
      assert.match(
        catalog.installCommand,
        /PostPlusAI\/postplus-skills#fde913331ef113e3a3eb1065b45faff614136608/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('local dependency diagnostics', () => {
  it('reports missing dependencies from the public skill catalog for agent bootstrap', async () => {
    const calls: string[][] = [];
    const report = await generateLocalDependencyReport({
      loadCatalog: async () => ({
        catalogUrl: 'https://example.com/skills/catalog.json',
        installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
        listCommand: 'npx -y skills add PostPlusAI/postplus-skills --list',
        releaseId: 'catalog-1',
        source: 'PostPlusAI/postplus-skills',
        skills: [
          {
            localDependencies: ['ffmpeg', 'python3:yt_dlp'],
            path: 'skills/demo-skill/SKILL.md',
            requirements: {
              ...createEmptySkillRequirements(),
              localDependencies: ['ffmpeg', 'python3:yt_dlp'],
            },
            skillId: 'demo-skill',
          },
          {
            localDependencies: ['ffmpeg', 'ffprobe'],
            path: 'skills/second-skill/SKILL.md',
            requirements: {
              ...createEmptySkillRequirements(),
              localDependencies: ['ffmpeg', 'ffprobe'],
            },
            skillId: 'second-skill',
          },
        ],
      }),
      runDependencyCheck: async (command, args) => {
        calls.push([command, ...args]);

        if (command === 'python3') {
          throw new Error('module not found');
        }
      },
    });

    assert.equal(report.ok, false);
    assert.equal(report.requiredCount, 3);
    assert.deepEqual(calls, [
      ['ffmpeg', '-version'],
      ['ffprobe', '-version'],
      ['python3', '-c', 'import importlib; importlib.import_module("yt_dlp")'],
    ]);
    assert.deepEqual(report.checks, [
      {
        dependency: 'ffmpeg',
        detail: 'available',
        ok: true,
        skillIds: ['demo-skill', 'second-skill'],
      },
      {
        dependency: 'ffprobe',
        detail: 'available',
        ok: true,
        skillIds: ['second-skill'],
      },
      {
        dependency: 'python3:yt_dlp',
        detail: 'module not found',
        ok: false,
        skillIds: ['demo-skill'],
      },
    ]);
  });
});

describe('update checks', () => {
  it('formats one user-facing compatibility recovery command', () => {
    const formatted = formatPostPlusClientUpgradeError({
      code: 'postplus_client_upgrade_required',
      error: 'Your PostPlus CLI is out of date.',
      compatibility: {
        upgrade: {
          command: POSTPLUS_UPDATE_COMMAND,
          cli: {
            command: POSTPLUS_CLI_UPDATE_COMMAND,
            required: true,
          },
          restartAgentSession: true,
          skills: {
            command: POSTPLUS_UPDATE_COMMAND,
            required: false,
          },
        },
      },
    });

    assert.match(formatted, /Run: postplus update\./);
    assert.match(formatted, /restart your agent session/);
    assert.doesNotMatch(formatted, /npm install -g/);
  });

  it('uses one maintenance command for component-only compatibility payloads', () => {
    const formatted = formatPostPlusClientUpgradeError({
      compatibility: {
        upgrade: {
          cli: {
            command: POSTPLUS_CLI_UPDATE_COMMAND,
            required: true,
          },
          skills: {
            command: POSTPLUS_UPDATE_COMMAND,
            required: true,
          },
        },
      },
    });

    assert.equal(formatted.match(/postplus update/g)?.length, 1);
    assert.doesNotMatch(formatted, /npm install -g/);
  });

  it('defaults explicit updates to both components and honors a CLI-only recovery', () => {
    assert.deepEqual(resolvePostPlusUpdatePlan({}), {
      cli: true,
      implicitRecovery: false,
      skills: true,
    });
    assert.deepEqual(
      resolvePostPlusUpdatePlan({
        [POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV]: '1',
        [POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV]: 'cli',
      }),
      {
        cli: true,
        implicitRecovery: true,
        skills: false,
      },
    );
  });

  it('serializes concurrent update mutations with one local lock', async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const run = (name: string) =>
      withPostPlusUpdateLock(
        async () => {
          order.push(`${name}:start`);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          order.push(`${name}:end`);
        },
        { pollMs: 2, timeoutMs: 1_000 },
      );

    await Promise.all([run('first'), run('second')]);

    assert.equal(maximumActive, 1);
    assert.equal(order.length, 4);
    const firstOwner = order[0]?.split(':')[0];
    const secondOwner = order[2]?.split(':')[0];
    assert.equal(order[1], `${firstOwner}:end`);
    assert.equal(order[3], `${secondOwner}:end`);
    assert.notEqual(firstOwner, secondOwner);
  });

  it('recovers an update lock left by a process that no longer exists', async () => {
    const lockPath = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'update.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      resolve(lockPath, 'owner.json'),
      `${JSON.stringify({ pid: 2_147_483_647 })}\n`,
    );
    let called = false;

    await withPostPlusUpdateLock(
      async () => {
        called = true;
      },
      { pollMs: 1, timeoutMs: 100 },
    );

    assert.equal(called, true);
    await assert.rejects(() => readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  });

  for (const staleOwnerFile of ['owner.json', 'owner-1234-abcd.json']) {
    it(`preserves the new lock when two processes reclaim stale ${staleOwnerFile}`, async () => {
      const configDir = process.env.POSTPLUS_CONFIG_DIR!;
      const lockPath = resolve(configDir, 'update.lock');
      await mkdir(lockPath);
      await writeFile(
        resolve(lockPath, staleOwnerFile),
        JSON.stringify({ pid: 2_147_483_647 }),
      );
      const results = await Promise.allSettled(
        ['first', 'second'].map((role) =>
          promisify(execFile)(
            process.execPath,
            [
              '--import',
              'tsx',
              resolve('src/fixtures/update-lock-race.mjs'),
              role,
              pathToFileURL(resolve('src/local-state.ts')).href,
              staleOwnerFile,
            ],
            { env: { ...process.env }, timeout: 10_000 },
          ),
        ),
      );
      for (const [index, result] of results.entries()) {
        assert.equal(
          result.status,
          'fulfilled',
          result.status === 'rejected' ? String(result.reason) : undefined,
        );
        if (result.status !== 'fulfilled') continue;
        assert.match(result.value.stdout, /observed-dead-owner/u);
        assert.match(result.value.stdout, /exit=0/u);
        if (index === 0)
          assert.match(result.value.stdout, /new-owner-preserved/u);
        else
          assert.match(result.value.stdout, /stale-cleanup-after-new-owner/u);
        process.stdout.write(result.value.stdout);
      }
      await assert.rejects(() => readdir(lockPath), { code: 'ENOENT' });
      assert.deepEqual(
        (await readdir(configDir)).filter((name) =>
          name.startsWith('.update-'),
        ),
        [],
      );
    });
  }

  it('keeps a live update lock and removes only the timed-out contender staging directory', async () => {
    const configDir = process.env.POSTPLUS_CONFIG_DIR!;
    await withPostPlusUpdateLock(async () => {
      const ownerFiles = await readdir(resolve(configDir, 'update.lock'));
      await assert.rejects(
        withPostPlusUpdateLock(
          async () => {
            assert.fail('a live owner must exclude a second update');
          },
          { pollMs: 1, timeoutMs: 10 },
        ),
        /Another PostPlus update is still running/u,
      );
      assert.deepEqual(
        await readdir(resolve(configDir, 'update.lock')),
        ownerFiles,
      );
      assert.deepEqual(
        (await readdir(configDir)).filter((name) =>
          name.startsWith('.update-'),
        ),
        [],
      );
    });
  });

  it('releases the update lock when the mutation fails', async () => {
    await assert.rejects(
      withPostPlusUpdateLock(async () => {
        throw new Error('update failed');
      }),
      /update failed/u,
    );
    await withPostPlusUpdateLock(async () => {});
  });

  it('waits for an active old-format owner instead of replacing its lock', async () => {
    const configDir = process.env.POSTPLUS_CONFIG_DIR!;
    const lockPath = resolve(configDir, 'update.lock');
    await mkdir(lockPath);
    const owner = JSON.stringify({ pid: process.pid });
    await writeFile(resolve(lockPath, 'owner.json'), owner);
    await assert.rejects(
      withPostPlusUpdateLock(
        async () => {
          assert.fail(
            'a running old-version update still owns the installation',
          );
        },
        { pollMs: 1, timeoutMs: 10 },
      ),
      /Another PostPlus update is still running/u,
    );
    assert.equal(
      await readFile(resolve(lockPath, 'owner.json'), 'utf8'),
      owner,
    );
  });

  it('does not remove unexpected files from the shared update lock', async () => {
    const lockPath = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'update.lock');
    await mkdir(lockPath);
    await writeFile(resolve(lockPath, 'unrelated.json'), 'keep');
    await assert.rejects(
      withPostPlusUpdateLock(async () => {
        assert.fail('unknown lock contents must not be destroyed');
      }),
      /unexpected contents/u,
    );
    assert.equal(
      await readFile(resolve(lockPath, 'unrelated.json'), 'utf8'),
      'keep',
    );
  });

  it('updates and retries the rejected command once without asking the user', async () => {
    const calls: Array<{
      args: string[];
      command: string;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const output: string[] = [];
    const originalArgs = [
      'media',
      'analyze',
      'video-analysis',
      '--video',
      './demo.mov',
      '--prompt',
      'Analyze it',
    ];

    const result = await runPostPlusClientUpgradeRecovery(
      {
        originalArgs,
        payload: {
          code: 'postplus_client_upgrade_required',
          compatibility: {
            upgrade: {
              cli: { required: true },
              skills: { required: true },
            },
          },
        },
      },
      {
        environment: { PATH: '/tmp/postplus-bin' },
        runInteractiveCommand: async (command, args, options = {}) => {
          calls.push({ command, args, env: options.env });
          return 0;
        },
        writeError: (message) => output.push(message),
        writeOutput: (message) => output.push(message),
      },
    );

    const recoveryEnv = {
      PATH: '/tmp/postplus-bin',
      [POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV]: '1',
      [POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV]: 'all',
    };
    assert.deepEqual(result, {
      attempted: true,
      exitCode: 0,
      restartAgentSessionRequired: false,
      updateExitCode: 0,
    });
    assert.deepEqual(calls, [
      { command: 'postplus', args: ['update'], env: recoveryEnv },
      { command: 'postplus', args: originalArgs, env: recoveryEnv },
    ]);
    assert.match(
      output.join(''),
      /updating\. The current task can resume only if the update succeeds/u,
    );
    assert.doesNotMatch(output.join(''), /Retrying the original command/u);
  });

  it('carries a component-scoped recovery plan into the update process', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const result = await runPostPlusClientUpgradeRecovery(
      {
        originalArgs: ['media', 'schema', '--json'],
        payload: {
          code: 'postplus_client_upgrade_required',
          compatibility: {
            upgrade: {
              skills: { required: true },
            },
          },
        },
      },
      {
        environment: {},
        runInteractiveCommand: async (_command, args, options = {}) => {
          calls.push({ args, env: options.env });
          return 0;
        },
        writeError: () => {},
        writeOutput: () => {},
      },
    );

    assert.equal(
      calls[0]?.env?.[POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV],
      'skills',
    );
    assert.deepEqual(resolvePostPlusUpdatePlan(calls[0]?.env), {
      cli: false,
      implicitRecovery: true,
      skills: true,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.exitCode, 0);
  });

  it('updates but does not replay when the compatibility change requires a new agent session', async () => {
    const calls: string[][] = [];
    const errors: string[] = [];
    const result = await runPostPlusClientUpgradeRecovery(
      {
        originalArgs: ['media', 'schema', '--json'],
        payload: {
          code: 'postplus_client_upgrade_required',
          compatibility: {
            upgrade: {
              restartAgentSession: true,
              skills: { required: true },
            },
          },
        },
      },
      {
        runInteractiveCommand: async (command, args) => {
          calls.push([command, ...args]);
          return 0;
        },
        writeError: (message) => errors.push(message),
        writeOutput: () => {},
      },
    );

    assert.deepEqual(calls, [['postplus', 'update']]);
    assert.deepEqual(result, {
      attempted: true,
      exitCode: 1,
      restartAgentSessionRequired: true,
      updateExitCode: 0,
    });
    assert.match(errors.join(''), /requires a new agent session/u);
  });

  it('stops a second compatibility recovery attempt without looping', async () => {
    let commandCalled = false;
    const errors: string[] = [];

    const result = await runPostPlusClientUpgradeRecovery(
      {
        originalArgs: ['media', 'schema', '--json'],
        payload: { code: 'postplus_client_upgrade_required' },
      },
      {
        environment: { [POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV]: '1' },
        runInteractiveCommand: async () => {
          commandCalled = true;
          return 0;
        },
        writeError: (message) => errors.push(message),
        writeOutput: () => {},
      },
    );

    assert.deepEqual(result, {
      attempted: false,
      exitCode: 1,
      restartAgentSessionRequired: false,
      updateExitCode: null,
    });
    assert.equal(commandCalled, false);
    assert.match(errors.join(''), /after one automatic update and retry/u);
  });

  it('does not retry the original command when automatic update fails', async () => {
    const calls: string[][] = [];
    const result = await runPostPlusClientUpgradeRecovery(
      {
        originalArgs: ['media', 'schema', '--json'],
        payload: { code: 'postplus_client_upgrade_required' },
      },
      {
        runInteractiveCommand: async (command, args) => {
          calls.push([command, ...args]);
          return 23;
        },
        writeError: () => {},
        writeOutput: () => {},
      },
    );

    assert.deepEqual(calls, [['postplus', 'update']]);
    assert.deepEqual(result, {
      attempted: true,
      exitCode: 23,
      restartAgentSessionRequired: false,
      updateExitCode: 23,
    });
  });

  it('propagates the updated CLI continuation exit code', async () => {
    let callCount = 0;
    const result = await runCliSelfUpdateIfOutdated({
      ...(await selfUpdateInstallationFixture()),
      runInteractiveCommand: async () => {
        callCount += 1;
        return callCount === 1 ? 0 : 17;
      },
      writeOutput: () => {},
    });

    assert.equal(callCount, 2);
    assert.equal(result.exitCode, 17);
  });

  it('self-updates the CLI before any skills catalog read when npm latest is newer', async () => {
    const installation = await selfUpdateInstallationFixture();
    const calls: {
      args: string[];
      command: string;
      env?: NodeJS.ProcessEnv;
    }[] = [];
    const output: string[] = [];
    const result = await runCliSelfUpdateIfOutdated({
      continuationArgs: ['--current-directory'],
      ...installation,
      environment: {
        PATH: '/tmp/postplus-test-bin',
      },
      runCommand: async (command, args, options) => {
        assert.equal(command, 'npm');
        assert.deepEqual(options?.env, { PATH: '/tmp/postplus-test-bin' });
        if (args[0] === 'view') {
          assert.deepEqual(args, [
            'view',
            '--global',
            '@postplus/cli@latest',
            'version',
            '--json',
          ]);
        }
        return installation.runCommand(command, args);
      },
      runInteractiveCommand: async (command, args, options = {}) => {
        calls.push({ command, args, env: options.env });
        return 0;
      },
      writeOutput: (message) => {
        output.push(message);
      },
    });

    assert.equal(result.updateAvailable, true);
    assert.equal(result.currentVersion, CURRENT_CLI_VERSION);
    assert.equal(result.latestVersion, NEXT_CLI_VERSION);
    assert.equal(result.exitCode, 0);
    assert.equal(result.command, POSTPLUS_CLI_UPDATE_COMMAND);
    assert.deepEqual(calls, [
      {
        command: 'npm',
        args: ['install', '-g', `@postplus/cli@${NEXT_CLI_VERSION}`],
        env: { PATH: '/tmp/postplus-test-bin' },
      },
      {
        command: process.execPath,
        args: [
          installation.currentCliEntryPath,
          'update',
          '--current-directory',
        ],
        env: {
          PATH: '/tmp/postplus-test-bin',
          POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION: NEXT_CLI_VERSION,
        },
      },
    ]);
    assert.match(
      output.join(''),
      /Verifying the installed CLI before continuing/,
    );
    assert.doesNotMatch(output.join(''), /updated to/);
    assert.doesNotMatch(output.join(''), /Re-run `postplus update`/);
  });

  it('skips npm and network checks in the updated CLI continuation', async () => {
    let fetchCalled = false;
    let commandCalled = false;
    const result = await runCliSelfUpdateIfOutdated({
      environment: {
        POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION: CURRENT_CLI_VERSION,
      },
      runCommand: async () => {
        fetchCalled = true;
        throw new Error('continuation must not check npm');
      },
      runInteractiveCommand: async () => {
        commandCalled = true;
        return 1;
      },
      writeOutput: () => {},
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.currentVersion, CURRENT_CLI_VERSION);
    assert.equal(result.latestVersion, CURRENT_CLI_VERSION);
    assert.equal(result.exitCode, null);
    assert.equal(fetchCalled, false);
    assert.equal(commandCalled, false);
  });

  it('fails fast when npm leaves the continuation on the old CLI version', async () => {
    await assert.rejects(
      () =>
        runCliSelfUpdateIfOutdated({
          environment: {
            POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION: NEXT_CLI_VERSION,
          },
          runCommand: async () => {
            throw new Error('continuation must not check npm');
          },
          writeOutput: () => {},
        }),
      new RegExp(
        `self-update reported ${NEXT_CLI_VERSION}, but the continuation process is still ${CURRENT_CLI_VERSION}`,
      ),
    );
  });

  it('continues without npm install when the CLI is already latest', async () => {
    const calls: string[][] = [];
    const result = await runCliSelfUpdateIfOutdated({
      runCommand: async () => ({ stdout: '"0.1.32"', stderr: '' }),
      runInteractiveCommand: async (command, args) => {
        calls.push([command, ...args]);
        return 0;
      },
      writeOutput: () => {},
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.exitCode, null);
    assert.deepEqual(calls, []);
  });

  it('compares the public skill releaseId with the managed skill baseline', async () => {
    await writeManagedSkillBaseline({
      releaseId: 'catalog-1',
      skillNames: ['demo-skill'],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            releaseId: 'catalog-2',
            source: 'PostPlusAI/postplus-skills',
            skills: [
              {
                name: 'demo-skill',
                path: 'skills/demo-skill/SKILL.md',
                status: 'released/router',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const report = await generateFixtureUpdateStatus({ force: true });

      assert.equal(report.cli.updateCommand, POSTPLUS_UPDATE_COMMAND);
      assert.equal(report.skills.currentReleaseId, 'catalog-1');
      assert.equal(report.skills.latestReleaseId, 'catalog-2');
      assert.equal(report.skills.updateAvailable, true);
      assert.equal(report.skills.updateCommand, POSTPLUS_UPDATE_COMMAND);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes update state only after update installs and verifies the new release', async () => {
    const originalFetch = globalThis.fetch;
    let catalogReleaseId = 'catalog-1';
    const listInstalled = async () => ({
      stderr: '',
      stdout: JSON.stringify([
        {
          agents: ['Codex'],
          name: 'demo-skill',
          path: '/tmp/demo-skill',
          scope: 'global',
        },
      ]),
    });

    globalThis.fetch = async (input) => {
      const url = String(input);

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            releaseId: catalogReleaseId,
            source: 'PostPlusAI/postplus-skills',
            skills: [
              {
                name: 'demo-skill',
                path: 'skills/demo-skill/SKILL.md',
                status: 'released',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      });
      await generateFixtureUpdateStatus({ force: true });
      catalogReleaseId = 'catalog-2';

      const verify = await runPostPlusSkillVerify({
        runCommand: listInstalled,
      });
      assert.equal(verify.ok, false);
      assert.equal((await readManagedSkillBaseline()).releaseId, 'catalog-1');
      await runPostPlusSkillUpdate({ runCommand: listInstalled, runInteractiveCommand: async () => 0 });
      const status = await generateStatusReportWithDependencies({
        generateUpdateStatus: generateFixtureUpdateStatus,
        generateAuthStatus: async () => ({
          ok: true,
          apiBaseUrl: {
            source: 'default',
            present: true,
            value: 'https://postplus.example.com',
          },
          cliSessionToken: {
            source: 'config',
            present: true,
            maskedValue: 'token',
          },
          config: {
            path: 'config.json',
            exists: true,
            accountId: 'account-1',
            accountName: 'Team Workspace',
            accountSlug: 'team-workspace',
            accountType: 'team',
            sessionExpiresAt: 1_900_000_000,
            userEmail: 'user@example.com',
            userId: 'user-1',
          },
        }),
        generateDoctor: async () => ({
          schemaVersion: 3,
          ok: true,
          requiredOk: true,
          checks: [],
        }),
        generateSkillStatus: () =>
          generateSkillInstallStatusReport({
            runCommand: listInstalled,
          }),
      });

      assert.equal(verify.baselineUpdated, false);
      assert.equal(verify.verifiedSkillsReleaseId, null);
      assert.equal(status.skills.managedSkillsReleaseId, 'catalog-2');
      assert.equal(status.updates.source, 'remote');
      assert.equal(status.updates.skills.currentReleaseId, 'catalog-2');
      assert.equal(status.updates.skills.latestReleaseId, 'catalog-2');
      assert.equal(status.updates.skills.updateAvailable, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('skill management commands', () => {
  const originalCwd = process.cwd();
  beforeEach(() => {
    // Mutation locks follow the real install scope, independently of config/state.
    process.env.HOME = process.env.POSTPLUS_CONFIG_DIR!;
    process.env.USERPROFILE = process.env.POSTPLUS_CONFIG_DIR!;
  });
  afterEach(() => process.chdir(originalCwd));

  async function writeGlobalSkillsInstallerLock(
    skills: Record<string, unknown>,
  ): Promise<void> {
    const lockDir = resolve(process.env.XDG_STATE_HOME ?? '', 'skills');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      resolve(lockDir, '.skill-lock.json'),
      `${JSON.stringify(
        {
          version: 3,
          skills,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  it('confirms large credit quotes through CLI-owned local state', async () => {
    let promptCount = 0;

    const first = await resolveLargeCreditQuoteConfirmation(
      buildLargeCreditChallenge({ requiredTierMillicredits: 100_000 }),
      {
        confirm: async () => {
          promptCount += 1;
        },
        isTty: () => true,
      },
    );

    assert.deepEqual(first, { schemaVersion: 1, token: 'token-100000' });
    assert.equal(promptCount, 1);

    const repeated = await resolveLargeCreditQuoteConfirmation(
      buildLargeCreditChallenge({ requiredTierMillicredits: 100_000 }),
      {
        confirm: async () => {
          promptCount += 1;
        },
        isTty: () => true,
      },
    );

    assert.deepEqual(repeated, { schemaVersion: 1, token: 'token-100000' });
    assert.equal(promptCount, 1);

    const higher = await resolveLargeCreditQuoteConfirmation(
      buildLargeCreditChallenge({ requiredTierMillicredits: 300_000 }),
      {
        confirm: async () => {
          promptCount += 1;
        },
        isTty: () => true,
      },
    );

    assert.deepEqual(higher, { schemaVersion: 1, token: 'token-300000' });
    assert.equal(promptCount, 2);

    const config = await readLocalConfig();
    assert.equal(
      config?.largeCreditConfirmation
        ?.acknowledgedTierMillicreditsByAccountId?.['account-1'],
      300_000,
    );
  });

  it('auto-confirms under the ceiling without prompting and caches the tier', async () => {
    let promptCount = 0;
    const notices: string[] = [];

    const report = await resolveLargeCreditQuoteConfirmation(
      buildLargeCreditChallenge({ requiredTierMillicredits: 100_000 }),
      {
        confirm: async () => {
          promptCount += 1;
        },
        ceilingMillicredits: 300_000,
        isTty: () => false,
        now: () => new Date('2026-06-02T00:00:00.000Z'),
        logNotice: (line) => {
          notices.push(line);
        },
      },
    );

    assert.deepEqual(report, { schemaVersion: 1, token: 'token-100000' });
    assert.equal(promptCount, 0);
    assert.equal(notices.length, 1);

    const notice = JSON.parse(notices[0]);
    assert.equal(notice.event, 'quote_auto_confirm');
    assert.equal(notice.costCredits, 288);
    assert.equal(notice.ceilingCredits, 300);

    const config = await readLocalConfig();
    assert.equal(
      config?.largeCreditConfirmation
        ?.acknowledgedTierMillicreditsByAccountId?.['account-1'],
      100_000,
    );
  });

  it('throws a distinct error when the cost exceeds the auto-confirm ceiling', async () => {
    let promptCount = 0;
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 300_000,
    });

    await assert.rejects(
      resolveLargeCreditQuoteConfirmation(challenge, {
        confirm: async () => {
          promptCount += 1;
        },
        ceilingMillicredits: 100_000,
        isTty: () => false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof QuoteAutoConfirmCeilingExceededError);
        assert.equal(
          error.code,
          'postplus_cli_quote_auto_confirm_ceiling_exceeded',
        );
        assert.equal(error.costCredits, 288);
        assert.equal(error.ceilingCredits, 100);
        assert.deepEqual(error.challenge, challenge);
        return true;
      },
    );

    assert.equal(promptCount, 0);

    const config = await readLocalConfig();
    assert.equal(
      config?.largeCreditConfirmation
        ?.acknowledgedTierMillicreditsByAccountId?.['account-1'],
      undefined,
    );
  });

  it('fails fast without hanging when no ceiling is set and stdin is not a TTY', async () => {
    let promptCount = 0;
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });

    await assert.rejects(
      resolveLargeCreditQuoteConfirmation(challenge, {
        confirm: async () => {
          promptCount += 1;
        },
        isTty: () => false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof QuoteConfirmationNonInteractiveError);
        assert.match(error.message, /--auto-confirm-under/u);
        assert.deepEqual(error.challenge, challenge);
        return true;
      },
    );

    assert.equal(promptCount, 0);
  });

  it('still prompts interactively when a TTY is present and no ceiling is set', async () => {
    let promptCount = 0;

    const report = await resolveLargeCreditQuoteConfirmation(
      buildLargeCreditChallenge({ requiredTierMillicredits: 100_000 }),
      {
        confirm: async () => {
          promptCount += 1;
        },
        isTty: () => true,
      },
    );

    assert.deepEqual(report, { schemaVersion: 1, token: 'token-100000' });
    assert.equal(promptCount, 1);
  });

  it('formats large credit quote confirmation prompts with public labels', () => {
    const prompt = buildLargeCreditConfirmationPrompt(
      buildLargeCreditChallenge({ requiredTierMillicredits: 300_000 }),
    );

    assert.match(prompt, /PostPlus large credit warning/);
    assert.match(prompt, /300-credit warning tier/);
    assert.match(prompt, /Estimated charge: 288 credits/);
    assert.match(prompt, /Reserved before execution: 432 credits/);
    assert.match(prompt, /Capability: Video generation \/ generate/);
    assert.match(prompt, /Service: Media generation service/);
    assert.match(prompt, /Duration: 10/);
    assert.match(prompt, /Resolution: 1080p/);
  });

  it('reads large credit quote confirmation challenges from product errors', () => {
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });

    assert.deepEqual(
      readLargeCreditQuoteConfirmationChallenge({
        productErrorCode: 'postplus_cli_quote_confirmation_required',
        quoteConfirmation: challenge,
      }),
      challenge,
    );
  });

  it('exposes quote confirm as the skill delegation command', async () => {
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });

    await writeLocalConfig({
      largeCreditConfirmation: {
        acknowledgedTierMillicreditsByAccountId: {
          'account-1': 100_000,
        },
      },
    });
    const challengeFile = resolve(
      process.env.POSTPLUS_CONFIG_DIR ?? tmpdir(),
      'challenge.json',
    );
    await writeFile(challengeFile, JSON.stringify(challenge), {
      encoding: 'utf8',
      mode: 0o600,
    });

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'quote',
      'confirm',
      '--json',
      '--challenge-file',
      challengeFile,
    ]);

    assert.deepEqual(JSON.parse(stdout), {
      schemaVersion: 1,
      token: 'token-100000',
    });
  });

  it('builds update and uninstall commands for released PostPlus skills only', () => {
    assert.deepEqual(POSTPLUS_SKILLS_AGENT_TARGETS, [
      'claude-code',
      'codex',
      'cursor',
      'github-copilot',
      'windsurf',
      'trae',
      'trae-cn',
      'openclaw',
      'hermes-agent',
    ]);
    assert.deepEqual(buildPostPlusSkillUpdateArgs(['a', 'b']), [
      '-y',
      'skills',
      'add',
      'PostPlusAI/postplus-skills',
      '--global',
      '--full-depth',
      '--skill',
      '*',
      '--agent',
      ...POSTPLUS_SKILLS_AGENT_TARGETS,
      '--yes',
    ]);
    assert.deepEqual(buildPostPlusSkillUninstallArgs(['a', 'b']), [
      '-y',
      'skills',
      'remove',
      'a',
      'b',
      '--global',
      '--yes',
    ]);
  });

  it('builds current-directory update and uninstall commands', () => {
    assert.equal(
      POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND,
      'for agent in claude-code codex cursor github-copilot windsurf trae trae-cn openclaw hermes-agent; do npx -y skills add PostPlusAI/postplus-skills --full-depth --skill \'*\' --agent "$agent" --yes; done',
    );
    assert.deepEqual(
      buildPostPlusSkillUpdateArgs(['a', 'b'], 'current-directory'),
      [
        '-y',
        'skills',
        'add',
        'PostPlusAI/postplus-skills',
        '--full-depth',
        '--skill',
        '*',
        '--agent',
        ...POSTPLUS_SKILLS_AGENT_TARGETS,
        '--yes',
      ],
    );
    assert.deepEqual(
      buildPostPlusSkillUninstallArgs(['a', 'b'], 'current-directory'),
      ['-y', 'skills', 'remove', 'a', 'b', '--yes'],
    );
  });

  it('uses the staged public skills source for update installs when configured', () => {
    process.env[POSTPLUS_SKILLS_SOURCE_ENV] =
      'PostPlusAI/postplus-skills#release/2026-05-03.1';

    assert.deepEqual(buildPostPlusSkillUpdateArgs(['a', 'b']), [
      '-y',
      'skills',
      'add',
      'PostPlusAI/postplus-skills#release/2026-05-03.1',
      '--global',
      '--full-depth',
      '--skill',
      '*',
      '--agent',
      ...POSTPLUS_SKILLS_AGENT_TARGETS,
      '--yes',
    ]);
  });

  it('reports missing released skills from skills list output', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-1',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
            {
              name: 'missing-skill',
              path: 'skills/missing-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      const report = await generateSkillInstallStatusReport({
        runCommand: async (_command, args) => {
          if (args.includes('--global')) {
            return {
              stderr: '',
              stdout: '[]',
            };
          }

          return {
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'project',
              },
            ]),
          };
        },
      });

      assert.equal(report.ok, false);
      assert.deepEqual(report.missingSkills, ['demo-skill', 'missing-skill']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('lists only the selected global scope without combining project skills', async () => {
    const originalFetch = globalThis.fetch;
    let activeListCalls = 0;
    const calls: string[][] = [];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-1',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      const report = await generateSkillInstallStatusReport({
        runCommand: async (_command, args) => {
          activeListCalls += 1;
          assert.equal(activeListCalls, 1);
          calls.push(args);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeListCalls -= 1;

          return {
            stderr: '',
            stdout: args.includes('--global')
              ? JSON.stringify([
                  {
                    agents: ['Codex'],
                    name: 'demo-skill',
                    path: '/tmp/demo-skill',
                    scope: 'global',
                  },
                ])
              : '[]',
          };
        },
      });

      assert.equal(report.ok, false, 'matching names alone do not prove a release');
      assert.deepEqual(calls, [
        ['-y', 'skills', 'list', '--json', '--global'],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports retired skills from the managed baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          releaseNotes: {
            schemaVersion: 1,
            releaseId: 'catalog-2',
            title: 'Fewer interruptions',
            summary: 'Routine recoverable errors no longer stop the task.',
            highlights: [
              'PostPlus retries once after a compatible update.',
              'Safe local usage errors can be corrected before submission.',
            ],
          },
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill', 'retired-skill'],
      });
      const report = await generateSkillInstallStatusReport({
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
            {
              agents: ['Codex'],
              name: 'retired-skill',
              path: '/tmp/retired-skill',
              scope: 'global',
            },
          ]),
        }),
      });

      assert.equal(report.ok, false);
      assert.equal(report.managedSkillsReleaseId, 'catalog-1');
      assert.deepEqual(report.retiredManagedSkills, ['retired-skill']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates current skills, removes retired managed skills, then advances the baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          releaseNotes: {
            schemaVersion: 1,
            releaseId: 'catalog-2',
            title: 'Fewer interruptions',
            summary: 'Routine recoverable errors no longer stop the task.',
            highlights: [
              'PostPlus retries once after a compatible update.',
              'Safe local usage errors can be corrected before submission.',
            ],
          },
          productBrief: createPublicProductBrief(),
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
            {
              name: 'new-skill',
              path: 'skills/new-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];
    const successMessages: string[] = [];

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill', 'retired-skill'],
      });
      const exitCode = await runPostPlusSkillUpdate({
        reportSuccess: (message) => successMessages.push(message),
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
            {
              agents: ['Codex'],
              name: 'new-skill',
              path: '/tmp/new-skill',
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          return 0;
        },
      });
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length + 1);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUpdateArgs(
          ['demo-skill', 'new-skill'],
          'global',
          'claude-code',
        ),
      );
      assert.deepEqual(
        calls[POSTPLUS_SKILLS_AGENT_TARGETS.length],
        buildPostPlusSkillUninstallArgs(['retired-skill'], 'global'),
      );
      assert.deepEqual((await readManagedSkillBaseline())?.skillNames, [
        'demo-skill',
        'new-skill',
      ]);
      assert.equal((await readManagedSkillBaseline())?.releaseId, 'catalog-2');
      assert.equal(config?.cliVersion, CURRENT_CLI_VERSION);
      assert.deepEqual(successMessages, [
        'PostPlus Skills updated: 2 current, 1 retired removed (global).',
        [
          'PostPlus update catalog-2: Fewer interruptions',
          'Routine recoverable errors no longer stop the task.',
          '- PostPlus retries once after a compatible update.',
          '- Safe local usage errors can be corrected before submission.',
        ].join('\n'),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('welcomes a setup without presenting current release notes as an update', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const response = createPublicCatalogResponse();
      const catalog = (await response.json()) as Record<string, unknown>;
      catalog.productBrief = createPublicProductBrief();
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const successMessages: string[] = [];
    const installCalls: string[][] = [];

    try {
      const exitCode = await runPostPlusSkillUpdate({
        reportSuccess: (message) => successMessages.push(message),
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async (_command, args) => {
          installCalls.push(args);
          return 0;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(installCalls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.deepEqual(successMessages, [
        [
          'PostPlus is ready: 1 official Skills installed and verified (global).',
          '',
          'Marketing should not begin with a maze of tools. It should begin with an ambition.',
          '',
          'PostPlus gives individuals and lean teams the operating power of a much larger marketing organization.',
          '',
          'Start a new agent session to use them; run `postplus list` to browse available capabilities.',
        ].join('\n'),
      ]);
      assert.doesNotMatch(successMessages.join('\n'), /PostPlus update/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('verifies an already-current setup without reinstalling every agent target', async () => {
    await writeManagedSkillBaseline({
      releaseId: 'catalog-1',
      skillNames: ['demo-skill'],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => createPublicCatalogResponse();
    const successMessages: string[] = [];
    let installCalled = false;

    try {
      const exitCode = await runPostPlusSkillUpdate({
        reportSuccess: (message) => successMessages.push(message),
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async () => {
          installCalled = true;
          return 0;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(installCalled, false);
      assert.deepEqual(successMessages, [
        'PostPlus is already current: 1 official Skills verified (global).',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps implicit recovery output to one official update summary', async () => {
    await writeManagedSkillBaseline({
      releaseId: 'catalog-1',
      skillNames: ['demo-skill'],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          releaseNotes: {
            schemaVersion: 1,
            releaseId: 'catalog-2',
            title: 'Fewer interruptions',
            summary: 'Routine recoverable errors no longer stop the task.',
            highlights: ['PostPlus retries once after a compatible update.'],
          },
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const successMessages: string[] = [];

    try {
      const exitCode = await runPostPlusSkillUpdate(
        {
          reportSuccess: (message) => successMessages.push(message),
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'global',
              },
            ]),
          }),
          runInteractiveCommand: async () => 0,
        },
        { messageMode: 'implicit', scope: 'global' },
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(successMessages, [
        'PostPlus Skills updated: Fewer interruptions. Routine recoverable errors no longer stop the task.',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('repairs a current baseline only after typed installation drift', async () => {
    await writeManagedSkillBaseline({
      releaseId: 'catalog-1',
      skillNames: ['demo-skill'],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => createPublicCatalogResponse();
    let inspections = 0;
    let installs = 0;
    const messages: string[] = [];
    try {
      const exitCode = await runPostPlusSkillUpdate({
        reportSuccess: (message) => messages.push(message),
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify(
            ++inspections === 1
              ? []
              : [
                  {
                    agents: ['Codex'],
                    name: 'demo-skill',
                    path: '/tmp/demo-skill',
                    scope: 'global',
                  },
                ],
          ),
        }),
        runInteractiveCommand: async () => {
          installs++;
          return 0;
        },
      });
      assert.equal(exitCode, 0);
      assert.equal(installs, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.match(messages.join('\n'), /repaired and verified/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not infer repair permission from an unrelated error with matching English text', async () => {
    await writeManagedSkillBaseline({
      releaseId: 'catalog-1',
      skillNames: ['demo-skill'],
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => createPublicCatalogResponse();
    const failure = new Error(
      'PostPlus skills update did not converge because the installer could not be inspected.',
    );
    let installs = 0;
    try {
      await assert.rejects(
        runPostPlusSkillUpdate({
          runCommand: async () => {
            throw failure;
          },
          runInteractiveCommand: async () => {
            installs++;
            return 0;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(installs, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not advance the baseline when the installer reports success but a retired skill remains', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill', 'retired-skill'],
      });

      await assert.rejects(
        runPostPlusSkillUpdate({
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex', 'Gemini CLI'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'global',
              },
              {
                agents: ['Gemini CLI'],
                name: 'retired-skill',
                path: '/tmp/retired-skill',
                scope: 'global',
              },
            ]),
          }),
          runInteractiveCommand: async () => 0,
        }),
        /did not converge.*still present: retired-skill.*baseline was not changed/i,
      );

      const config = await readLocalConfig();
      assert.equal((await readManagedSkillBaseline())?.releaseId, 'catalog-1');
      assert.deepEqual((await readManagedSkillBaseline())?.skillNames, [
        'demo-skill',
        'retired-skill',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('backs up a locally modified managed skill before installing the official release', async () => {
    const originalFetch = globalThis.fetch;
    const officialContent = 'official skill\n';
    const localContent = 'locally customized skill\n';
    const installedSkillDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-modified-skill-'),
    );
    tempDirs.push(installedSkillDir);
    await writeFile(
      resolve(installedSkillDir, 'SKILL.md'),
      localContent,
      'utf8',
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const prompts: Array<{
      action: string;
      scope: string;
      skillNames: string[];
    }> = [];
    const messages: string[] = [];
    let installCalls = 0;

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      });
      await writeGlobalSkillsInstallerLock({
        'demo-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: computeSingleFileGitTreeHash(
            'SKILL.md',
            officialContent,
          ),
          skillPath: 'skills/demo-skill/SKILL.md',
        },
      });

      const exitCode = await runPostPlusSkillUpdate({
        confirmModifiedSkillBackup: async (prompt) => {
          prompts.push(prompt);
          return true;
        },
        isInteractive: () => true,
        reportSuccess: (message) => messages.push(message),
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: installedSkillDir,
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async () => {
          installCalls += 1;
          await writeFile(
            resolve(installedSkillDir, 'SKILL.md'),
            officialContent,
            'utf8',
          );
          return 0;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(installCalls, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.deepEqual(prompts, [
        {
          action: 'update',
          scope: 'global',
          skillNames: ['demo-skill'],
        },
      ]);
      assert.match(messages[0] ?? '', /Backed up 1 locally modified/);
      const backupRoot = resolve(
        process.env.POSTPLUS_CONFIG_DIR ?? '',
        'skill-backups',
      );
      const [backupDirectory] = await readdir(backupRoot);
      assert.ok(backupDirectory);
      const manifest = JSON.parse(
        await readFile(
          resolve(backupRoot, backupDirectory, 'manifest.json'),
          'utf8',
        ),
      ) as {
        skills: Array<{ backupPath: string; name: string }>;
      };
      assert.equal(manifest.skills[0]?.name, 'demo-skill');
      assert.equal(
        await readFile(
          resolve(manifest.skills[0]?.backupPath ?? '', 'SKILL.md'),
          'utf8',
        ),
        localContent,
      );
      assert.equal(
        await readFile(resolve(installedSkillDir, 'SKILL.md'), 'utf8'),
        officialContent,
      );

      let repeatedPromptCount = 0;
      const repeatedExitCode = await runPostPlusSkillUpdate({
        confirmModifiedSkillBackup: async () => {
          repeatedPromptCount += 1;
          return true;
        },
        isInteractive: () => true,
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: installedSkillDir,
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async () => 0,
      });
      assert.equal(repeatedExitCode, 0);
      assert.equal(repeatedPromptCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('protects and verifies global skills using only global installer entries', async () => {
    const originalFetch = globalThis.fetch;
    const officialContent = 'official skill\n';
    const globalSkillDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-global-skill-'),
    );
    const projectSkillDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-project-skill-'),
    );
    tempDirs.push(globalSkillDir, projectSkillDir);
    await writeFile(
      resolve(globalSkillDir, 'SKILL.md'),
      officialContent,
      'utf8',
    );
    await writeFile(
      resolve(projectSkillDir, 'SKILL.md'),
      'project customization\n',
      'utf8',
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    let promptCount = 0;

    try {
      await writeGlobalSkillsInstallerLock({
        'demo-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: computeSingleFileGitTreeHash(
            'SKILL.md',
            officialContent,
          ),
          skillPath: 'skills/demo-skill/SKILL.md',
        },
      });

      const exitCode = await runPostPlusSkillUpdate({
        confirmModifiedSkillBackup: async () => {
          promptCount += 1;
          return true;
        },
        isInteractive: () => true,
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: globalSkillDir,
              scope: 'global',
            },
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: projectSkillDir,
              scope: 'project',
            },
          ]),
        }),
        runInteractiveCommand: async () => 0,
      });

      assert.equal(exitCode, 0);
      assert.equal(promptCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails before mutation when a locally modified managed skill is found outside an interactive terminal', async () => {
    const originalFetch = globalThis.fetch;
    const installedSkillDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-modified-skill-nontty-'),
    );
    tempDirs.push(installedSkillDir);
    await writeFile(
      resolve(installedSkillDir, 'SKILL.md'),
      'locally customized skill\n',
      'utf8',
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    let mutationCalls = 0;

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      });
      await writeGlobalSkillsInstallerLock({
        'demo-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: computeSingleFileGitTreeHash(
            'SKILL.md',
            'official skill\n',
          ),
          skillPath: 'skills/demo-skill/SKILL.md',
        },
      });

      await assert.rejects(
        runPostPlusSkillUpdate({
          isInteractive: () => false,
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex'],
                name: 'demo-skill',
                path: installedSkillDir,
                scope: 'global',
              },
            ]),
          }),
          runInteractiveCommand: async () => {
            mutationCalls += 1;
            return 0;
          },
        }),
        /require confirmation.*interactive terminal.*baseline was not changed/i,
      );

      assert.equal(mutationCalls, 0);
      assert.equal(
        (await readManagedSkillBaseline())?.releaseId,
        'catalog-1',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not advance the baseline when the installer reports success but a released skill is missing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
            {
              name: 'new-skill',
              path: 'skills/new-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      });

      await assert.rejects(
        runPostPlusSkillUpdate({
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'global',
              },
            ]),
          }),
          runInteractiveCommand: async () => 0,
        }),
        /did not converge.*missing: new-skill.*baseline was not changed/i,
      );

      assert.equal(
        (await readManagedSkillBaseline())?.releaseId,
        'catalog-1',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates current skills and removes retired PostPlus skills tracked by the installer lock', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-2',
        skillNames: ['demo-skill'],
      });
      const currentLock = {
        'demo-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: 'demo-hash',
          skillPath: 'skills/demo-skill/SKILL.md',
        },
        'local-user-skill': {
          source: '/Users/example/custom-skills',
          sourceType: 'local',
          sourceUrl: '/Users/example/custom-skills',
        },
        'retired-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: 'retired-hash',
          skillPath: 'skills/old/retired-skill/SKILL.md',
        },
      };
      await writeGlobalSkillsInstallerLock(currentLock);

      const exitCode = await runPostPlusSkillUpdate({
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
          ]),
        }),
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          if (args.includes('remove')) {
            const { ['retired-skill']: _retired, ...remaining } = currentLock;
            await writeGlobalSkillsInstallerLock(remaining);
          }
          return 0;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length + 1);
      assert.deepEqual(
        calls[POSTPLUS_SKILLS_AGENT_TARGETS.length],
        buildPostPlusSkillUninstallArgs(['retired-skill'], 'global'),
      );
      assert.doesNotMatch(calls.flat().join(' '), /local-user-skill/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates current-directory public skills when requested', async () => {
    process.chdir(process.env.POSTPLUS_CONFIG_DIR!);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];

    try {
      const exitCode = await runPostPlusSkillUpdate(
        {
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Codex'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'project',
              },
            ]),
          }),
          runInteractiveCommand: async (_command, args) => {
            calls.push(args);
            return 0;
          },
        },
        { scope: 'current-directory' },
      );

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUpdateArgs(
          ['demo-skill'],
          'current-directory',
          'claude-code',
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not treat a global skill as a current-directory installation', async () => {
    process.chdir(process.env.POSTPLUS_CONFIG_DIR!);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        runPostPlusSkillUpdate(
          {
            runCommand: async () => ({
              stderr: '',
              stdout: JSON.stringify([
                {
                  agents: ['Codex'],
                  name: 'demo-skill',
                  path: '/tmp/global-demo-skill',
                  scope: 'global',
                },
              ]),
            }),
            runInteractiveCommand: async () => 0,
          },
          { scope: 'current-directory' },
        ),
        /did not converge.*missing: demo-skill.*baseline was not changed/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('verifies an already recorded installation without rewriting its baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
            {
              name: 'new-skill',
              path: 'skills/new-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];

    try {
      await writeManagedSkillBaseline({ releaseId: 'catalog-2', skillNames: ['demo-skill', 'new-skill'] });
      const report = await runPostPlusSkillVerify({
        runCommand: async (_command, args) => {
          calls.push(args);
          return {
            stderr: '',
            stdout: args.includes('--global')
              ? JSON.stringify([
                  {
                    agents: ['Codex'],
                    name: 'demo-skill',
                    path: '/tmp/demo-skill',
                    scope: 'global',
                  },
                  {
                    agents: ['Codex'],
                    name: 'new-skill',
                    path: '/tmp/new-skill',
                    scope: 'global',
                  },
                ])
              : '[]',
          };
        },
      });
      const config = await readLocalConfig();

      assert.equal(report.ok, true);
      assert.equal(report.baselineUpdated, false);
      assert.equal(report.previousManagedSkillsReleaseId, 'catalog-2');
      assert.equal(report.verifiedSkillsReleaseId, 'catalog-2');
      assert.deepEqual(calls, [
        ['-y', 'skills', 'list', '--json', '--global'],
      ]);
      assert.deepEqual((await readManagedSkillBaseline())?.skillNames, [
        'demo-skill',
        'new-skill',
      ]);
      assert.equal((await readManagedSkillBaseline())?.releaseId, 'catalog-2');
      assert.match(formatSkillBaselineVerifyReport(report), /Verified baseline: catalog-2/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports retired installed PostPlus skills from the installer lock after the baseline was advanced', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-2',
        skillNames: ['demo-skill'],
      });
      await writeGlobalSkillsInstallerLock({
        'demo-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: 'demo-hash',
          skillPath: 'skills/demo-skill/SKILL.md',
        },
        'retired-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: 'retired-hash',
          skillPath: 'skills/old/retired-skill/SKILL.md',
        },
      });

      const report = await runPostPlusSkillVerify({
        runCommand: async (_command, args) => ({
          stderr: '',
          stdout: args.includes('--global')
            ? JSON.stringify([
                {
                  agents: ['Codex'],
                  name: 'demo-skill',
                  path: '/tmp/demo-skill',
                  scope: 'global',
                },
                {
                  agents: ['Codex'],
                  name: 'retired-skill',
                  path: '/tmp/retired-skill',
                  scope: 'global',
                },
              ])
            : '[]',
        }),
      });
      const config = await readLocalConfig();

      assert.equal(report.ok, false);
      assert.equal(report.baselineUpdated, false);
      assert.deepEqual(report.retiredManagedSkills, ['retired-skill']);
      assert.equal((await readManagedSkillBaseline())?.releaseId, 'catalog-2');
      assert.match(
        formatSkillBaselineVerifyReport(report),
        /Retired managed skills: retired-skill/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not report a project skill as retired from a global PostPlus installer lock entry', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-2',
        skillNames: ['demo-skill'],
      });
      await writeGlobalSkillsInstallerLock({
        'retired-skill': {
          source: 'PostPlusAI/postplus-skills',
          sourceType: 'github',
          sourceUrl: 'https://github.com/PostPlusAI/postplus-skills.git',
          skillFolderHash: 'retired-hash',
          skillPath: 'skills/old/retired-skill/SKILL.md',
        },
      });

      const report = await runPostPlusSkillVerify({
        runCommand: async (_command, args) => ({
          stderr: '',
          stdout: args.includes('--global')
            ? JSON.stringify([
                {
                  agents: ['Codex'],
                  name: 'demo-skill',
                  path: '/tmp/demo-skill',
                  scope: 'global',
                },
              ])
            : JSON.stringify([
                {
                  agents: ['Codex'],
                  name: 'retired-skill',
                  path: '/tmp/project-retired-skill',
                  scope: 'project',
                },
              ]),
        }),
      });

      assert.equal(report.ok, true);
      assert.deepEqual(report.retiredManagedSkills, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not record the managed baseline when verification finds missing skills', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
            {
              name: 'missing-skill',
              path: 'skills/missing-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill'],
      });
      const report = await runPostPlusSkillVerify({
        runCommand: async () => ({
          stderr: '',
          stdout: JSON.stringify([
            {
              agents: ['Codex'],
              name: 'demo-skill',
              path: '/tmp/demo-skill',
              scope: 'global',
            },
          ]),
        }),
      });
      const config = await readLocalConfig();

      assert.equal(report.ok, false);
      assert.equal(report.baselineUpdated, false);
      assert.equal(report.previousManagedSkillsReleaseId, 'catalog-1');
      assert.deepEqual(report.missingSkills, ['missing-skill']);
      assert.equal((await readManagedSkillBaseline())?.releaseId, 'catalog-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uninstalls current and retired managed skills before clearing the baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill', 'retired-skill'],
      });
      const exitCode = await runPostPlusSkillUninstall({
        runCommand: async () => ({ stderr: '', stdout: '[]' }),
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          return 0;
        },
      });
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUninstallArgs(
          ['demo-skill', 'retired-skill'],
          'global',
        ),
      );
      assert.equal((await readManagedSkillBaseline('global')).releaseId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uninstalls current-directory public skills when requested', async () => {
    process.chdir(process.env.POSTPLUS_CONFIG_DIR!);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const calls: string[][] = [];

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['retired-skill'],
      });
      const exitCode = await runPostPlusSkillUninstall(
        {
          runCommand: async () => ({ stderr: '', stdout: '[]' }),
          runInteractiveCommand: async (_command, args) => {
            calls.push(args);
            return 0;
          },
        },
        { scope: 'current-directory' },
      );
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUninstallArgs(
          ['demo-skill', 'retired-skill'],
          'current-directory',
        ),
      );
      assert.equal((await readManagedSkillBaseline('current-directory')).releaseId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not clear the baseline when uninstall leaves a managed skill behind', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 2,
          releaseId: 'catalog-2',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              status: 'released',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await writeManagedSkillBaseline({
        releaseId: 'catalog-2',
        skillNames: ['demo-skill'],
      });

      await assert.rejects(
        runPostPlusSkillUninstall({
          runCommand: async () => ({
            stderr: '',
            stdout: JSON.stringify([
              {
                agents: ['Gemini CLI'],
                name: 'demo-skill',
                path: '/tmp/demo-skill',
                scope: 'global',
              },
            ]),
          }),
          runInteractiveCommand: async () => 0,
        }),
        /uninstall did not converge.*still present: demo-skill.*baseline was not changed/i,
      );

      assert.equal(
        (await readManagedSkillBaseline())?.releaseId,
        'catalog-2',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('recognizes postplus install as the managed setup entrypoint', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'install',
        '--mystery-scope',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown option for install: --mystery-scope/,
        );
        return true;
      },
    );
  });

  it('fails fast on unknown update options', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'update',
        '--mystery-scope',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown option for update: --mystery-scope/,
        );
        return true;
      },
    );
  });

  it('fails fast on unknown uninstall options', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'uninstall',
        '--mystery-scope',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown option for uninstall: --mystery-scope/,
        );
        return true;
      },
    );
  });

  it('fails fast on unknown skills verify options', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'skills',
        'verify',
        '--bogus',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown option for skills verify: --bogus/,
        );
        return true;
      },
    );
  });

  it('prints the installed CLI version', async () => {
    const { stdout: versionStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'version',
    ]);
    const { stdout: flagStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      '--version',
    ]);

    assert.match(versionStdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(flagStdout, versionStdout);
  });
});

describe('hosted domain commands', () => {
  it('documents the thin public hosted command contracts', async () => {
    const { stdout: topLevelHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'help',
    ]);
    assert.match(
      topLevelHelp,
      /postplus media-file download .* \[--json\] \[--output <result\.json>\]/u,
    );
    assert.match(
      topLevelHelp,
      /postplus media-file upload .* \[--json\] \[--output <result\.json>\]/u,
    );
    assert.doesNotMatch(
      topLevelHelp,
      /storage-only|storageReference|WaveSpeed|asset:\/\//u,
    );

    const { stdout: researchHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'help',
    ]);
    assert.match(researchHelp, /postplus research run <route>/u);
    assert.match(researchHelp, /postplus research schema/u);
    assert.doesNotMatch(
      researchHelp,
      /research (collect|scrape)|--request|max-charge-usd/u,
    );

    for (const domain of ['media', 'publish']) {
      const { stdout } = await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        domain,
        'help',
      ]);
      assert.match(stdout, new RegExp(`postplus ${domain} schema`, 'u'));
      if (domain === 'media') {
        assert.match(stdout, /--endpoint <endpoint-key>/u);
        assert.match(stdout, /postplus media create <endpoint-key>/u);
      } else {
        assert.match(stdout, /postplus publish <operation> --request/u);
      }
    }
  });

  it('renders media-file help for subcommand-level --help/-h instead of throwing a flag error', async () => {
    // Regression: runMediaFileUpload/runMediaFileDownload register only their
    // own boolean flags (upload: `json`; download: `debug`, `json`), so a
    // `--help` sitting in the subcommand args used to fall through to parseFlags
    // and exit 1 with `Missing value for --help.`. Subcommand-level help must
    // now print the shared media-file help and exit 0. execFileAsync rejects on
    // any non-zero exit, so a resolved call already asserts the exit-0 contract.
    const invocations = [
      ['media-file', 'upload', '--help'],
      ['media-file', 'upload', '-h'],
      ['media-file', 'download', '--help'],
      ['media-file', 'download', '-h'],
      // Bare `help` (word) is recognized for both subcommands too.
      ['media-file', 'upload', 'help'],
      ['media-file', 'download', 'help'],
      // Help wins even when it trails otherwise-real flags.
      ['media-file', 'upload', '--input-file', '/tmp/x.jpg', '--help'],
      // ...including after a value-taking flag on download.
      [
        'media-file',
        'download',
        '--reference',
        'postplus-media://bucket/object',
        '--help',
      ],
    ];
    for (const invocation of invocations) {
      const { stdout } = await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        ...invocation,
      ]);
      assert.match(stdout, /postplus media-file upload --input-file/u);
      assert.match(stdout, /postplus media-file download \(--reference/u);
    }
  });

  it('prints manifest-driven public hosted request schemas without requiring auth', async () => {
    const { stdout: researchStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'schema',
      '--route',
      'youtube-channel-summary',
      '--json',
    ]);
    const researchReport = JSON.parse(researchStdout) as Record<
      string,
      unknown
    >;
    assert.equal(researchReport.selectedRouteKey, 'youtube-channel-summary');
    // The full enum sets of selectable targets come from the manifest, not a
    // hand-maintained catalog of example payloads.
    assert.ok(
      (researchReport.routeKeys as string[]).includes(
        'youtube-channel-summary',
      ),
    );
    const researchRoutes = researchReport.routes as Array<{
      routeKey: string;
      fields: Array<{ name: string; flag: string | null }>;
      example: string;
    }>;
    assert.equal(researchRoutes.length, 1);
    assert.equal(researchRoutes[0]?.routeKey, 'youtube-channel-summary');
    assert.ok(
      researchRoutes[0]?.fields.some((field) => field.flag === '--channel'),
    );
    assert.match(
      researchRoutes[0]?.example ?? '',
      /research run youtube-channel-summary/u,
    );
    assert.doesNotMatch(
      researchStdout,
      /actorId|datasetId|providerModelPath|collectionKey|sourceKey|--request/u,
    );

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'schema',
      '--endpoint',
      'video-seedance-2-text',
      '--json',
    ]);
    const report = JSON.parse(stdout) as Record<string, unknown>;

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.domain, 'media');
    assert.match(
      String(report.command),
      /postplus media <verb> <endpoint-key>/u,
    );
    assert.ok(
      (report.endpointKeys as string[]).includes('video-seedance-2-text'),
    );

    // endpointKey is a real enum projected from the manifest, not a bare string.
    const requestSchema = (
      report.schemas as Array<{
        id: string;
        jsonSchema: { properties: Record<string, { enum?: string[] }> };
      }>
    ).find((schema) => schema.id === 'media-generation.request');
    assert.ok(requestSchema);
    assert.ok(
      requestSchema.jsonSchema.properties.endpointKey.enum?.includes(
        'video-seedance-2-text',
      ),
    );
    assert.ok(
      (requestSchema.jsonSchema.properties.endpointKey.enum?.length ?? 0) > 1,
    );

    // The selected endpoint's full field contract (enum sets / defaults / class)
    // is published instead of a single example payload.
    const endpoints = report.endpoints as Array<{
      endpointKey: string;
      fields: Array<{
        name: string;
        kind: string;
        enumValues?: string[];
        default?: unknown;
        min?: number;
        max?: number;
      }>;
    }>;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].endpointKey, 'video-seedance-2-text');
    const resolutionField = endpoints[0].fields.find(
      (field) => field.name === 'resolution',
    );
    // The non-turbo seedance endpoints advertise the full resolution ladder,
    // including 480p, as priced in the cost table.
    assert.deepEqual(resolutionField?.enumValues, ['480p', '720p', '1080p']);
    assert.equal(resolutionField?.kind, 'default');
    assert.equal(resolutionField?.default, '720p');
    const durationField = endpoints[0].fields.find(
      (field) => field.name === 'duration',
    );
    assert.equal(durationField?.min, 4);
    assert.equal(durationField?.max, 15);
    const operationIdField = endpoints[0].fields.find(
      (field) => field.name === 'operationId',
    );
    assert.equal(operationIdField?.kind, 'runner-managed');

    const { stdout: publishStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'publish',
      'schema',
      '--json',
    ]);
    const publishReport = JSON.parse(publishStdout) as Record<string, unknown>;
    assert.ok((publishReport.operations as string[]).includes('create-post'));
    const publishOperationSchema = (
      publishReport.schemas as Array<{
        id: string;
        jsonSchema: { properties: Record<string, { enum?: string[] }> };
      }>
    ).find((schema) => schema.id === 'social-publishing.request');
    assert.ok(
      publishOperationSchema?.jsonSchema.properties.operation.enum?.includes(
        'create-post',
      ),
    );
  });

  it('prints manifest-driven transcription media field contract without example payloads', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'schema',
      '--endpoint',
      'transcription',
      '--json',
    ]);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(report.selectedEndpointKey, 'transcription');
    assert.equal(Object.hasOwn(report, 'examples'), false);

    const endpoints = report.endpoints as Array<{
      endpointKey: string;
      fields: Array<{
        name: string;
        kind: string;
        type: string;
        flag: string | null;
        default?: unknown;
        enumValues?: string[];
      }>;
    }>;
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].endpointKey, 'transcription');
    const byName = new Map(
      endpoints[0].fields.map((field) => [field.name, field]),
    );
    assert.equal(byName.get('audio')?.kind, 'intent');
    assert.equal(byName.get('audio')?.flag, '--audio');
    assert.equal(byName.get('task')?.kind, 'default');
    assert.deepEqual(byName.get('task')?.enumValues, [
      'transcribe',
      'translate',
    ]);
    assert.equal(byName.get('task')?.default, 'transcribe');
    assert.equal(byName.get('mediaSeconds')?.kind, 'runner-managed');
    assert.equal(byName.get('mediaSeconds')?.flag, null);
    // The retired catalog's example-only fields are gone from the contract.
    assert.equal(byName.has('response_format'), false);
    assert.equal(byName.has('timestamp_granularities'), false);
  });

  it('synthesizes a copy-pasteable example per media endpoint (required ∪ prompt, enums at first value)', () => {
    for (const endpointKey of ['transcription', 'video-seedance-2-text']) {
      const report = buildHostedRequestSchemaReport({
        domain: 'media',
        endpointKey,
      });
      const endpoints = report.endpoints as Array<{
        endpointKey: string;
        fields: Array<{
          name: string;
          kind: string;
          type: string;
          flag: string | null;
          repeatable?: boolean;
          enumValues?: string[];
          required: boolean;
        }>;
        example?: {
          command: string;
          request: Record<string, unknown>;
          estimate: string;
        };
      }>;
      const endpoint = endpoints.find((e) => e.endpointKey === endpointKey);
      assert.ok(endpoint, `endpoint ${endpointKey} present`);
      const example = endpoint.example;
      assert.ok(example, `example present for ${endpointKey}`);

      // Example field set = (required ∪ {prompt}) minus runner-managed.
      const expectedFields = endpoint.fields.filter(
        (field) =>
          field.kind !== 'runner-managed' &&
          (field.required || field.name === 'prompt'),
      );
      assert.deepEqual(
        Object.keys(example.request).sort(),
        expectedFields.map((field) => field.name).sort(),
      );

      // No runner-managed field is ever synthesized into the example body.
      for (const field of endpoint.fields) {
        if (field.kind === 'runner-managed') {
          assert.equal(Object.hasOwn(example.request, field.name), false);
        }
      }

      // Every enum field in the example takes its FIRST value.
      for (const field of expectedFields) {
        if (field.enumValues && field.enumValues.length > 0) {
          const expected = field.repeatable
            ? [field.enumValues[0]]
            : field.enumValues[0];
          assert.deepEqual(example.request[field.name], expected);
        }
      }

      // The command is copy-pasteable in the endpoint's own surface form, and the
      // estimate line prices the same request with no charge.
      assert.match(
        example.command,
        new RegExp(`^postplus media \\w+ ${endpointKey}`, 'u'),
      );
      assert.match(
        example.estimate,
        new RegExp(`^postplus media estimate ${endpointKey}`, 'u'),
      );
    }
  });

  it('rejects unknown hosted media schema endpoints', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'media',
        'schema',
        '--endpoint',
        'video-missing-provider',
        '--json',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown media endpoint video-missing-provider/u,
        );
        assert.match(execError.stderr ?? '', /video-seedance-2-text/u);
        return true;
      },
    );
  });

  it('rejects unknown hosted research schema routes', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'research',
        'schema',
        '--route',
        'instagram-missing-provider',
        '--json',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown research route instagram-missing-provider/u,
        );
        assert.match(execError.stderr ?? '', /youtube-channel-summary/u);
        return true;
      },
    );
  });

  it('prints a per-endpoint flags-surface --help with the three-class field breakdown', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'transcribe',
      'transcription',
      '--help',
    ]);

    assert.match(stdout, /media transcribe transcription/u);
    assert.match(stdout, /Surface: flags/u);
    assert.match(stdout, /Intent \(you must \/ may write\):/u);
    assert.match(
      stdout,
      /--audio {2}\[audio input: local path \| HTTPS \| PostPlus media reference \| data URI; required\]/u,
    );
    assert.match(
      stdout,
      /--task {2}\[string; optional; one of \{transcribe, translate\}; default transcribe\]/u,
    );
    assert.match(
      stdout,
      /Runner-managed \(minted by the CLI; never an input\):/u,
    );
    assert.match(stdout, /mediaSeconds \(derived from duration_seconds\)/u);
    // runner-managed fields are never exposed as flags in the help.
    assert.doesNotMatch(stdout, /--operationId/u);
  });

  it('prints a per-endpoint flags --help with enum sets, ranges, and defaults', async () => {
    // seedance moved from request-json to the flags surface; the per-endpoint help
    // must still render the manifest enum sets, numeric ranges, and defaults.
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'create',
      'video-seedance-2-text',
      '--help',
    ]);

    assert.match(stdout, /media create video-seedance-2-text/u);
    assert.match(stdout, /Surface: flags/u);
    assert.match(
      stdout,
      /--aspect-ratio {2}\[string; optional; one of \{21:9, 16:9, 4:3, 1:1, 3:4, 9:16\}\]/u,
    );
    assert.match(
      stdout,
      /--resolution {2}\[string; optional; one of \{480p, 720p, 1080p\}; default 720p\]/u,
    );
    assert.match(
      stdout,
      /--duration {2}\[number; optional; range 4\.\.15; default 5\]/u,
    );
    assert.match(
      stdout,
      /Runner-managed \(minted by the CLI; never an input\):/u,
    );
    assert.match(stdout, /\n {4}requestDimensions\n/u);
  });

  it('prints per-target help for semantic research, opaque publish, and normalized video analysis', async () => {
    const { stdout: researchHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'run',
      'tiktok-videos',
      '--help',
    ]);
    assert.match(researchHelp, /research run tiktok-videos/u);
    assert.match(researchHelp, /--query/u);
    assert.match(researchHelp, /--limit/u);
    assert.doesNotMatch(
      researchHelp,
      /provider|actor|dataset|collectionKey|sourceKey|--request/u,
    );

    const { stdout: analyzeHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'analyze',
      'video-analysis',
      '--help',
    ]);
    assert.match(analyzeHelp, /flags \(normalized media intent\)/u);
    assert.match(analyzeHelp, /--video <video>.*--prompt <prompt>/u);
    assert.doesNotMatch(analyzeHelp, /Gemini request payload|file_reference/u);

    const { stdout: publishHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'publish',
      'create-post',
      '--help',
    ]);
    assert.match(publishHelp, /PostPlus CLI - publish create-post\n/u);
    assert.match(publishHelp, /Capability: social-publishing/u);
  });

  it('submits semantic Research flags to the unified route without private fields', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-research-run-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedUrl: string | null = null;
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (input, init) => {
      postedUrl = String(input);
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          routeKey: 'google-trends-fast',
          status: 'completed',
          output: { items: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      assert.equal(
        await runHostedDomainCommand('research', [
          'run',
          'google-trends-fast',
          '--query',
          'portable blender',
          '--output',
          outputPath,
        ]),
        0,
      );
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/research',
      );
      assert.equal(postedBody?.routeKey, 'google-trends-fast');
      assert.deepEqual(postedBody?.input, {
        query: 'portable blender',
        country: 'US',
        time_range: 'today 12-m',
      });
      assert.doesNotMatch(
        JSON.stringify(postedBody),
        /actorId|datasetId|collectionKey|sourceKey|maxTotalChargeUsd/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits by polling the same unified Research handle and never resubmits', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-research-wait-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    const skillHeaders: Array<string | undefined> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      skillHeaders.push(
        Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        )['x-postplus-skill-name'],
      );
      return new Response(
        JSON.stringify(
          bodies.length === 1
            ? {
                routeKey: 'google-trends-fast',
                runHandle: 'sealed-run-1',
                status: 'processing',
              }
            : {
                routeKey: 'google-trends-fast',
                runHandle: null,
                status: 'completed',
                output: { items: [{ query: 'portable blender' }] },
              },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      assert.equal(
        await runHostedDomainCommand('research', [
          'run',
          'google-trends-fast',
          '--query',
          'portable blender',
          '--wait',
          '--poll-interval-seconds',
          '0.001',
          '--output',
          outputPath,
        ]),
        0,
      );
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0]?.routeKey, 'google-trends-fast');
      assert.deepEqual(bodies[1], {
        routeKey: 'google-trends-fast',
        runHandle: 'sealed-run-1',
      });
      assert.deepEqual(skillHeaders, ['google-trends-research', undefined]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checkpoints an accepted Research run before polling and preserves it when polling fails', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-research-checkpoint-first-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            routeKey: 'google-trends-fast',
            runHandle: 'sealed-run-checkpoint-1',
            status: 'processing',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          code: 'postplus_cli_research_poll_unavailable',
          error: 'Research status is temporarily unavailable.',
          status: 503,
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      assert.equal(
        await runHostedDomainCommand('research', [
          'run',
          'google-trends-fast',
          '--query',
          'portable blender',
          '--wait',
          '--poll-interval-seconds',
          '0.001',
          '--output',
          outputPath,
        ]),
        1,
      );
      assert.equal(bodies.length, 2);
      assert.equal(typeof bodies[0]?.operationId, 'string');
      assert.deepEqual(bodies[1], {
        routeKey: 'google-trends-fast',
        runHandle: 'sealed-run-checkpoint-1',
      });
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), {
        routeKey: 'google-trends-fast',
        runHandle: 'sealed-run-checkpoint-1',
        status: 'processing',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resumes a Research checkpoint in a new invocation without submitting again', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-research-resume-'),
    );
    tempDirs.push(requestDir);
    const checkpointPath = resolve(requestDir, 'result.json');
    await writeFile(
      checkpointPath,
      JSON.stringify({
        routeKey: 'google-trends-fast',
        runHandle: 'sealed-run-resume-1',
        status: 'processing',
      }),
    );
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    globalThis.fetch = async (_input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([key, value]) => [key.toLowerCase(), value],
          ),
        ),
      });
      return new Response(
        JSON.stringify({
          routeKey: 'google-trends-fast',
          runHandle: null,
          status: 'completed',
          output: { items: [{ query: 'portable blender' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      assert.equal(
        await runHostedDomainCommand('research', [
          'run',
          '--resume-from',
          checkpointPath,
          '--wait-seconds',
          '0',
        ]),
        0,
      );
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.body, {
        routeKey: 'google-trends-fast',
        runHandle: 'sealed-run-resume-1',
      });
      assert.equal(requests[0]?.headers['x-postplus-skill-name'], undefined);
      assert.equal(
        (
          JSON.parse(await readFile(checkpointPath, 'utf8')) as {
            status: string;
          }
        ).status,
        'completed',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects legacy Research commands and invalid semantic intent before network access', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}');
    };
    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('research', [
            'collect',
            'google-trends-fast',
            '--request',
            'request.json',
          ]),
        /research collect was removed/u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('research', [
            'run',
            'google-trends-fast',
            '--query',
            'portable blender',
            '--limit',
            '20',
          ]),
        /Unknown option for research run: --limit/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('submits a manifest-driven transcribe request with derived billing dimensions', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'transcribe',
        'transcription',
        '--audio',
        'https://example.com/a.mp3',
        '--duration-seconds',
        '30',
        '--enable-timestamps',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.operation, 'request');
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:media-generation:request:/u,
      );
      assert.deepEqual(body.input, {
        audio: 'https://example.com/a.mp3',
        duration_seconds: 30,
        enable_timestamps: true,
        language: 'auto',
        task: 'transcribe',
      });
      // The CLI sends only the payload; billing dimensions are derived solely at
      // the Web boundary, so the wire body carries no requestDimensions.
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('estimates a flags-surface media request against /hosted/estimate with the same input and no spend fields', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedUrl: string | null = null;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      postedUrl = String(input);
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          estimateOnly: true,
          endpointKey: 'transcription',
          estimatedCredits: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'estimate',
        'transcription',
        '--audio',
        'https://example.com/a.mp3',
        '--duration-seconds',
        '30',
        '--enable-timestamps',
      ]);
      assert.equal(result, 0);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/estimate',
      );
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.endpointKey, 'transcription');
      // The estimate posts the SAME canonical input a create submit would post.
      assert.deepEqual(body.input, {
        audio: 'https://example.com/a.mp3',
        duration_seconds: 30,
        enable_timestamps: true,
        language: 'auto',
        task: 'transcribe',
      });
      // A dry-run estimate carries NO spend fields: no operationId, no
      // quote-confirmation token, no operation verb, no requestDimensions.
      assert.equal(Object.hasOwn(body, 'operationId'), false);
      assert.equal(Object.hasOwn(body, 'operation'), false);
      assert.equal(Object.hasOwn(body, 'quoteConfirmationToken'), false);
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stages a local role input for an exact estimate without a provider submit', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const inputDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-estimate-media-'),
    );
    tempDirs.push(inputDir);
    const localImage = resolve(inputDir, 'person.png');
    await writeFile(localImage, 'png-bytes');

    const originalFetch = globalThis.fetch;
    const hostedBodies: Record<string, unknown>[] = [];
    let putCount = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://storage.example.com/estimate-upload') {
        putCount += 1;
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      hostedBodies.push(body);
      if (body.capability === 'media-file') {
        return new Response(
          JSON.stringify({
            output: {
              mediaReference:
                'postplus-media://uploads/users/user_1/hosted-media/inputs/person.png',
              signedUpload: {
                method: 'PUT',
                requiredHeaders: { 'content-type': 'image/png' },
                url: 'https://storage.example.com/estimate-upload',
              },
              storageReference: {
                bucket: 'uploads',
                mimeType: 'image/png',
                name: 'person.png',
                storagePath: 'users/user_1/hosted-media/inputs/person.png',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ estimateOnly: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'estimate',
          'image-gpt-image-2-edit',
          '--prompt',
          'change the jacket color',
          '--reference-image',
          localImage,
        ]),
        0,
      );
      assert.equal(putCount, 1);
      assert.equal(hostedBodies.length, 2);
      assert.equal(hostedBodies[0]!.operation, 'create-upload-url');
      assert.deepEqual(
        (hostedBodies[1]!.input as Record<string, unknown>).images,
        [
          'postplus-media://uploads/users/user_1/hosted-media/inputs/person.png',
        ],
      );
      assert.equal(Object.hasOwn(hostedBodies[1]!, 'operationId'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects spend-only flags and unknown endpoints on media estimate before any call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'estimate',
            'transcription',
            '--audio',
            'https://example.com/a.mp3',
            '--duration-seconds',
            '30',
            '--quote-confirmation-token',
            'tok',
          ]),
        (error: unknown) =>
          error instanceof Error &&
          /Unknown option for media estimate: --quote-confirmation-token/u.test(
            error.message,
          ),
      );
      await assert.rejects(
        () => runHostedDomainCommand('media', ['estimate', 'not-an-endpoint']),
        (error: unknown) =>
          error instanceof Error &&
          /Unknown media estimate endpoint not-an-endpoint/u.test(
            error.message,
          ),
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a literal resume command on an async-pending media submit in both human and --json modes', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-resume-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'generation result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const runSubmit = async (extraArgs: string[], responseBody: unknown) => {
      const originalFetch = globalThis.fetch;
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      let stderrText = '';
      globalThis.fetch = async () =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      process.stderr.write = ((chunk: unknown) => {
        stderrText += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        const result = await runHostedDomainCommand('media', [
          'transcribe',
          'transcription',
          '--audio',
          'https://example.com/a.mp3',
          '--duration-seconds',
          '30',
          ...extraArgs,
        ]);
        assert.equal(result, 0);
        return stderrText;
      } finally {
        globalThis.fetch = originalFetch;
        process.stderr.write = originalStderrWrite;
        process.stdout.write = originalStdoutWrite;
      }
    };

    const pending = { output: { data: { id: 'run_1', status: 'processing' } } };

    // Human mode: the run id is already in the stdout payload; the LITERAL resume
    // command is emitted to stderr so it is never lost.
    const humanStderr = await runSubmit([], pending);
    assert.match(humanStderr, /postplus media poll --handle 'run_1'/u);

    // --json mode: same literal resume command on stderr (stdout stays pure JSON).
    const jsonStderr = await runSubmit(['--json'], pending);
    assert.match(jsonStderr, /postplus media poll --handle 'run_1'/u);

    // When the submit result was projected to a file, resume the same file so
    // a completed poll atomically replaces the stale processing projection.
    const outputStderr = await runSubmit(['--output', outputPath], pending);
    assert.ok(
      outputStderr.includes(
        `postplus media poll --handle 'run_1' --output '${outputPath}'`,
      ),
    );

    // Preparation is published before POST; a completed response must not
    // falsely claim that another poll is required.
    const terminalStderr = await runSubmit([], {
      output: { data: { id: 'run_1', status: 'completed' } },
    });
    assert.doesNotMatch(terminalStderr, /Async run pending/iu);
  });

  it('submits once and waits by polling only the returned run handle', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const payload =
        body.operation === 'request'
          ? { output: { data: { id: 'run_wait_1', status: 'processing' } } }
          : { output: { data: { id: 'run_wait_1', status: 'completed' } } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-text',
        '--prompt',
        'a red umbrella',
        '--wait',
        '--wait-seconds',
        '0',
      ]);
      assert.equal(result, 0);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0]?.operation, 'request');
      assert.equal(bodies[1]?.operation, 'status');
      assert.equal(bodies[1]?.handle, 'run_wait_1');
      assert.equal('input' in bodies[1]!, false);
      assert.equal('quoteConfirmationToken' in bodies[1]!, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('polls a pending media run by handle against /hosted/capability', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedUrl: string | null = null;
    let postedBody: unknown = null;
    let fetchCalls = 0;
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      postedUrl = String(input);
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: { data: { id: 'run_1', status: 'processing' } },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'poll',
        '--handle',
        'run_1',
        '--wait-seconds',
        '0',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      // --wait-seconds 0 is the single-shot legacy check: exactly one status
      // request even though the run is still processing.
      assert.equal(fetchCalls, 1);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.operation, 'status');
      assert.equal(body.handle, 'run_1');
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:media-generation:status:/u,
      );
      // A poll resumes an existing run; it never carries submit-only billing
      // fields, so it cannot re-reserve or re-charge.
      assert.equal('input' in body, false);
      assert.equal('requestDimensions' in body, false);
      assert.equal('quoteConfirmationToken' in body, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces the media poll host and nested transport cause without leaking request paths', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const networkCause = Object.assign(
      new Error('getaddrinfo ENOTFOUND postplus.test'),
      {
        code: 'ENOTFOUND',
        hostname: 'postplus.test',
        syscall: 'getaddrinfo',
      },
    );
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', { cause: networkCause });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'poll',
            '--handle',
            'private-run-handle',
            '--wait-seconds',
            '0',
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /code=postplus_cli_cloud_transport_failed, method=POST, host=postplus\.test/u,
          );
          assert.match(error.message, /TypeError: fetch failed/u);
          assert.match(
            error.message,
            /code=ENOTFOUND.*syscall=getaddrinfo.*hostname=postplus\.test/u,
          );
          assert.doesNotMatch(error.message, /hosted\/capability/u);
          assert.doesNotMatch(error.message, /private-run-handle/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps poll debug diagnostics on stderr while atomically replacing the result JSON', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-poll-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'generation-result.json');
    await writeFile(outputPath, '{"status":"processing"}\n');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const payload = {
      output: { data: { id: 'run_1', status: 'completed' } },
    };
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    let stderrText = '';
    let stdoutText = '';
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      stdoutText += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await runHostedDomainCommand('media', [
        'poll',
        '--handle',
        'run_1',
        '--wait-seconds',
        '0',
        '--debug',
        '--json',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      assert.deepEqual(JSON.parse(stdoutText), payload);
      assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), payload);
      assert.deepEqual(await readdir(requestDir), ['generation-result.json']);
      assert.match(
        stderrText,
        /cloud request method=POST target=https:\/\/postplus\.test\/api\/postplus-cli\/hosted\/capability/u,
      );
      assert.match(stderrText, /cloud response status=200/u);
      assert.doesNotMatch(stdoutText, /postplus debug/u);
      assert.doesNotMatch(stderrText, /cli-session-token/u);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    }
  });

  it('fast-fails authenticated redirects without exposing their target outside debug stderr', async () => {
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let fetchCalls = 0;
    let stderrText = '';
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://redirect.test/private/run_1?token=secret-redirect-token',
        },
      });
    };
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand(
            'media',
            ['poll', '--handle', 'run_1', '--wait-seconds', '0', '--debug'],
            {
              auth: {
                apiBaseUrl: 'https://postplus.test',
                cliSessionToken: 'cli-session-token',
              },
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /method=POST, host=postplus\.test\): Unexpected HTTP 302 redirect\./u,
          );
          assert.doesNotMatch(error.message, /redirect\.test/u);
          assert.doesNotMatch(error.message, /private\/run_1/u);
          assert.doesNotMatch(error.message, /secret-redirect-token/u);
          return true;
        },
      );
      assert.equal(fetchCalls, 1);
      assert.match(
        stderrText,
        /redirect status=302 .* to=https:\/\/redirect\.test\/private\/run_1/u,
      );
      assert.doesNotMatch(stderrText, /secret-redirect-token/u);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  it('fast-fails the media poll verb without a handle before any hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () => runHostedDomainCommand('media', ['poll']),
        /Missing required option --handle\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps polling a media run inside one invocation until the run is terminal', async () => {
    const originalFetch = globalThis.fetch;
    const statuses = ['processing', 'processing', 'completed'];
    let fetchCalls = 0;
    const operationIds: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      operationIds.push(String(body.operationId));
      const status = statuses[Math.min(fetchCalls, statuses.length - 1)];
      fetchCalls += 1;
      return new Response(
        JSON.stringify({ output: { data: { id: 'run_1', status } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      // Lib path (context-injected auth) returns the payload directly. Tiny
      // interval keeps the loop real but the test fast.
      const payload = (await runHostedDomainCommand(
        'media',
        [
          'poll',
          '--handle',
          'run_1',
          '--wait-seconds',
          '5',
          '--poll-interval-seconds',
          '0.05',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      )) as { output: { data: { status: string } } };
      assert.equal(fetchCalls, 3);
      assert.equal(payload.output.data.status, 'completed');
      // Every status check is an independent read: fresh operationId each time,
      // so the wait loop can never collide with reserve idempotency.
      assert.equal(new Set(operationIds).size, 3);
      for (const operationId of operationIds) {
        assert.match(
          operationId,
          /^postplus-cli:media:media-generation:status:/u,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns the latest still-processing payload once the poll wait budget is spent', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          output: { data: { id: 'run_1', status: 'processing' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const payload = (await runHostedDomainCommand(
        'media',
        [
          'poll',
          '--handle',
          'run_1',
          '--wait-seconds',
          '0.12',
          '--poll-interval-seconds',
          '0.05',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      )) as { output: { data: { status: string } } };
      // Bounded: it re-checked at least once, then surfaced the honest
      // still-processing payload instead of waiting forever.
      assert.ok(fetchCalls >= 2);
      assert.equal(payload.output.data.status, 'processing');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not sleep when the first media poll check is already terminal', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({ output: { data: { id: 'run_1', status: 'failed' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const startedAt = Date.now();
      await assert.rejects(
        runHostedDomainCommand('media', ['poll', '--handle', 'run_1'], {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        }),
        /postplus_cli_hosted_media_run_failed/u,
      );
      assert.equal(fetchCalls, 1);
      // Default 45s budget must not be spent on a terminal run: no interval
      // sleep may have happened.
      assert.ok(Date.now() - startedAt < 5000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails out-of-domain media poll wait flags before any hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'poll',
            '--handle',
            'run_1',
            '--wait-seconds',
            '-1',
          ]),
        /--wait-seconds must be a number between 0 and 600\./u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'poll',
            '--handle',
            'run_1',
            '--wait-seconds',
            'abc',
          ]),
        /--wait-seconds must be a number between 0 and 600\./u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'poll',
            '--handle',
            'run_1',
            '--poll-interval-seconds',
            '0',
          ]),
        /--poll-interval-seconds must be a number between 0 \(exclusive\) and 60\./u,
      );
      // Sub-millisecond positive intervals round to 0ms and must be rejected
      // like 0 itself (0ms would mean an unthrottled polling loop).
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'poll',
            '--handle',
            'run_1',
            '--poll-interval-seconds',
            '0.0004',
          ]),
        /--poll-interval-seconds must be a number between 0 \(exclusive\) and 60\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails the transcribe verb without a duration before any hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'transcribe',
            'transcription',
            '--audio',
            'https://example.com/a.mp3',
          ]),
        /Missing required option --duration-seconds/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects runner-managed billing flags on the transcribe verb', async () => {
    await assert.rejects(
      () =>
        runHostedDomainCommand('media', [
          'transcribe',
          'transcription',
          '--audio',
          'https://example.com/a.mp3',
          '--duration-seconds',
          '30',
          '--media-seconds',
          '30',
        ]),
      /Unknown option for media transcribe: --media-seconds/u,
    );
  });

  it('submits a manifest-driven seedance request (flags) with derived billing dimensions', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'video-seedance-2-text',
        '--prompt',
        'a blue sticky note slides across a white desk',
        '--resolution',
        '720p',
        '--duration',
        '5',
        '--aspect-ratio',
        '9:16',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.operation, 'request');
      assert.equal(body.endpointKey, 'video-seedance-2-text');
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:media-generation:request:/u,
      );
      // agent flags plus the remaining manifest default (generate_audio) filled in.
      assert.deepEqual(body.input, {
        prompt: 'a blue sticky note slides across a white desk',
        resolution: '720p',
        duration: 5,
        aspect_ratio: '9:16',
        generate_audio: true,
      });
      // Billing dimensions are derived solely at the Web boundary; the CLI sends
      // only the payload (with input defaults filled above), no requestDimensions.
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('discovers six semantic Seedance 2.5 scene contracts without private scene fields', () => {
    const endpointKeys = [
      'video-seedance-2-5-text',
      'video-seedance-2-5-edit',
      'video-seedance-2-5-extend',
      'video-seedance-2-5-first-frame',
      'video-seedance-2-5-first-last-frame',
      'video-seedance-2-5-reference',
    ];
    const report = buildHostedRequestSchemaReport({ domain: 'media' });
    for (const endpointKey of endpointKeys) {
      assert.ok(report.endpointKeys?.includes(endpointKey));
    }

    const selected = buildHostedRequestSchemaReport({
      domain: 'media',
      endpointKey: 'video-seedance-2-5-reference',
    });
    const endpoint = selected.endpoints?.[0];
    assert.equal(endpoint?.endpointKey, 'video-seedance-2-5-reference');
    const byName = new Map(
      endpoint?.fields.map((field) => [field.name, field]) ?? [],
    );
    assert.deepEqual(byName.get('resolution')?.enumValues, ['480p', '720p']);
    assert.deepEqual(byName.get('duration')?.specialValues, [-1]);
    assert.equal(byName.get('reference_images')?.maxItems, 30);
    assert.equal(byName.get('reference_videos')?.maxItems, 10);
    assert.equal(byName.get('reference_audios')?.maxItems, 10);
    assert.equal(byName.has('omni_reference_task_type'), false);

    for (const fixedEndpointKey of [
      'video-seedance-2-5-first-frame',
      'video-seedance-2-5-first-last-frame',
      'video-seedance-2-5-edit',
      'video-seedance-2-5-extend',
    ]) {
      const fixed = buildHostedRequestSchemaReport({
        domain: 'media',
        endpointKey: fixedEndpointKey,
      }).endpoints?.[0];
      const fixedNames = new Set(
        fixed?.fields.map((field) => field.name) ?? [],
      );
      assert.equal(fixedNames.has('aspect_ratio'), false);
      if (fixedEndpointKey !== 'video-seedance-2-5-first-frame') {
        assert.equal(fixedNames.has('duration'), false);
      }
      assert.equal(fixedNames.has('omni_reference_task_type'), false);
    }
  });

  it('maps each Seedance 2.5 scene flags to its exact, non-overlapping Web input', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const posted: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const cases: Array<{
        args: string[];
        expected: Record<string, unknown>;
      }> = [
        {
          args: ['video-seedance-2-5-text', '--prompt', 'text scene'],
          expected: {
            prompt: 'text scene',
            resolution: '720p',
            aspect_ratio: 'adaptive',
            duration: 5,
            generate_audio: true,
            output_format: 'mp4',
          },
        },
        {
          args: [
            'video-seedance-2-5-first-frame',
            '--prompt',
            'opening scene',
            '--first-frame',
            'https://example.com/open.png',
          ],
          expected: {
            prompt: 'opening scene',
            first_frame: 'https://example.com/open.png',
            resolution: '720p',
            duration: 5,
            generate_audio: true,
            output_format: 'mp4',
          },
        },
        {
          args: [
            'video-seedance-2-5-first-last-frame',
            '--prompt',
            'bridge two frames',
            '--first-frame',
            'https://example.com/open.png',
            '--last-frame',
            'https://example.com/close.png',
          ],
          expected: {
            prompt: 'bridge two frames',
            first_frame: 'https://example.com/open.png',
            last_frame: 'https://example.com/close.png',
            resolution: '720p',
            generate_audio: true,
            output_format: 'mp4',
          },
        },
        {
          args: [
            'video-seedance-2-5-reference',
            '--prompt',
            'use multimodal references',
            '--reference-image',
            'https://example.com/person.png',
            '--reference-video',
            'https://example.com/motion.mp4',
            '--reference-audio',
            'https://example.com/voice.wav',
          ],
          expected: {
            prompt: 'use multimodal references',
            resolution: '720p',
            aspect_ratio: 'adaptive',
            duration: 5,
            reference_images: ['https://example.com/person.png'],
            reference_videos: ['https://example.com/motion.mp4'],
            reference_audios: ['https://example.com/voice.wav'],
            generate_audio: true,
            output_format: 'mp4',
          },
        },
        {
          args: [
            'video-seedance-2-5-edit',
            '--prompt',
            'replace the subject',
            '--reference-video',
            'https://example.com/source.mp4',
            '--reference-image',
            'https://example.com/person.png',
          ],
          expected: {
            prompt: 'replace the subject',
            resolution: '720p',
            reference_videos: ['https://example.com/source.mp4'],
            reference_images: ['https://example.com/person.png'],
            generate_audio: true,
            output_format: 'mp4',
          },
        },
      ];

      for (const testCase of cases) {
        assert.equal(
          await runHostedDomainCommand('media', ['create', ...testCase.args]),
          0,
        );
      }
      assert.deepEqual(
        posted.map((body) => body.input),
        cases.map((testCase) => testCase.expected),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails invalid Seedance 2.5 duration, resolution, and reference cardinality before a hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-5-text',
            '--prompt',
            'clip',
            '--duration',
            '31',
          ]),
        /duration must be an integer from 4 to 30 or one of -1/u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-5-text',
            '--prompt',
            'clip',
            '--resolution',
            '1080p',
          ]),
        /resolution must be one of 480p, 720p/u,
      );
      const references = Array.from({ length: 31 }, (_, index) => [
        '--reference-image',
        `https://example.com/reference-${index}.png`,
      ]).flat();
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-5-reference',
            '--prompt',
            'clip',
            ...references,
          ]),
        /reference_images must contain at most 30 item/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('derives seedance billing defaults from the manifest when the agent omits them', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      // Agent supplies only the prompt — no resolution/duration.
      const result = await runHostedDomainCommand('media', [
        'create',
        'video-seedance-2-text',
        '--prompt',
        'a blue sticky note slides across a white desk',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      // The flags surface fills the manifest defaults into input, so the billing
      // dimensions (duration/resolution) are derived from the manifest defaults...
      assert.deepEqual(body.input, {
        prompt: 'a blue sticky note slides across a white desk',
        resolution: '720p',
        duration: 5,
        generate_audio: true,
      });
      // ...and billing dimensions are derived solely at the Web boundary, so the
      // CLI body carries no requestDimensions.
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('switches a default-true boolean off with an explicit --generate-audio false', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const postedInputs: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      postedInputs.push(body.input as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      // Explicit false: the only way to disable Seedance native audio now that
      // the request-json envelope is retired (registry default is true).
      assert.equal(
        await runHostedDomainCommand('media', [
          'create',
          'video-seedance-2-text',
          '--prompt',
          'silent clip',
          '--generate-audio',
          'false',
        ]),
        0,
      );
      assert.equal(postedInputs[0]?.generate_audio, false);

      // Bare presence keeps the published presence-equals-true grammar.
      assert.equal(
        await runHostedDomainCommand('media', [
          'create',
          'video-seedance-2-text',
          '--prompt',
          'audible clip',
          '--generate-audio',
        ]),
        0,
      );
      assert.equal(postedInputs[1]?.generate_audio, true);

      // A non-boolean token after a boolean flag stays a positional error.
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-text',
            '--prompt',
            'clip',
            '--generate-audio',
            'banana',
          ]),
        /Unexpected positional argument: banana/,
      );
      assert.equal(postedInputs.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects --request and --request-dimensions as unknown flags on the seedance create verb before any hosted call', async () => {
    // flags surface: runner-managed fields (requestDimensions & co.) have no flag
    // and there is no whole-body --request escape hatch anymore, so the agent has
    // no way to carry runner-managed input at all — both spellings must be
    // rejected locally as unknown options before any hosted call.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      for (const flag of ['--request', '--request-dimensions']) {
        await assert.rejects(
          () =>
            runHostedDomainCommand('media', [
              'create',
              'video-seedance-2-text',
              '--prompt',
              'a blue sticky note slides across a white desk',
              flag,
              'agent-supplied',
            ]),
          new RegExp(
            `Unknown option for media create: ${flag.replace(/[-]/gu, '[-]')}\\.`,
            'u',
          ),
        );
      }
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails an out-of-enum seedance resolution (flags) before any hosted call (#475)', async () => {
    // The #475 repro: an invalid resolution previously sailed to the provider and
    // surfaced as a generic internal failure. It must fast-fail locally as a
    // field-level error before any call.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-text',
            '--prompt',
            'a cinematic product reveal',
            '--resolution',
            '999p',
          ]),
        /video-seedance-2-text resolution must be one of 480p, 720p, 1080p; received "999p"\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails an out-of-range seedance duration (flags) before any hosted call (#475)', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-text',
            '--prompt',
            'a cinematic product reveal',
            '--duration',
            '99',
          ]),
        /video-seedance-2-text duration must be an integer from 4 to 15; received 99\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a mixed-case seedance resolution (flags) by canonicalizing before the enum check (#475)', async () => {
    // "720P" is not literally in the {480p,720p,1080p} enum but the manifest
    // canonicalize hint lowercases it, mirroring the Web boundary, so it must pass.
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'video-seedance-2-text',
        '--prompt',
        'a cinematic product reveal',
        '--resolution',
        '720P',
      ]);
      assert.equal(result, 0);
      // The CLI passes the raw flag value through (the Web boundary canonicalizes
      // the outbound body); local validation only canonicalizes for the check.
      const body = postedBody as Record<string, unknown>;
      assert.equal((body.input as Record<string, unknown>).resolution, '720P');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fast-fails an out-of-enum voice language and accepts the exact-cased one (flags) (#475)', async () => {
    // voice `language` is NOT canonicalized (no hint) — it matches the provider's
    // exact Title-cased enum, so "english" fails while "English" passes. This is the
    // canonicalization-faithfulness guarantee in the other direction.
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'voice-design',
            '--text',
            'hello there',
            '--voice-description',
            'a warm narrator',
            '--language',
            'english',
          ]),
        /voice-design language must be one of .*English.*; received "english"\./u,
      );
      assert.equal(fetchCalls, 0);

      const result = await runHostedDomainCommand('media', [
        'create',
        'voice-design',
        '--text',
        'hello there',
        '--voice-description',
        'a warm narrator',
        '--language',
        'English',
      ]);
      assert.equal(result, 0);
      assert.equal(fetchCalls, 1);
      const body = postedBody as Record<string, unknown>;
      assert.equal((body.input as Record<string, unknown>).language, 'English');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('submits normalized video-analysis intent without a provider payload', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      assert.equal(
        new Headers(init?.headers).get('x-postplus-skill-name'),
        'media-analysis',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand(
        'media',
        [
          'analyze',
          'video-analysis',
          '--video',
          'postplus-media://uploads/users/user_1/hosted-media/inputs/clip.mp4',
          '--prompt',
          'Analyze this video for hook, pacing, and CTA.',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      );
      assert.deepEqual(result, { ok: true });
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'video-analysis');
      assert.equal(body.operation, 'analyze');
      assert.equal(body.modelKey, 'video-analysis');
      assert.deepEqual(body.input, {
        prompt: 'Analyze this video for hook, pacing, and CTA.',
        video:
          'postplus-media://uploads/users/user_1/hosted-media/inputs/clip.mp4',
      });
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:video-analysis:analyze:/u,
      );
      // The locked Web contract is strict — no provider request JSON or
      // media-generation billing dimensions can be authored by the agent.
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
      assert.equal(Object.hasOwn(body, 'endpointKey'), false);
      assert.equal(Object.hasOwn(body, 'payload'), false);
      assert.equal(Object.hasOwn(body, 'estimatedUsage'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports obsolete bare video-analysis flags as unsupported before any hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'analyze',
            'video-analysis',
            '--video',
            'postplus-media://uploads/users/user_1/hosted-media/inputs/clip.mp4',
            '--prompt',
            'Analyze this clip.',
            '--wait',
          ]),
        /Unknown option for media analyze: --wait\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('submits a social video URL byte-for-byte without a local resolver or storage upload', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const pageUrl = 'https://www.tiktok.com/@creator/video/7675141620601195789';
    const originalFetch = globalThis.fetch;
    const hostedBodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      hostedBodies.push(body);
      return new Response(
        JSON.stringify({
          output: {
            data: {
              elapsedMs: 0,
              id: 'video-run-1',
              markdown: '# Analysis',
              progress: { elapsedMs: 0, stage: 'completed' },
              stage: 'completed',
              status: 'completed',
            },
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      );
    };

    try {
      const result = await runHostedDomainCommand(
        'media',
        [
          'analyze',
          'video-analysis',
          '--video',
          pageUrl,
          '--prompt',
          'Analyze this TikTok video.',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      );
      assert.deepEqual(result, '# Analysis');
      assert.equal(hostedBodies.length, 1);
      assert.equal(hostedBodies[0]?.capability, 'video-analysis');
      assert.equal(hostedBodies[0]?.operation, 'analyze');
      assert.deepEqual(hostedBodies[0]?.input, {
        prompt: 'Analyze this TikTok video.',
        video: pageUrl,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const disconnect of [false, true]) {
    it(`analyzes a real local file through one upload and durable run${disconnect ? ', resuming a disconnected poll from its checkpoint' : ''}`, async () => {
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'private-local-session-token',
        userId: 'user_1',
        sessionExpiresAt: null,
      });
      const fixture = await tinyVideoFixture();
      const localVideo = fixture.filePath;
      const videoBytes = fixture.bytes;
      const mediaReference =
        'postplus-video://sealed-local-token/files/local-video';
      const signedUploadUrl =
        'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=private-upload-token';
      const markdown =
        '# Local analysis\n\n## Evidence\n\n00:00–00:01 Observable hook.\n\n## Limitations\n\nNo supported claim omitted.\n';
      const originalFetch = globalThis.fetch;
      const originalOut = process.stdout.write;
      const originalErr = process.stderr.write;
      const bodies: Record<string, unknown>[] = [];
      let stdout = '';
      let stderr = '';
      let uploadCount = 0;
      let completedPolls = 0;
      let resumed = false;
      let checkpointPath = '';
      let sourceOperationId = '';
      process.stdout.write = ((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      globalThis.fetch = async (url, init) => {
        if (String(url) === signedUploadUrl) {
          uploadCount++;
          assert.equal(init?.method, 'POST');
          assert.equal(
            new Headers(init?.headers).get('x-goog-upload-command'),
            'upload, finalize',
          );
          assert.equal(new Headers(init?.headers).has('x-goog-api-key'), false);
          const chunks: Buffer[] = [];
          for await (const chunk of init?.body as unknown as ReadStream) {
            chunks.push(Buffer.from(chunk));
          }
          assert.deepEqual(Buffer.concat(chunks), videoBytes);
          return Response.json({ file: { name: 'files/local-video' } });
        }
        assert.equal(
          String(url),
          'https://postplus.test/api/postplus-cli/hosted/capability',
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        assert.notEqual(body.capability, 'media-file');
        if (body.operation === 'prepare-upload') {
          const input = body.input as {
            metadata: { bytes: number; sha256: string; hasAudio: boolean };
          };
          assert.equal(input.metadata.bytes, videoBytes.length);
          assert.equal(
            input.metadata.sha256,
            createHash('sha256').update(videoBytes).digest('hex'),
          );
          assert.equal(input.metadata.hasAudio, true);
          sourceOperationId = String(body.operationId);
          return Response.json({
            output: {
              uploadUrl: signedUploadUrl,
              uploadToken: 'sealed-local-token',
              expiresAt: Date.now() + 60_000,
            },
          });
        }
        assert.equal(body.capability, 'video-analysis');
        if (body.operation === 'analyze') {
          assert.equal(uploadCount, 1);
          assert.deepEqual(body.input, {
            video: mediaReference,
            prompt: 'private local prompt',
          });
          const directory = resolve(
            process.env.POSTPLUS_CONFIG_DIR!,
            'media-runs',
          );
          const files = await readdir(directory);
          assert.equal(
            files.length,
            1,
            'checkpoint must exist before analyze submit',
          );
          checkpointPath = resolve(directory, files[0]!);
          assert.equal(body.operationId, sourceOperationId);
          const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
          assert.deepEqual(
            {
              schemaVersion: checkpoint.schemaVersion,
              accountId: checkpoint.accountId,
              apiOrigin: checkpoint.apiOrigin,
              capability: checkpoint.capability,
              operationId: checkpoint.operationId,
            },
            {
              schemaVersion: 1,
              accountId: 'account_1',
              apiOrigin: 'https://postplus.test',
              capability: 'video-analysis',
              operationId: sourceOperationId,
            },
          );
          assert.equal(checkpoint.videoTransfer.phase, 'uploaded');
          assert.equal(typeof checkpoint.videoTransfer.expiresAt, 'number');
          assert.equal(checkpoint.analysisSubmissionAttempted, true);
          assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
          return Response.json({
            output: {
              data: {
                id: 'local-video-run',
                status: 'accepted',
                stage: 'resolving_source',
                elapsedMs: 0,
              },
            },
          });
        }
        assert.equal(body.operation, 'status');
        assert.equal(body.handle, 'local-video-run');
        assert.deepEqual(Object.keys(body).sort(), [
          'capability',
          'handle',
          'operation',
          'operationId',
        ]);
        const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
        assert.equal(checkpoint.operationId, sourceOperationId);
        assert.equal(checkpoint.handle, 'local-video-run');
        if (disconnect && !resumed)
          throw new TypeError('fetch failed: local poll disconnected');
        completedPolls++;
        return Response.json({
          output: {
            data: {
              id: 'local-video-run',
              status: completedPolls < 3 ? 'running' : 'completed',
              stage: completedPolls < 3 ? 'analyzing' : 'completed',
              elapsedMs: completedPolls * 10,
              markdown: completedPolls < 3 ? null : markdown,
            },
          },
        });
      };
      try {
        const command = [
          'analyze',
          'video-analysis',
          '--video',
          localVideo,
          '--prompt',
          'private local prompt',
          '--poll-interval-seconds',
          '0.001',
        ];
        if (disconnect) {
          await assert.rejects(
            runHostedDomainCommand('media', command),
            /local poll disconnected/u,
          );
          assert.equal(stdout, '');
          // A new invocation only needs the saved identity: even removing the
          // caller-local source cannot force a second upload or analyze submit.
          await rm(localVideo);
          resumed = true;
          assert.equal(
            await runHostedDomainCommand('media', [
              'poll',
              '--resume-from',
              checkpointPath,
              '--poll-interval-seconds',
              '0.001',
            ]),
            0,
          );
        } else {
          assert.equal(await runHostedDomainCommand('media', command), 0);
        }
        assert.equal(uploadCount, 1);
        assert.equal(
          bodies.filter((body) => body.operation === 'prepare-upload').length,
          1,
        );
        assert.equal(
          bodies.filter((body) => body.operation === 'analyze').length,
          1,
        );
        assert.equal(
          bodies.filter((body) => body.operation === 'status').length,
          disconnect ? 7 : 3,
        );
        assert.equal(stdout, markdown);
        assert.equal(stderr.match(/stage=analyzing/gu)?.length, 1);
        assert.equal(stderr.match(/stage=completed/gu)?.length, 1);
        assert.doesNotMatch(
          stderr,
          /private-local-session-token|private-upload-token|private local prompt/u,
        );
      } finally {
        globalThis.fetch = originalFetch;
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
    });
  }

  for (const mode of ['text', 'json', 'file', 'lost-ack'] as const) {
    it(`real CLI local video uses prepare-upload → Google bytes → one analyze → Markdown (${mode})`, async () => {
      const fixture = await tinyVideoFixture();
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'private-cli-session',
        userId: 'user_1',
        sessionExpiresAt: null,
      });
      const tracePath = resolve(
        process.env.POSTPLUS_CONFIG_DIR!,
        'transfer-trace.jsonl',
      );
      const reportPath = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'report.md');
      const markdown =
        '# Requested video report\r\n\r\nA blue frame and a silent audio track.\n\n';
      const stub = `import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const tracePath=${JSON.stringify(tracePath)}, expectedBytes=Buffer.from(${JSON.stringify(fixture.bytes.toString('base64'))},'base64');
const log=event=>appendFileSync(tracePath,JSON.stringify(event)+'\\n');
const history=()=>existsSync(tracePath)?readFileSync(tracePath,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const google='https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=scoped-cli';
globalThis.fetch=async(url,init)=>{
 const headers=new Headers(init?.headers);assert.equal(headers.has('x-goog-api-key'),false);assert.equal(headers.has('x-google-api-key'),false);
 if(String(url)===google){
  assert.equal(headers.has('authorization'),false);assert.equal(init.method,'POST');assert.equal(headers.get('x-goog-upload-command'),'upload, finalize');
  const parts=[];for await(const part of init.body)parts.push(Buffer.from(part));assert.deepEqual(Buffer.concat(parts),expectedBytes);
  log({stage:'upload',bytes:expectedBytes.length});return Response.json({file:{name:'files/cli-test'}});
 }
 assert.equal(String(url),'https://postplus.test/api/postplus-cli/hosted/capability');
 const body=JSON.parse(String(init.body));assert.equal(body.capability,'video-analysis');
 assert.ok(!JSON.stringify(body).includes('provider-key-must-not-leak'));
 if(body.operation==='prepare-upload'){
  assert.equal(body.input.metadata.bytes,expectedBytes.length);assert.equal(body.input.metadata.hasVideo,true);assert.equal(body.input.metadata.hasAudio,true);
  log({stage:'prepare',operationId:body.operationId});return Response.json({output:{uploadUrl:google,uploadToken:'sealed-cli-token',expiresAt:Date.now()+60000}});
 }
 const prepared=history().find(event=>event.stage==='prepare');
 if(body.operation==='analyze'){
  assert.equal(body.operationId,prepared.operationId);assert.equal(body.input.video,'postplus-video://sealed-cli-token/files/cli-test');
  assert.equal(Object.hasOwn(body.input,'prompt'),false);assert.ok(body.estimatedUsage.videoSeconds>0);
  log({stage:'analyze',operationId:body.operationId});
  if(${JSON.stringify(mode)}==='lost-ack')throw new TypeError('fetch failed: analysis ACK lost');
  return Response.json({output:{data:{id:'cli-video-run',status:'accepted',stage:'processing_video',elapsedMs:1}}});
 }
 assert.equal(body.operation,'status');
 assert.ok(body.handle==='cli-video-run'||body.sourceOperationId===prepared.operationId);
 log({stage:'status',operationId:body.operationId,sourceOperationId:body.sourceOperationId});
 return Response.json({output:{data:{id:'cli-video-run',status:'completed',stage:'completed',elapsedMs:5,markdown:${JSON.stringify(markdown)}}}});
};`;
      const invocation = [
        '--import',
        'tsx',
        '--import',
        `data:text/javascript,${encodeURIComponent(stub)}`,
        'src/index.ts',
      ];
      const env = {
        ...process.env,
        GEMINI_API_KEY: 'provider-key-must-not-leak',
      };
      const command = [
        'media',
        'analyze',
        'video-analysis',
        '--video',
        fixture.filePath,
        '--poll-interval-seconds',
        '0.001',
      ];
      if (mode === 'json') command.push('--json');
      if (mode === 'file' || mode === 'lost-ack')
        command.push('--output', reportPath);
      let result: { stdout: string; stderr: string };
      if (mode === 'lost-ack') {
        await writeFile(reportPath, 'previous report');
        await assert.rejects(
          execFileAsync(process.execPath, [...invocation, ...command], { env }),
          (error) => {
            const failure = error as {
              code: number;
              stdout: string;
              stderr: string;
            };
            assert.equal(failure.code, 1);
            assert.match(failure.stderr, /ACK lost/u);
            return true;
          },
        );
        assert.equal(await readFile(reportPath, 'utf8'), 'previous report');
        const records = await readdir(
          resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs'),
        );
        assert.equal(records.length, 1);
        const pointer = resolve(
          process.env.POSTPLUS_CONFIG_DIR!,
          'media-runs',
          records[0]!,
        );
        const checkpoint = JSON.parse(await readFile(pointer, 'utf8'));
        assert.equal(checkpoint.analysisSubmissionAttempted, true);
        assert.equal(checkpoint.videoTransfer.phase, 'uploaded');
        assert.equal(typeof checkpoint.videoTransfer.expiresAt, 'number');
        assert.equal((await stat(pointer)).mode & 0o777, 0o600);
        // The resumed process only queries the original operation. No second upload or analysis.
        await rm(fixture.filePath);
        result = await execFileAsync(
          process.execPath,
          [
            ...invocation,
            'media',
            'poll',
            '--resume-from',
            pointer,
            '--output',
            reportPath,
            '--wait-seconds',
            '0',
          ],
          { env },
        );
      } else
        result = await execFileAsync(
          process.execPath,
          [...invocation, ...command],
          { env },
        );
      const events = (await readFile(tracePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        events.filter((event) => event.stage === 'prepare').length,
        1,
      );
      assert.equal(
        events.filter((event) => event.stage === 'upload').length,
        1,
      );
      assert.equal(
        events.filter((event) => event.stage === 'analyze').length,
        1,
      );
      assert.equal(
        events.filter((event) => event.stage === 'status').length,
        1,
      );
      if (mode === 'file' || mode === 'lost-ack') {
        assert.equal(result.stdout, '');
        assert.equal(await readFile(reportPath, 'utf8'), markdown);
      } else if (mode === 'json')
        assert.equal(JSON.parse(result.stdout), markdown);
      else assert.equal(result.stdout, markdown);
      assert.match(result.stderr, /stage=completed/u);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /provider-key-must-not-leak|sealed-cli-token|scoped-cli|private-cli-session/u,
      );
    });
  }

  it('real numeric upload expiry from the hosted contract blocks Google bytes before analysis', async () => {
    const fixture = await tinyVideoFixture();
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'private-cli-session',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const originalFetch = globalThis.fetch;
    let prepares = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(
        String(url),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.operation, 'prepare-upload');
      prepares++;
      return Response.json({
        output: {
          uploadUrl:
            'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=expired',
          uploadToken: 'sealed-expired-token',
          expiresAt: Date.now() - 1,
        },
      });
    };
    try {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          fixture.filePath,
        ]),
        /media_video_upload_session_expired/u,
      );
      assert.equal(prepares, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits by default on the same video run id without resubmitting and returns canonical Markdown directly', async () => {
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const bodies: Record<string, unknown>[] = [];
    let stderrText = '';
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const data =
        body.operation === 'analyze'
          ? {
              elapsedMs: 5,
              id: 'video-run-1',
              markdown: null,
              progress: { elapsedMs: 5, stage: 'resolving_source' },
              stage: 'resolving_source',
              status: 'accepted',
            }
          : {
              elapsedMs: 70,
              id: 'video-run-1',
              markdown: '# Analysis\n\n00:00 Hook evidence.',
              progress: { elapsedMs: 70, stage: 'completed' },
              stage: 'completed',
              status: 'completed',
            };
      return new Response(JSON.stringify({ output: { data } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    };
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const payload = (await runHostedDomainCommand(
        'media',
        [
          'analyze',
          'video-analysis',
          '--video',
          'https://cdn.example.com/video.mp4',
          '--prompt',
          'Analyze the video.',
          '--wait-seconds',
          '0',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      )) as string;

      assert.equal(bodies.length, 2);
      assert.equal(bodies[0]?.operation, 'analyze');
      assert.equal(bodies[1]?.operation, 'status');
      assert.equal(bodies[1]?.handle, 'video-run-1');
      assert.equal('input' in bodies[1]!, false);
      assert.equal('estimatedUsage' in bodies[1]!, false);
      assert.equal('quoteConfirmationToken' in bodies[1]!, false);
      assert.equal(payload, '# Analysis\n\n00:00 Hook evidence.');
      assert.match(stderrText, /stage=resolving_source elapsed=5ms/u);
      assert.match(stderrText, /stage=completed elapsed=70ms/u);
      assert.equal(stderrText.match(/stage=resolving_source/gu)?.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  it('labels estimated video billing separately without changing the complete Markdown', async () => {
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrText = '';
    let calls = 0;
    const markdown = '# Analysis\n\n00:00–00:12 Complete saved report.\n';
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        billing: {
          charged: true,
          estimatedOnly: true,
          finalizedCredits: 1.136,
        },
        output: {
          data: {
            id: 'estimated-run',
            status: 'completed',
            stage: 'completed',
            markdown,
          },
        },
      });
    };
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await runHostedDomainCommand(
        'media',
        [
          'analyze',
          'video-analysis',
          '--video',
          'https://cdn.example.com/video.mp4',
          '--prompt',
          'Analyze the video.',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      );
      assert.equal(result, markdown);
      assert.equal(calls, 1);
      assert.equal(stderrText.match(/estimated settlement/gu)?.length, 1);
      assert.match(stderrText, /1\.136 PostPlus credits/u);
      assert.match(stderrText, /actual usage unconfirmed/u);
      assert.doesNotMatch(stderrText, /result unconfirmed/u);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  for (const mode of [
    'stdout',
    'file',
    'json',
    'estimated',
    'unknown-billing',
  ] as const) {
    it(`delivers a narrow completed report unchanged without imposing the retired quality gate (${mode})`, async () => {
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'cli-session-token',
        userId: 'user_1',
        sessionExpiresAt: null,
      });
      const fixture = mode === 'stdout' ? await tinyVideoFixture() : null;
      const output = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'original.md');
      const markdown =
        '# Requested opening only\r\n\r\nA hand lifts the cup.\n\n\n';
      const originalFetch = globalThis.fetch,
        originalOut = process.stdout.write,
        originalErr = process.stderr.write;
      let stdout = '',
        stderr = '',
        analyzeCalls = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.operation === 'analyze') {
          analyzeCalls++;
          return Response.json({
            output: {
              data: {
                id: 'narrow-run',
                status: 'accepted',
                stage: 'analyzing',
              },
            },
          });
        }
        assert.equal(body.operation, 'status');
        assert.equal(body.handle, 'narrow-run');
        return Response.json({
          billing:
            mode === 'unknown-billing'
              ? null
              : {
                  finalizedCredits: 0.35,
                  estimatedOnly: mode === 'estimated',
                  rawProviderSecret: 'never-project-this',
                },
          output: {
            data: {
              id: 'narrow-run',
              status: 'completed',
              stage: 'completed',
              markdown,
            },
          },
        });
      };
      if (fixture)
        globalThis.fetch = withGoogleVideoUpload(globalThis.fetch, fixture);
      process.stdout.write = ((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        const args = fixture
          ? [
              'analyze',
              'video-analysis',
              '--video',
              fixture.filePath,
              '--prompt',
              'Describe only the opening.',
              '--wait-seconds',
              '0',
            ]
          : [
              'poll',
              '--handle',
              'narrow-run',
              '--capability',
              'video-analysis',
            ];
        if (mode === 'file') args.push('--output', output);
        if (mode === 'json') args.push('--json');
        assert.equal(await runHostedDomainCommand('media', args), 0);
        assert.equal(analyzeCalls, fixture ? 1 : 0);
        if (mode === 'file') {
          assert.equal(await readFile(output, 'utf8'), markdown);
          assert.equal(stdout, '');
        } else if (mode === 'json') assert.equal(JSON.parse(stdout), markdown);
        else assert.equal(stdout, markdown);
        if (mode === 'estimated') {
          assert.match(stderr, /0\.35 PostPlus credits/u);
          assert.match(stderr, /actual usage unconfirmed/u);
        }
        if (mode === 'unknown-billing')
          assert.doesNotMatch(stderr, /no charge|zero charge|0 credits/u);
        assert.doesNotMatch(
          stdout + stderr,
          /quality_failed|time-coverage|never-project-this|rawProviderSecret/u,
        );
      } finally {
        globalThis.fetch = originalFetch;
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
    });
  }

  for (const fault of ['network', 'body', '429', '503'] as const) {
    it(`recovers a ${fault} status fault without resubmitting video analysis`, async () => {
      const originalFetch = globalThis.fetch;
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.operation === 'analyze')
          return Response.json({
            output: { data: { id: 'same-run', status: 'accepted' } },
          });
        assert.equal(body.operation, 'status');
        assert.equal(body.handle, 'same-run');
        assert.equal(body.input, undefined);
        if (bodies.length === 2) {
          if (fault === 'network') throw new TypeError('fetch failed');
          if (fault === 'body')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('socket reset'));
                },
              }),
            );
          return Response.json(
            {
              code: 'temporary_status_fault',
              message: 'Temporary status failure',
            },
            { status: Number(fault) },
          );
        }
        return Response.json({
          output: {
            data: {
              id: 'same-run',
              status: 'completed',
              markdown: '# Complete report',
            },
          },
        });
      };
      try {
        const result = await runHostedDomainCommand(
          'media',
          [
            'analyze',
            'video-analysis',
            '--video',
            'https://video.example/clip.mp4',
            '--prompt',
            'Analyze.',
            '--poll-interval-seconds',
            '0.001',
          ],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'token',
            },
          },
        );
        assert.equal(result, '# Complete report');
        assert.equal(
          bodies.filter((body) => body.operation === 'analyze').length,
          1,
        );
        assert.equal(
          bodies.filter((body) => body.operation === 'status').length,
          2,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('caps status recovery and preserves the original run identity on exhausted network errors', async () => {
    const originalFetch = globalThis.fetch;
    let submits = 0;
    let polls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'analyze') {
        submits++;
        return Response.json({
          output: { data: { id: 'original-run', status: 'accepted' } },
        });
      }
      polls++;
      assert.equal(body.handle, 'original-run');
      throw new TypeError('fetch failed');
    };
    try {
      await assert.rejects(
        runHostedDomainCommand(
          'media',
          [
            'analyze',
            'video-analysis',
            '--video',
            'https://video.example/clip.mp4',
            '--prompt',
            'Analyze.',
            '--hosted-operation-id',
            'original-operation',
            '--poll-interval-seconds',
            '0.001',
          ],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'token',
            },
          },
        ),
        (error: unknown) => {
          assert.equal((error as { handle?: string }).handle, 'original-run');
          assert.equal(
            (error as { operationId?: string }).operationId,
            'original-operation',
          );
          return true;
        },
      );
      assert.equal(submits, 1);
      assert.equal(polls, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry permanent HTTP, TLS, redirect, or malformed successful status responses', async () => {
    const originalFetch = globalThis.fetch;
    for (const fault of [
      '400',
      '401',
      '403',
      '404',
      '426',
      '501',
      'tls',
      'redirect',
      'json',
      'business-refusal',
      'invalid-header',
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (fault === 'tls')
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('certificate expired'), {
              code: 'CERT_HAS_EXPIRED',
            }),
          });
        if (fault === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://private.example/?token=secret' },
          });
        if (fault === 'json') return new Response('{invalid');
        return Response.json(
          {
            code: 'not_retryable',
            message: 'Cannot query this task.',
            ...(fault === 'business-refusal' ? { retryable: false } : {}),
          },
          { status: fault === 'business-refusal' ? 503 : Number(fault) },
        );
      };
      try {
        await assert.rejects(
          runHostedDomainCommand(
            'media',
            [
              'poll',
              '--handle',
              'same-run',
              '--capability',
              'video-analysis',
              '--poll-interval-seconds',
              '0.001',
            ],
            {
              auth: {
                apiBaseUrl: 'https://postplus.test',
                cliSessionToken:
                  fault === 'invalid-header' ? 'invalid\nheader' : 'token',
              },
            },
          ),
        );
        assert.equal(calls, fault === 'invalid-header' ? 0 : 1, fault);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it('recovers a non-JSON gateway failure but does not retry a single-shot poll', async () => {
    const originalFetch = globalThis.fetch;
    for (const singleShot of [false, true]) {
      let calls = 0;
      globalThis.fetch = async () =>
        ++calls === 1
          ? new Response('<html>gateway error</html>', { status: 502 })
          : Response.json({
              output: {
                data: {
                  id: 'same-run',
                  status: 'completed',
                  markdown: '# Report',
                },
              },
            });
      try {
        const result = runHostedDomainCommand(
          'media',
          [
            'poll',
            '--handle',
            'same-run',
            '--capability',
            'video-analysis',
            '--poll-interval-seconds',
            '0.001',
            '--wait-seconds',
            singleShot ? '0' : '1',
          ],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'token',
            },
          },
        );
        if (singleShot) {
          await assert.rejects(result);
          assert.equal(calls, 1);
        } else {
          assert.equal(await result, '# Report');
          assert.equal(calls, 2);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it('does not ignore Retry-After or poll again when the wait budget cannot admit it', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        { message: 'Rate limited' },
        { status: 429, headers: { 'retry-after': '120' } },
      );
    };
    try {
      await assert.rejects(
        runHostedDomainCommand(
          'media',
          [
            'poll',
            '--handle',
            'same-run',
            '--capability',
            'video-analysis',
            '--wait-seconds',
            '0.1',
          ],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'token',
            },
          },
        ),
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shares the media polling deadline with a slow 401 session refresh and does not requery', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const originalFetch = globalThis.fetch;
    let polls = 0;
    let refreshes = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshes++;
        assert.ok(init?.signal);
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
        });
      }
      polls++;
      return Response.json({ message: 'Session expired' }, { status: 401 });
    };
    const keepAlive = setTimeout(() => undefined, 2000);
    try {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'poll',
          '--handle',
          'same-run',
          '--capability',
          'video-analysis',
          '--wait-seconds',
          '0.1',
        ]),
        /Timeout|timeout|aborted/iu,
      );
      assert.equal(refreshes, 1);
      assert.equal(polls, 1);
    } finally {
      clearTimeout(keepAlive);
      globalThis.fetch = originalFetch;
    }
  });

  for (const capability of ['video-analysis', 'media-generation'] as const) {
    it(`${capability}: persists identity before lost submit ACK and recovers without a second submission`, async () => {
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'private-session-token',
        userId: 'user_1',
        sessionExpiresAt: null,
      });
      const localFixture = await tinyVideoFixture();
      const originalFetch = globalThis.fetch;
      const originalOut = process.stdout.write;
      const originalErr = process.stderr.write;
      const bodies: Record<string, unknown>[] = [];
      let checkpointPath = '';
      let originalOperation = '';
      process.stdout.write = (() => true) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.operation !== 'status') {
          const directory = resolve(
            process.env.POSTPLUS_CONFIG_DIR!,
            'media-runs',
          );
          const files = await readdir(directory);
          assert.equal(files.length, 1, 'checkpoint must exist before submit');
          checkpointPath = resolve(directory, files[0]!);
          const text = await readFile(checkpointPath, 'utf8');
          const saved = JSON.parse(text);
          originalOperation = String(body.operationId);
          assert.equal(saved.operationId, originalOperation);
          assert.equal(saved.capability, capability);
          assert.equal(saved.accountId, 'account_1');
          if (capability === 'video-analysis') {
            assert.equal(saved.analysisSubmissionAttempted, true);
            assert.equal(saved.videoRequest.source, localFixture.filePath);
            assert.equal(saved.videoTransfer.phase, 'uploaded');
            assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
          } else
            assert.deepEqual(Object.keys(saved).sort(), [
              'accountId',
              'apiOrigin',
              'capability',
              'operationId',
              'schemaVersion',
            ]);
          assert.doesNotMatch(text, /private-session-token|GEMINI_API_KEY/u);
          throw new TypeError('fetch failed: submit ACK lost');
        }
        assert.equal(body.sourceOperationId, originalOperation);
        assert.deepEqual(Object.keys(body).sort(), [
          'capability',
          'operation',
          'operationId',
          'sourceOperationId',
        ]);
        return Response.json({
          output: {
            data: {
              id: 'recovered-run',
              status: 'completed',
              markdown: '# Complete report',
            },
          },
        });
      };
      if (capability === 'video-analysis')
        globalThis.fetch = withGoogleVideoUpload(
          globalThis.fetch,
          localFixture,
        );
      try {
        const command =
          capability === 'video-analysis'
            ? [
                'analyze',
                'video-analysis',
                '--video',
                localFixture.filePath,
                '--prompt',
                'secret prompt',
              ]
            : [
                'create',
                'image-gpt-image-2-text',
                '--prompt',
                'secret prompt',
                '--wait',
              ];
        await assert.rejects(
          runHostedDomainCommand('media', command),
          /fetch failed/u,
        );
        assert.ok(checkpointPath);
        assert.equal(
          await runHostedDomainCommand('media', [
            'poll',
            '--resume-from',
            checkpointPath,
            '--wait-seconds',
            '0',
          ]),
          0,
        );
        assert.equal(
          bodies.filter((body) => body.operation !== 'status').length,
          1,
        );
        assert.equal(
          bodies.filter((body) => body.operation === 'status').length,
          1,
        );
      } finally {
        globalThis.fetch = originalFetch;
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
    });
  }

  it('refuses a media submit if its automatic recovery checkpoint cannot be written', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    await writeFile(
      resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs'),
      'not a directory',
    );
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error('must not submit');
    };
    try {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'create',
          'image-gpt-image-2-text',
          '--prompt',
          'test',
        ]),
        /EEXIST|ENOTDIR/u,
      );
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects cross-account, cross-environment and malformed recovery pointers without any request', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const pointer = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'pointer.json');
    const base = {
      schemaVersion: 1,
      accountId: 'account_1',
      apiOrigin: 'https://postplus.test',
      capability: 'video-analysis',
      operationId: 'original-operation',
    };
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error('must not request');
    };
    try {
      for (const change of [
        { accountId: 'account_2' },
        { apiOrigin: 'https://another.test' },
        { prompt: 'unexpected input' },
        { handle: 12 },
      ]) {
        await writeFile(pointer, JSON.stringify({ ...base, ...change }));
        await assert.rejects(
          runHostedDomainCommand('media', ['poll', '--resume-from', pointer]),
          /another account|Invalid media/u,
        );
      }
      await assert.rejects(
        runHostedDomainCommand('media', [
          'poll',
          '--resume-from',
          pointer,
          '--handle',
          'other-run',
        ]),
        /cannot be combined/u,
      );
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats failed HTTP 200 media results as failures and preserves typed recovery advice', async () => {
    const originalFetch = globalThis.fetch;
    const error = {
      code: 'media_resource_unsupported',
      stage: 'validating_media',
      retryable: false,
      userAction: 'Provide a supported video, not a slideshow.',
    };
    globalThis.fetch = async () =>
      Response.json({
        output: { data: { id: 'run_1', status: 'failed', stage: 'validating_media', error } },
      });
    try {
      await assert.rejects(
        runHostedDomainCommand('media', ['poll', '--handle', 'run_1'], {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'token',
          },
        }),
        (cause: unknown) => {
          assert.ok(cause instanceof Error);
          for (const [key, value] of Object.entries(error))
            assert.equal(
              (cause as unknown as { productError: Record<string, unknown> })
                .productError[key],
              value,
            );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('exits the actual CLI process nonzero for failed HTTP 200 tasks', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const response = {
      operationId: 'original-operation',
      output: {
        data: {
          id: 'run_1',
          status: 'failed',
          stage: 'validating_media',
          error: {
            code: 'video_resource_unsupported',
            stage: 'validating_media',
            retryable: false,
            userAction: 'Provide a video rather than a slideshow.',
          },
        },
      },
    };
    const stub = `globalThis.fetch = async () => Response.json(${JSON.stringify(response)});`;
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        '--import',
        `data:text/javascript,${encodeURIComponent(stub)}`,
        'src/index.ts',
        'media',
        'poll',
        '--handle',
        'run_1',
        '--capability',
        'video-analysis',
      ]),
      (error: unknown) => {
        const result = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(
          result.stderr,
          /code=video_resource_unsupported .*stage=validating_media retryable=false/u,
        );
        assert.match(result.stderr, /Provide a video rather than a slideshow/u);
        assert.doesNotMatch(
          result.stderr,
          /Resume the same run|do not resubmit/u,
        );
        assert.match(
          result.stderr,
          /Task record: postplus media poll --handle 'run_1'/u,
        );
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        '--import',
        `data:text/javascript,${encodeURIComponent(stub)}`,
        'src/index.ts',
        'media',
        'poll',
        '--handle',
        'run_1',
        '--capability',
        'video-analysis',
        '--json',
      ]),
      (error: unknown) => {
        const result = error as { code: number; stdout: string };
        assert.equal(result.code, 1);
        const failure = JSON.parse(result.stdout).error;
        assert.equal(failure.operationId, 'original-operation');
        assert.equal(failure.runId, 'run_1');
        for (const [key, value] of Object.entries(response.output.data.error))
          assert.equal(failure[key], value);
        return true;
      },
    );
  });

  it('reports an expired-before-inference run in real text and JSON CLI processes without resubmitting or replacing its checkpoint', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'private-expired-session-token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-expired-video-'),
    );
    tempDirs.push(requestDir);
    const checkpointPath = resolve(requestDir, 'recovery.json');
    const callsPath = resolve(requestDir, 'requests.jsonl');
    const operationId = 'original-expired-operation';
    const runId = 'expired-video-run';
    const checkpointText = JSON.stringify({
      schemaVersion: 1,
      accountId: 'account_1',
      apiOrigin: 'https://postplus.test',
      capability: 'video-analysis',
      operationId,
      handle: runId,
    });
    await writeFile(checkpointPath, checkpointText);
    const deadlineMs = 300_000;
    const elapsedMs = deadlineMs + 321;
    const terminalError = {
      code: 'video_analysis_expired_before_inference',
      stage: 'downloading_source',
      retryable: true,
      userAction:
        'Run the command again to start a new task; this one expired before analysis and was not charged.',
    };
    const response = {
      operationId,
      charged: false,
      output: {
        data: {
          id: runId,
          status: 'expired',
          billingState: 'not_reserved',
          charged: false,
          stage: terminalError.stage,
          elapsedMs,
          markdown: null,
          error: terminalError,
        },
      },
    };
    // Exercise the production CLI entry point, replacing only fetch. Every
    // attempted request is recorded before validation so a surprise submit,
    // upload, or billing request cannot be mistaken for a passing failure.
    const stub = `
      import assert from 'node:assert/strict';
      import { appendFile } from 'node:fs/promises';
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body));
        await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({
          url: String(url), method: init?.method, body,
        }) + '\\n');
        assert.equal(String(url), 'https://postplus.test/api/postplus-cli/hosted/capability');
        assert.equal(init?.method, 'POST');
        assert.match(body.operationId, /^postplus-cli:media:video-analysis:status:/u);
        const { operationId: statusRequestId, ...locator } = body;
        assert.deepEqual(locator, {
          capability: 'video-analysis', operation: 'status',
          handle: ${JSON.stringify(runId)},
        });
        return Response.json(${JSON.stringify(response)});
      };
    `;

    for (const json of [false, true]) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          '--import',
          'tsx',
          '--import',
          `data:text/javascript,${encodeURIComponent(stub)}`,
          'src/index.ts',
          'media',
          'poll',
          '--resume-from',
          checkpointPath,
          ...(json ? ['--json'] : []),
        ]),
        (error: unknown) => {
          const result = error as {
            code: number;
            stdout: string;
            stderr: string;
          };
          assert.equal(result.code, 1);
          assert.match(
            result.stderr,
            /stage=downloading_source elapsed=300321ms/u,
          );
          assert.doesNotMatch(
            result.stdout + result.stderr,
            /private-expired-session-token|stage=completed|^# /mu,
          );
          assert.doesNotMatch(result.stderr, /Resume|do not resubmit/u);
          assert.match(
            result.stderr,
            /Task record: postplus media poll --resume-from/u,
          );
          if (json) {
            const output = JSON.parse(result.stdout);
            assert.equal(Object.hasOwn(output, 'output'), false);
            assert.equal(output.error.operationId, operationId);
            assert.equal(output.error.runId, runId);
            assert.equal(
              output.error.message,
              'The media task ended with status expired.',
            );
            for (const [key, value] of Object.entries(terminalError)) {
              assert.equal(output.error[key], value);
            }
          } else {
            assert.equal(result.stdout, '');
            assert.match(result.stderr, /status expired/u);
            assert.match(
              result.stderr,
              /code=video_analysis_expired_before_inference .*stage=downloading_source retryable=true/u,
            );
            assert.ok(result.stderr.includes(terminalError.userAction));
          }
          return true;
        },
      );
      assert.equal(await readFile(checkpointPath, 'utf8'), checkpointText);
    }
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2, 'exactly one status read per invocation');
    for (const call of calls) {
      assert.match(
        call.body.operationId,
        /^postplus-cli:media:video-analysis:status:/u,
      );
      const { operationId: _statusRequestId, ...locator } = call.body;
      assert.deepEqual(locator, {
        capability: 'video-analysis',
        operation: 'status',
        handle: runId,
      });
    }
    // This transport test proves no CLI resubmit/upload/billing request. The
    // backend's no-reserve/no-charge guarantee is covered by its own ledger tests.
    assert.equal(
      calls.filter((call) => call.body.operation !== 'status').length,
      0,
    );
  });

  for (const immediate of [false, true]) {
    it(`keeps output and follows only terminal advice when video analysis expires ${immediate ? 'on submit' : 'after acceptance'}`, async () => {
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'token',
        userId: 'user_1',
        sessionExpiresAt: null,
      });
      const requestDir = await mkdtemp(
        resolve(tmpdir(), 'postplus-expired-submit-'),
      );
      tempDirs.push(requestDir);
      const outputPath = resolve(requestDir, 'report.md');
      const existingOutput =
        'Existing report must not be replaced by an error.';
      await writeFile(outputPath, existingOutput);
      const localFixture = await tinyVideoFixture();
      const originalFetch = globalThis.fetch;
      const originalOut = process.stdout.write;
      const originalErr = process.stderr.write;
      let stdout = '';
      let stderr = '';
      let pendingOutput = existingOutput;
      const bodies: Record<string, unknown>[] = [];
      process.stdout.write = ((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      const userAction =
        'Start a new task; this task expired before analysis and was not charged.';
      globalThis.fetch = async (url, init) => {
        assert.equal(
          String(url),
          'https://postplus.test/api/postplus-cli/hosted/capability',
        );
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.operation === 'analyze' && !immediate) {
          return Response.json({
            output: {
              data: {
                id: 'expired-submit-run',
                status: 'accepted',
                stage: 'resolving_source',
                elapsedMs: 0,
              },
            },
          });
        }
        assert.equal(body.operation, immediate ? 'analyze' : 'status');
        if (!immediate) {
          assert.equal(body.handle, 'expired-submit-run');
          pendingOutput = await readFile(outputPath, 'utf8');
        }
        // Earlier pending output may correctly teach recovery. Only feedback
        // after observing the terminal response must defer to its userAction.
        stderr = '';
        return Response.json({
          output: {
            data: {
              id: 'expired-submit-run',
              status: 'expired',
              stage: 'downloading_source',
              elapsedMs: 300321,
              billingState: 'not_reserved',
              charged: false,
              markdown: null,
              error: {
                code: 'video_analysis_expired_before_inference',
                stage: 'downloading_source',
                retryable: true,
                userAction,
              },
            },
          },
        });
      };
      globalThis.fetch = withGoogleVideoUpload(globalThis.fetch, localFixture);
      try {
        assert.equal(
          await runHostedDomainCommand('media', [
            'analyze',
            'video-analysis',
            '--video',
            localFixture.filePath,
            '--prompt',
            'Analyze this video.',
            '--output',
            outputPath,
          ]),
          1,
        );
        assert.equal(stdout, '');
        assert.ok(stderr.includes(userAction));
        assert.doesNotMatch(stderr, /Resume|do not resubmit/u);
        assert.match(stderr, /Task record: postplus media poll/u);
        assert.match(stderr, /stage=downloading_source elapsed=300321ms/u);
        assert.equal(await readFile(outputPath, 'utf8'), pendingOutput);
        assert.equal(
          bodies.filter((body) => body.operation === 'analyze').length,
          1,
        );
        assert.equal(
          bodies.filter((body) => body.operation === 'status').length,
          immediate ? 0 : 1,
        );
        const checkpoints = await readdir(
          resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs'),
        );
        assert.equal(checkpoints.length, 1);
        const checkpoint = JSON.parse(
          await readFile(
            resolve(
              process.env.POSTPLUS_CONFIG_DIR!,
              'media-runs',
              checkpoints[0]!,
            ),
            'utf8',
          ),
        );
        assert.equal(checkpoint.operationId, bodies[0]?.operationId);
        assert.equal(checkpoint.handle, 'expired-submit-run');
      } finally {
        globalThis.fetch = originalFetch;
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
    });
  }

  it('uses neutral record advice for a terminal shared media-generation checkpoint without losing its output', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-terminal-generation-'),
    );
    tempDirs.push(requestDir);
    const checkpointPath = resolve(requestDir, 'recovery.json');
    const outputPath = resolve(requestDir, 'result.json');
    const checkpointText = JSON.stringify({
      schemaVersion: 1,
      accountId: 'account_1',
      apiOrigin: 'https://postplus.test',
      capability: 'media-generation',
      operationId: 'generation-operation',
      handle: 'generation-run',
    });
    await writeFile(checkpointPath, checkpointText);
    await writeFile(outputPath, 'previous result');
    const originalFetch = globalThis.fetch;
    const originalErr = process.stderr.write;
    let stderr = '';
    let requests = 0;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.operation, 'status');
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.handle, 'generation-run');
      return Response.json({
        output: {
          data: {
            id: 'generation-run',
            status: 'failed',
            error: {
              code: 'media_resource_unsupported',
              retryable: false,
              userAction: 'Provide a supported source.',
            },
          },
        },
      });
    };
    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'poll',
          '--resume-from',
          checkpointPath,
          '--output',
          outputPath,
        ]),
        1,
      );
      assert.equal(requests, 1);
      assert.match(stderr, /Task record: postplus media poll --resume-from/u);
      assert.match(stderr, /Provide a supported source/u);
      assert.doesNotMatch(stderr, /Resume|do not resubmit/u);
      assert.equal(await readFile(checkpointPath, 'utf8'), checkpointText);
      assert.equal(await readFile(outputPath, 'utf8'), 'previous result');
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalErr;
    }
  });

  it('resumes an acknowledged media generation task by handle after polling disconnects', async () => {
    await setLocalSession({
      accountId: 'account_1',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'token',
      userId: 'user_1',
      sessionExpiresAt: null,
    });
    const originalFetch = globalThis.fetch;
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const bodies: Record<string, unknown>[] = [];
    let disconnected = true;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.operation !== 'status')
        return Response.json({
          output: { data: { id: 'generation_1', status: 'accepted' } },
        });
      assert.equal(body.handle, 'generation_1');
      assert.equal(body.sourceOperationId, undefined);
      if (disconnected) throw new TypeError('poll disconnected');
      return Response.json({
        output: { data: { id: 'generation_1', status: 'completed' } },
      });
    };
    try {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'create',
          'image-gpt-image-2-text',
          '--prompt',
          'test',
          '--wait',
        ]),
        /poll disconnected/u,
      );
      const directory = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs');
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      const pointer = resolve(directory, files[0]!);
      assert.equal(
        JSON.parse(await readFile(pointer, 'utf8')).handle,
        'generation_1',
      );
      disconnected = false;
      assert.equal(
        await runHostedDomainCommand('media', [
          'poll',
          '--resume-from',
          pointer,
          '--wait-seconds',
          '0',
        ]),
        0,
      );
      assert.equal(
        bodies.filter((body) => body.operation !== 'status').length,
        1,
      );
      assert.equal(
        bodies.filter((body) => body.operation === 'status').length,
        5, // four bounded failed reads, then one successful same-handle resume
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  it('does not report a completed video task without Markdown as success', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        output: { data: { id: 'run_1', status: 'completed', markdown: null } },
      });
    try {
      await assert.rejects(
        runHostedDomainCommand(
          'media',
          ['poll', '--handle', 'run_1', '--capability', 'video-analysis'],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'token',
            },
          },
        ),
        /video_analysis_result_incomplete.*do not resubmit/su,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checkpoints video analysis before a network disconnect and resumes in a new invocation with only status reads', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-video-resume-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'analysis.md');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const localFixture = await tinyVideoFixture();
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write;
    const bodies: Record<string, unknown>[] = [];
    let stderrText = '';
    let resumed = false;
    let resumedPolls = 0;
    const markdown = '# Analysis\n\n00:00 Complete observable evidence.\n';
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.operation === 'analyze') {
        assert.equal(bodies.length, 1, 'never resubmit a disconnected run');
        return Response.json({
          output: {
            data: {
              id: 'video-resume-1',
              status: 'accepted',
              stage: 'resolving_source',
              elapsedMs: 0,
            },
          },
        });
      }
      assert.equal(body.handle, 'video-resume-1');
      assert.equal(body.capability, 'video-analysis');
      assert.deepEqual(Object.keys(body).sort(), [
        'capability',
        'handle',
        'operation',
        'operationId',
      ]);
      // This runs before the very first status request can fail.
      const checkpoint = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(checkpoint.id, 'video-resume-1');
      assert.equal(checkpoint.operationId, bodies[0]?.operationId);
      assert.match(
        stderrText,
        /Resume: postplus media poll --handle 'video-resume-1' --capability video-analysis/u,
      );
      if (!resumed) throw new TypeError('fetch failed: disconnected');
      resumedPolls += 1;
      return Response.json({
        output: {
          data: {
            id: 'video-resume-1',
            status: resumedPolls < 3 ? 'running' : 'completed',
            stage: resumedPolls < 3 ? 'analyzing' : 'completed',
            elapsedMs: resumedPolls * 10,
            markdown: resumedPolls < 3 ? null : markdown,
          },
        },
      });
    };
    globalThis.fetch = withGoogleVideoUpload(globalThis.fetch, localFixture);
    try {
      await assert.rejects(
        runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          localFixture.filePath,
          '--prompt',
          'private prompt',
          '--output',
          outputPath,
        ]),
        /disconnected/u,
      );
      const checkpointText = await readFile(outputPath, 'utf8');
      assert.doesNotMatch(
        checkpointText + stderrText,
        /private-source|private prompt|cli-session-token/u,
      );
      assert.match(
        stderrText,
        /operationId=postplus-cli:media:video-analysis:analyze:/u,
      );
      resumed = true;
      assert.equal(
        await runHostedDomainCommand('media', [
          'poll',
          '--handle',
          'video-resume-1',
          '--capability',
          'video-analysis',
          '--poll-interval-seconds',
          '0.001',
          '--output',
          outputPath,
        ]),
        0,
      );
      assert.equal(
        bodies.filter((body) => body.operation === 'analyze').length,
        1,
      );
      assert.equal(resumedPolls, 3);
      assert.equal(stderrText.match(/stage=analyzing/gu)?.length, 1);
      assert.equal(stderrText.match(/stage=completed/gu)?.length, 1);
      assert.equal(await readFile(outputPath, 'utf8'), markdown);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  it('prints video recovery before polling without an output file and preserves an existing checkpoint on a poll product error', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-video-poll-error-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'analysis.md');
    const checkpoint = JSON.stringify({
      id: 'video-poll-1',
      operationId: 'original-operation',
    });
    await writeFile(outputPath, checkpoint);
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const localFixture = await tinyVideoFixture();
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write;
    let stderrText = '';
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'analyze')
        return Response.json({
          output: {
            data: {
              id: 'video-poll-1',
              status: 'accepted',
              stage: 'resolving_source',
              elapsedMs: 0,
            },
          },
        });
      assert.match(
        stderrText,
        /Resume: postplus media poll --handle 'video-poll-1'/u,
      );
      return Response.json(
        {
          code: 'status_unavailable',
          error: 'Status temporarily unavailable.',
        },
        { status: 503 },
      );
    };
    globalThis.fetch = withGoogleVideoUpload(globalThis.fetch, localFixture);
    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          localFixture.filePath,
          '--prompt',
          'Analyze.',
        ]),
        1,
      );
      assert.equal(
        await runHostedDomainCommand('media', [
          'poll',
          '--handle',
          'video-poll-1',
          '--capability',
          'video-analysis',
          '--output',
          outputPath,
        ]),
        1,
      );
      assert.equal(await readFile(outputPath, 'utf8'), checkpoint);
      assert.match(
        stderrText,
        /Resume the same run: postplus media poll --handle 'video-poll-1'/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  it('attaches the accepted video run identity to hosted-lib network errors', async () => {
    const originalFetch = globalThis.fetch;
    let submitOperationId: unknown;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.operation === 'analyze') {
        submitOperationId = body.operationId;
        return Response.json({
          output: { data: { id: 'video-lib-1', status: 'accepted' } },
        });
      }
      throw new TypeError('fetch failed: disconnected');
    };
    try {
      await assert.rejects(
        runHostedDomainCommand(
          'media',
          [
            'analyze',
            'video-analysis',
            '--video',
            'https://example.com/video.mp4',
            '--prompt',
            'Analyze.',
          ],
          {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'cli-session-token',
            },
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { handle: string }).handle,
            'video-lib-1',
          );
          assert.equal(
            (error as Error & { operationId: string }).operationId,
            submitOperationId,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media analyze forwards --video-seconds as estimatedUsage.videoSeconds', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (_input, init) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand(
        'media',
        [
          'analyze',
          'video-analysis',
          '--video',
          'postplus-media://uploads/users/user_1/hosted-media/inputs/clip.mp4',
          '--prompt',
          'Analyze this short clip.',
          '--video-seconds',
          '30',
        ],
        {
          auth: {
            apiBaseUrl: 'https://postplus.test',
            cliSessionToken: 'cli-session-token',
          },
        },
      );
      assert.deepEqual(result, { ok: true });
      const body = postedBody as Record<string, unknown>;
      // Restores the video-analysis routing reachability the retired ffprobe runner
      // had: the caller-supplied duration reaches the Web routing/preflight boundary.
      assert.deepEqual(body.estimatedUsage, { videoSeconds: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media analyze fast-fails on a non-positive --video-seconds before any hosted call', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'analyze',
            'video-analysis',
            '--video',
            'postplus-media://uploads/users/user_1/hosted-media/inputs/clip.mp4',
            '--prompt',
            'Analyze this short clip.',
            '--video-seconds',
            '0',
          ]),
        /--video-seconds must be a positive number/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file upload pre-stages once and returns only durable PostPlus identities', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-upload-'));
    tempDirs.push(uploadDir);
    const videoPath = resolve(uploadDir, 'clip.mp4');
    const outputPath = resolve(uploadDir, 'result.json');
    const fileBytes = Buffer.from('fake-mp4-bytes-0123456789');
    await writeFile(videoPath, fileBytes);

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const storageReference = {
      bucket: 'uploads',
      mimeType: 'video/mp4',
      name: 'clip.mp4',
      sizeBytes: fileBytes.length,
      storagePath: 'users/user-1/hosted-media/inputs/clip.mp4',
    };
    const mediaReference =
      'postplus-media://uploads/user_1/hosted-media/inputs/upload-test-op/0f8a1c2d-clip.mp4';
    const originalFetch = globalThis.fetch;
    const hostedBodies: unknown[] = [];
    let putBytes: Buffer | null = null;
    let putContentType: string | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://postplus.test/api/postplus-cli/hosted/capability') {
        const requestBody = JSON.parse(String(init?.body));
        hostedBodies.push(requestBody);
        return new Response(
          JSON.stringify({
            output: {
              mediaReference,
              signedUpload: {
                expiresInSeconds: 600,
                method: 'PUT',
                requiredHeaders: { 'content-type': 'video/mp4' },
                token: 'signed-token',
                url: 'https://upload.test/signed-target',
              },
              storageReference,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://upload.test/signed-target') {
        assert.equal(init?.method, 'PUT');
        const bodyStream = init?.body as ReadStream;
        const chunks: Buffer[] = [];
        for await (const chunk of bodyStream) {
          chunks.push(Buffer.from(chunk));
        }
        putBytes = Buffer.concat(chunks);
        putContentType =
          (init?.headers as Record<string, string>)['content-type'] ?? null;
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    try {
      const result = await runMediaFileCommand([
        'upload',
        '--input-file',
        videoPath,
        '--hosted-operation-id',
        'upload-test-op',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);

      assert.equal(hostedBodies.length, 1);
      const body = hostedBodies[0] as Record<string, unknown>;
      assert.equal(body.capability, 'media-file');
      assert.equal(body.operation, 'create-upload-url');
      assert.deepEqual(body.file, {
        fingerprint: await createMediaFileFingerprint(videoPath),
        mimeType: 'video/mp4',
        name: 'clip.mp4',
        sizeBytes: fileBytes.length,
      });
      assert.equal(body.operationId, 'upload-test-op');
      // The bytes were streamed to the signed target, not embedded in the JSON body.
      assert.equal(putContentType, 'video/mp4');
      assert.deepEqual(putBytes, fileBytes);

      const output = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(output.output.mediaReference, mediaReference);
      assert.equal(Object.hasOwn(output.output, 'storageReference'), false);
      assert.equal(Object.hasOwn(output.output, 'signedUpload'), false);
      assert.equal(Object.hasOwn(output.output, 'data'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file upload rejects the retired --storage-only switch before network access', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-upload-'));
    tempDirs.push(uploadDir);
    const imagePath = resolve(uploadDir, 'person.png');
    await writeFile(imagePath, Buffer.from('fake-png-bytes'));

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch should not be called');
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'upload',
            '--input-file',
            imagePath,
            '--storage-only',
          ]),
        /storage-only/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download resolves a persistent reference and honors the last repeated boolean value', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'clip.mp4');
    const resultPath = resolve(downloadDir, 'result.json');
    const mediaReference =
      'postplus-media://uploads/user_1/hosted-media/outputs/clip.mp4';
    const mediaBytes = (await tinyVideoFixture()).bytes;

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    let stdoutText = '';
    let hostedBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://postplus.test/api/postplus-cli/hosted/capability') {
        hostedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            output: { signedUrl: 'https://download.test/signed-clip' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://download.test/signed-clip') {
        return new Response(mediaBytes, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    process.stdout.write = ((chunk: unknown) => {
      stdoutText += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await runMediaFileCommand([
        'download',
        '--reference',
        mediaReference,
        '--output-file',
        mediaPath,
        '--output',
        resultPath,
        '--json',
        '--json',
        'false',
      ]);
      assert.equal(result, 0);
      assert.equal(stdoutText, '');
      assert.deepEqual(await readFile(mediaPath), mediaBytes);
      const requestBody = hostedBody as Record<string, unknown>;
      assert.equal(requestBody.capability, 'media-file');
      assert.deepEqual(requestBody.file, { mediaReference });
      assert.equal(requestBody.operation, 'create-read-url');
      assert.match(
        String(requestBody.operationId),
        /^postplus-cli:media-file:create-read-url:/u,
      );
      const output = JSON.parse(await readFile(resultPath, 'utf8'));
      assert.equal(output.output.downloadedTo, mediaPath);
      assert.equal(output.output.sizeBytes, mediaBytes.length);
      assert.equal(output.output.source, mediaReference);
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalStdoutWrite;
    }
  });

  it('media-file video download rejects a successful HTML response and preserves the existing media', async () => {
    const fixture = await tinyVideoFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><body>No media is available</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    try {
      await assert.rejects(
        runMediaFileCommand([
          'download',
          '--url',
          'https://download.test/source',
          '--output-file',
          fixture.filePath,
        ]),
        /media_video_html_without_media_redirect/u,
      );
      assert.deepEqual(await readFile(fixture.filePath), fixture.bytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download preserves an existing destination when streaming fails', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'clip.mp4');
    const originalBytes = Buffer.from('existing-complete-media');
    await writeFile(mediaPath, originalBytes);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('partial-replacement'));
          controller.error(new Error('mock download stream failed'));
        },
      });
      return new Response(body, { status: 200 });
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            'https://download.test/failing-clip',
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /stage=stream-bytes, host=download\.test/u,
          );
          assert.match(error.message, /mock download stream failed/u);
          assert.doesNotMatch(error.message, /failing-clip/u);
          return true;
        },
      );
      assert.deepEqual(await readFile(mediaPath), originalBytes);
      assert.deepEqual(await readdir(downloadDir), ['clip.mp4']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download reports the byte-fetch stage, host, and nested network cause without leaking the signed URL', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const signedUrl =
      'https://download.test/private/image.png?token=secret-download-token';
    const originalFetch = globalThis.fetch;
    const networkCause = Object.assign(
      new Error(`connect ECONNRESET ${signedUrl}`),
      {
        code: 'ECONNRESET',
        hostname: 'download.test',
        syscall: 'read',
      },
    );

    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', { cause: networkCause });
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            signedUrl,
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /stage=fetch-bytes, host=download\.test/u,
          );
          assert.match(error.message, /TypeError: fetch failed/u);
          assert.match(
            error.message,
            /code=ECONNRESET.*syscall=read.*hostname=download\.test/u,
          );
          assert.doesNotMatch(error.message, /secret-download-token/u);
          assert.doesNotMatch(error.message, /private\/image\.png/u);
          assert.doesNotMatch(error.message, /https:\/\//u);
          return true;
        },
      );
      await assert.rejects(() => readFile(mediaPath), { code: 'ENOENT' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download reports read-url resolution failures separately from byte fetching', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const mediaReference = 'postplus-media://uploads/user_1/private/image.png';

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const networkCause = Object.assign(
      new Error('getaddrinfo ENOTFOUND postplus.test'),
      {
        code: 'ENOTFOUND',
        hostname: 'postplus.test',
        syscall: 'getaddrinfo',
      },
    );

    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', { cause: networkCause });
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--reference',
            mediaReference,
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /stage=resolve-read-url, host=postplus\.test/u,
          );
          assert.match(error.message, /TypeError: fetch failed/u);
          assert.match(
            error.message,
            /code=ENOTFOUND.*syscall=getaddrinfo.*hostname=postplus\.test/u,
          );
          assert.doesNotMatch(error.message, /postplus-media:\/\//u);
          assert.doesNotMatch(error.message, /uploads\/user_1/u);
          assert.doesNotMatch(error.message, /private\/image\.png/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download preserves structured read-url product errors even when their message mentions network failure', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const mediaReference = 'postplus-media://uploads/user_1/private/image.png';

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stderrText = '';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_cli_hosted_media_read_failed',
          layer: 'hosted-capability',
          message: 'Provider network rejected the read request.',
          operationId: 'read-op-123',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await runMediaFileCommand([
        'download',
        '--reference',
        mediaReference,
        '--output-file',
        mediaPath,
        '--output',
        resolve(downloadDir, 'download-result.json'),
      ]);

      assert.equal(result, 1);
      assert.match(stderrText, /Provider network rejected the read request/u);
      assert.match(stderrText, /code=postplus_cli_hosted_media_read_failed/u);
      assert.match(stderrText, /operationId=read-op-123/u);
      assert.doesNotMatch(
        stderrText,
        /postplus_cli_hosted_media_download_failed/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
    }
  });

  it('media-file download reports HTTP response failures without exposing URL paths or query parameters', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const signedUrl =
      'https://download.test/private/image.png?token=secret-download-token';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('temporarily unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      });

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            signedUrl,
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /stage=receive-response, host=download\.test/u,
          );
          assert.match(error.message, /HTTP 503 Service Unavailable/u);
          assert.doesNotMatch(error.message, /secret-download-token/u);
          assert.doesNotMatch(error.message, /private\/image\.png/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download follows at most five HTTPS redirects', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const mediaBytes = Buffer.from('redirected-image');
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      if (requestedUrls.length <= 5) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://download.test/private/step-${requestedUrls.length}?token=secret-${requestedUrls.length}`,
          },
        });
      }
      return new Response(mediaBytes, { status: 200 });
    };

    try {
      const result = await runMediaFileCommand([
        'download',
        '--url',
        'https://download.test/private/start?token=secret-start',
        '--output-file',
        mediaPath,
        '--output',
        resolve(downloadDir, 'redirect-result.json'),
      ]);
      assert.equal(result, 0);
      assert.equal(requestedUrls.length, 6);
      assert.deepEqual(await readFile(mediaPath), mediaBytes);

      let redirectCalls = 0;
      globalThis.fetch = async () => {
        redirectCalls += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://download.test/private/overflow-${redirectCalls}?token=overflow-secret`,
          },
        });
      };
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            'https://download.test/private/start?token=secret-start',
            '--output-file',
            resolve(downloadDir, 'overflow.png'),
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Redirect limit exceeded \(5\)/u);
          assert.doesNotMatch(error.message, /overflow-secret/u);
          assert.doesNotMatch(error.message, /private\/overflow/u);
          return true;
        },
      );
      assert.equal(redirectCalls, 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download refuses redirects that leave HTTPS', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'http://insecure.test/private/image.png?token=secret-redirect-token',
        },
      });
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            'https://download.test/private/start?token=secret-start',
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Refused media redirect to non-HTTPS host=insecure\.test/u,
          );
          assert.doesNotMatch(error.message, /secret-redirect-token/u);
          assert.doesNotMatch(error.message, /private\/image\.png/u);
          return true;
        },
      );
      assert.equal(fetchCalls, 1);
      await assert.rejects(() => readFile(mediaPath), { code: 'ENOENT' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media-file download emits a bounded redacted 503 body only on debug stderr', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'image.png');
    const originalFetch = globalThis.fetch;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    let stderrText = '';
    let stdoutText = '';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          message: 'storage temporarily unavailable',
          mediaReference:
            'postplus-media://results/user/private/storage-object',
          signedUrl:
            'https://storage.test/private/object.png?token=signed-secret',
          token: 'response-secret-token',
        }),
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        },
      );
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      stdoutText += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await assert.rejects(() =>
        runMediaFileCommand([
          'download',
          '--url',
          'https://storage.test/private/object.png?token=request-secret',
          '--output-file',
          mediaPath,
          '--debug',
          '--json',
        ]),
      );
      assert.equal(stdoutText, '');
      assert.match(
        stderrText,
        /media-download response status=503 Service Unavailable/u,
      );
      assert.match(stderrText, /storage temporarily unavailable/u);
      assert.match(stderrText, /"token":"\[redacted\]"/u);
      assert.match(
        stderrText,
        /https:\/\/storage\.test\/\[redacted-path\]\?\[redacted\]/u,
      );
      assert.doesNotMatch(stderrText, /private\/object\.png/u);
      assert.match(stderrText, /\[redacted-media-reference\]/u);
      assert.doesNotMatch(stderrText, /request-secret/u);
      assert.doesNotMatch(stderrText, /signed-secret/u);
      assert.doesNotMatch(stderrText, /response-secret-token/u);
      assert.doesNotMatch(stdoutText, /postplus debug/u);
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    }
  });

  it('media-file upload surfaces a structured hosted error from create-upload-url', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-upload-'));
    tempDirs.push(uploadDir);
    const videoPath = resolve(uploadDir, 'clip.mp4');
    const outputPath = resolve(uploadDir, 'result.json');
    await writeFile(videoPath, Buffer.from('bytes'));

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let putCount = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://postplus.test/api/postplus-cli/hosted/capability') {
        return new Response(
          JSON.stringify({
            code: 'postplus_cli_hosted_media_upload_rejected',
            layer: 'hosted-capability',
            message: 'Mock upload rejected.',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      putCount += 1;
      return new Response('{}', { status: 200 });
    };

    try {
      const result = await runMediaFileCommand([
        'upload',
        '--input-file',
        videoPath,
        '--output',
        outputPath,
      ]);
      assert.equal(result, 1);
      assert.equal(putCount, 0);
      const output = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(
        output.error.code,
        'postplus_cli_hosted_media_upload_rejected',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('submits a manifest-driven image create request (flags) and fills the platform defaults', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-text',
        '--prompt',
        'a calm vertical product hero shot',
        '--aspect-ratio',
        '3:4',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.operation, 'request');
      assert.equal(body.endpointKey, 'image-gpt-image-2-text');
      // intent prompt + agent override aspect, with platform defaults filled in;
      // no asset-state field (assetId/runId/localAssetDir) reaches the request.
      assert.deepEqual(body.input, {
        aspect_ratio: '3:4',
        prompt: 'a calm vertical product hero shot',
        quality: 'medium',
        resolution: '1k',
      });
      // Billing dimensions are derived solely at the Web boundary; the CLI sends
      // only the payload, so the wire body carries no requestDimensions.
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('collects repeated --reference-image flags into the edit images array', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-edit',
        '--prompt',
        'recolor the jacket to navy',
        '--reference-image',
        'https://example.com/ref-a.png',
        '--reference-image',
        'https://example.com/ref-b.png',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.endpointKey, 'image-gpt-image-2-edit');
      assert.deepEqual((body.input as Record<string, unknown>).images, [
        'https://example.com/ref-a.png',
        'https://example.com/ref-b.png',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stages a local media field durably before the single generation submit', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const inputDir = await mkdtemp(resolve(tmpdir(), 'postplus-local-media-'));
    tempDirs.push(inputDir);
    const localImage = resolve(inputDir, 'reference image.png');
    await writeFile(localImage, 'png-bytes');

    const originalFetch = globalThis.fetch;
    const hostedBodies: Record<string, unknown>[] = [];
    let signedPutCount = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://storage.example.com/signed-upload') {
        signedPutCount += 1;
        assert.equal(init?.method, 'PUT');
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      hostedBodies.push(body);
      if (body.capability === 'media-file') {
        assert.equal(body.operation, 'create-upload-url');
        return new Response(
          JSON.stringify({
            output: {
              mediaReference:
                'postplus-media://uploads/users/user_1/hosted-media/inputs/ref.png',
              signedUpload: {
                method: 'PUT',
                requiredHeaders: { 'content-type': 'image/png' },
                url: 'https://storage.example.com/signed-upload',
              },
              storageReference: {
                bucket: 'postplus-media',
                mimeType: 'image/png',
                name: 'reference image.png',
                storagePath: 'uploads/user_1/ref.png',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-edit',
        '--prompt',
        'recolor the jacket to navy',
        '--reference-image',
        localImage,
      ]);
      assert.equal(result, 0);
      assert.equal(signedPutCount, 1);
      assert.equal(hostedBodies.length, 2);
      const submit = hostedBodies[1]!;
      assert.equal(submit.capability, 'media-generation');
      assert.deepEqual((submit.input as Record<string, unknown>).images, [
        'postplus-media://uploads/users/user_1/hosted-media/inputs/ref.png',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deduplicates repeated local media by content and reuses the scoped cache', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const inputDir = await mkdtemp(resolve(tmpdir(), 'postplus-local-media-'));
    tempDirs.push(inputDir);
    const localImage = resolve(inputDir, '同一张图片.png');
    await writeFile(localImage, 'same-png-bytes');

    const originalFetch = globalThis.fetch;
    let createUploadCount = 0;
    let putCount = 0;
    let submitCount = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://storage.example.com/cache-upload') {
        putCount += 1;
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.capability === 'media-file') {
        createUploadCount += 1;
        return new Response(
          JSON.stringify({
            output: {
              mediaReference:
                'postplus-media://uploads/users/user_1/hosted-media/inputs/cached.png',
              signedUpload: {
                method: 'PUT',
                requiredHeaders: {},
                url: 'https://storage.example.com/cache-upload',
              },
              storageReference: {
                bucket: 'postplus-media',
                mimeType: 'image/png',
                name: 'cached.png',
                storagePath: 'uploads/user_1/cached.png',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      submitCount += 1;
      assert.deepEqual((body.input as Record<string, unknown>).images, [
        'postplus-media://uploads/users/user_1/hosted-media/inputs/cached.png',
        'postplus-media://uploads/users/user_1/hosted-media/inputs/cached.png',
      ]);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const command = [
      'create',
      'image-gpt-image-2-edit',
      '--prompt',
      'keep both references',
      '--reference-image',
      localImage,
      '--reference-image',
      `@${localImage}`,
    ];
    try {
      assert.equal(await runHostedDomainCommand('media', command), 0);
      assert.equal(await runHostedDomainCommand('media', command), 0);
      assert.equal(createUploadCount, 1);
      assert.equal(putCount, 1);
      assert.equal(submitCount, 2);
      const cache = JSON.parse(
        await readFile(
          resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-staging-cache.json'),
          'utf8',
        ),
      ) as { entries: Record<string, unknown> };
      assert.equal(Object.keys(cache.entries).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('persists partial staging progress and resumes at the first failed media item', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const inputDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-partial-media-'),
    );
    tempDirs.push(inputDir);
    const firstImage = resolve(inputDir, 'first.png');
    const secondImage = resolve(inputDir, 'second.png');
    await writeFile(firstImage, 'first-png-bytes');
    await writeFile(secondImage, 'second-png-bytes');

    const originalFetch = globalThis.fetch;
    const stageCounts = new Map<string, number>();
    let submitCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://storage.example.com/partial-')) {
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.capability === 'media-file') {
        const file = body.file as { name: string };
        const attempt = (stageCounts.get(file.name) ?? 0) + 1;
        stageCounts.set(file.name, attempt);
        if (file.name === 'second.png' && attempt === 1) {
          return new Response(
            JSON.stringify({
              code: 'postplus_cli_hosted_media_storage_unavailable',
              layer: 'hosted-capability',
              message: 'Mock second input staging failed.',
              operationId: body.operationId,
              userMessageRule: 'retry_later',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            output: {
              mediaReference: `postplus-media://uploads/users/user_1/hosted-media/inputs/${file.name}`,
              signedUpload: {
                method: 'PUT',
                requiredHeaders: { 'content-type': 'image/png' },
                url: `https://storage.example.com/partial-${file.name}`,
              },
              storageReference: {
                bucket: 'uploads',
                mimeType: 'image/png',
                name: file.name,
                storagePath: `users/user_1/hosted-media/inputs/${file.name}`,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      submitCount += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const command = [
      'create',
      'image-gpt-image-2-edit',
      '--prompt',
      'combine the references',
      '--reference-image',
      firstImage,
      '--reference-image',
      secondImage,
    ];
    try {
      await assert.rejects(
        runHostedDomainCommand('media', command),
        /postplus_cli_hosted_media_storage_unavailable/u,
      );
      assert.equal(submitCount, 0);

      assert.equal(await runHostedDomainCommand('media', command), 0);
      assert.equal(stageCounts.get('first.png'), 1);
      assert.equal(stageCounts.get('second.png'), 2);
      assert.equal(submitCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects missing explicit paths and wrong media kinds before the network', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const inputDir = await mkdtemp(resolve(tmpdir(), 'postplus-local-media-'));
    tempDirs.push(inputDir);
    const imagePath = resolve(inputDir, 'not-audio.png');
    await writeFile(imagePath, 'png-bytes');
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    };
    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-gpt-image-2-edit',
            '--prompt',
            'test',
            '--reference-image',
            '@missing-image.png',
          ]),
        /Local media file is not readable/u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'voice-clone',
            '--text',
            'hello',
            '--audio',
            imagePath,
          ]),
        /--audio expects audio.*image\/png/u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-file bare and insecure media values before any hosted call', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    };
    try {
      for (const badReference of [
        'definitely-not-a-local-file.png',
        'http://example.com/ref-a.png',
      ]) {
        await assert.rejects(
          () =>
            runHostedDomainCommand('media', [
              'create',
              'image-gpt-image-2-edit',
              '--prompt',
              'recolor the jacket to navy',
              '--reference-image',
              badReference,
            ]),
          /must be an https:\/\/ URL, a postplus-media:\/\/ reference, or a data: URI/u,
        );
      }
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts all three legal media-url schemes and submits the request', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (_input, init) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const references = [
        'https://example.com/ref-a.png',
        'postplus-media://postplus-media/uploads/user_1/ref-b.png',
        'data:image/png;base64,aGk=',
      ];
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-edit',
        '--prompt',
        'recolor the jacket to navy',
        ...references.flatMap((reference) => ['--reference-image', reference]),
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.deepEqual(
        (body.input as Record<string, unknown>).images,
        references,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps Nano Pro edit aspect ratio optional and rejects unverified square requests locally', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      postedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-nano-banana-pro-edit-1k',
        '--prompt',
        'reframe the product photo',
        '--reference-image',
        'https://example.com/ref.png',
      ]);
      assert.equal(result, 0);
      const body = postedBodies[0] as Record<string, unknown>;
      assert.deepEqual(body.input, {
        images: ['https://example.com/ref.png'],
        output_format: 'png',
        prompt: 'reframe the product photo',
        resolution: '1k',
      });

      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-nano-banana-pro-edit-1k',
            '--prompt',
            'reframe the product photo',
            '--reference-image',
            'https://example.com/ref.png',
            '--aspect-ratio',
            '1:1',
          ]),
        /image-nano-banana-pro-edit-1k aspect_ratio must be one of 9:16, 16:9, 4:5; received "1:1"\./u,
      );
      assert.equal(postedBodies.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects runner-managed asset-state flags on the image create verb', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      for (const assetFlag of ['--asset-id', '--run-id', '--local-asset-dir']) {
        await assert.rejects(
          () =>
            runHostedDomainCommand('media', [
              'create',
              'image-gpt-image-2-text',
              '--prompt',
              'a hero shot',
              assetFlag,
              'agent-supplied',
            ]),
          new RegExp(
            `Unknown option for media create: ${assetFlag.replace(/[-]/gu, '[-]')}`,
            'u',
          ),
        );
      }
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('names sibling endpoints that accept a flag rejected by the selected endpoint', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      // --reference-image is declared only on edit endpoints; a text-endpoint
      // submit must point at them instead of a bare unknown-option rejection.
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-gpt-image-2-text',
            '--prompt',
            'a hero shot',
            '--reference-image',
            'https://example.com/ref.png',
          ]),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          assert.match(
            message,
            /^Unknown option for media create: --reference-image\. Endpoint image-gpt-image-2-text does not accept it; it is supported by: /u,
          );
          assert.match(message, /image-gpt-image-2-edit/u);
          assert.doesNotMatch(
            message,
            /image-gpt-image-2-text.*supported by.*image-gpt-image-2-text/u,
          );
          return true;
        },
      );

      // A flag no endpoint declares stays a bare unknown-option rejection.
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-gpt-image-2-text',
            '--prompt',
            'a hero shot',
            '--refrence-image',
            'https://example.com/ref.png',
          ]),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          assert.equal(
            message,
            'Unknown option for media create: --refrence-image.',
          );
          return true;
        },
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('early-validates image resolution/quality enums locally before any hosted call', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-gpt-image-2-text',
            '--prompt',
            'a hero shot',
            '--quality',
            'ultra',
          ]),
        /image-gpt-image-2-text quality must be one of low, medium, high; received "ultra"\./u,
      );
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-nano-banana-2-text',
            '--prompt',
            'a hero shot',
            '--resolution',
            '8k',
          ]),
        /image-nano-banana-2-text resolution must be one of 0\.5k, 1k, 2k, 4k; received "8k"\./u,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts mixed-case image resolution/quality flags by canonicalizing before the enum check (#475)', async () => {
    // The whole point of reading the manifest canonicalize hint: a mixed-case flag
    // that the Web boundary would accept must not be wrongly rejected locally. "4K"
    // canonicalizes to the k-tier "4k"; "High" lowercases to "high".
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        String(input),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runHostedDomainCommand('media', [
        'create',
        'image-gpt-image-2-text',
        '--prompt',
        'a hero shot',
        '--resolution',
        '4K',
        '--quality',
        'High',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      const sentInput = body.input as Record<string, unknown>;
      // The CLI passes the raw flag value through (the Web boundary canonicalizes the
      // outbound body); local validation only canonicalizes for the membership check.
      assert.equal(sentInput.resolution, '4K');
      assert.equal(sentInput.quality, 'High');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves the structured product error envelope and exits non-zero', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_cli_hosted_provider_timeout',
          error: 'Media generation timed out while calling the provider.',
          layer: 'hosted-capability',
          message: 'Media generation timed out while calling the provider.',
          operationId: 'op-from-web-123',
          status: 504,
          userMessageRule: 'retry_later',
        }),
        {
          status: 504,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      const result = await runHostedDomainCommand('media', [
        'transcribe',
        'transcription',
        '--audio',
        'https://example.com/a.mp3',
        '--duration-seconds',
        '30',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 1);
      const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
        error: Record<string, unknown>;
      };
      assert.deepEqual(written.error, {
        code: 'postplus_cli_hosted_provider_timeout',
        layer: 'hosted-capability',
        message: 'Media generation timed out while calling the provider.',
        operationId: 'op-from-web-123',
        userMessageRule: 'retry_later',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves and prints the official account action for insufficient credits', async () => {
    const requestDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-balance-'),
    );
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = '';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_cli_balance_required',
          error:
            'This account does not have enough PostPlus credits. Add credits, then retry the same request.',
          layer: 'balance',
          operationId: 'op-balance-123',
          status: 402,
          userAction: {
            label: 'Add PostPlus credits',
            type: 'open_url',
            url: 'https://postplus.test/home/workspace/billing',
          },
          userMessageRule: 'account_action',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await runHostedDomainCommand('media', [
        'transcribe',
        'transcription',
        '--audio',
        'https://example.com/a.mp3',
        '--duration-seconds',
        '30',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 1);
      const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
        error: Record<string, unknown>;
      };
      assert.deepEqual(written.error.userAction, {
        label: 'Add PostPlus credits',
        type: 'open_url',
        url: 'https://postplus.test/home/workspace/billing',
      });
      assert.match(
        stderr,
        /Add PostPlus credits: https:\/\/postplus\.test\/home\/workspace\/billing/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
  });

  it('does not print unsafe hosted account-action URLs', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_cli_balance_required',
          error: 'Insufficient credits.',
          userAction: {
            label: 'Add PostPlus credits',
            type: 'open_url',
            url: 'javascript:alert(1)',
          },
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );

    try {
      await assert.rejects(
        () =>
          runHostedRequest({
            domain: 'media',
            args: [
              'create',
              'video-seedance-2-text',
              '--prompt',
              'unsafe action',
              '--hosted-operation-id',
              'op-unsafe-action',
            ],
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 'cli-session-token',
            },
            skillsReleaseId: 'release-unsafe-action',
          }),
        (error: unknown) =>
          error instanceof Error &&
          /Insufficient credits/u.test(error.message) &&
          !/javascript:/u.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('invalidates the update cache immediately on a hosted 426 response', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const cachePath = resolve(
      process.env.POSTPLUS_CONFIG_DIR!,
      'update-check.json',
    );
    await writeFile(cachePath, '{"checkedAt":"2099-01-01T00:00:00.000Z"}\n');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_client_upgrade_required',
          error: 'Update required.',
          compatibility: { upgrade: { command: 'postplus update' } },
        }),
        { status: 426, headers: { 'content-type': 'application/json' } },
      );
    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'image-gpt-image-2-text',
            '--prompt',
            'test',
          ]),
        (error) =>
          error instanceof PostPlusClientUpgradeRequiredError &&
          /Run: postplus update/u.test(error.message),
      );
      await assert.rejects(() => readFile(cachePath, 'utf8'), {
        code: 'ENOENT',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reuses an existing owned media read URL without uploading a new PostPlus Storage object', async () => {
    const fixture = await tinyVideoFixture();
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const source =
      'postplus-media://uploads/user_1/hosted-media/outputs/clip.mp4';
    const originalFetch = globalThis.fetch;
    let reads = 0;
    const upload = withGoogleVideoUpload(async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).operation, 'analyze');
      return Response.json({
        output: {
          data: {
            id: 'owned-run',
            status: 'completed',
            markdown: 'Owned video.\n',
          },
        },
      });
    }, fixture);
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://download.test/existing.mp4')
        return new Response(fixture.bytes);
      if (
        String(url) ===
        'https://postplus.test/api/postplus-cli/hosted/capability'
      ) {
        const body = JSON.parse(String(init?.body));
        if (body.capability === 'media-file') {
          assert.equal(body.operation, 'create-read-url');
          assert.deepEqual(body.file, { mediaReference: source });
          reads++;
          return Response.json({
            output: { signedUrl: 'https://download.test/existing.mp4' },
          });
        }
      }
      return upload(url, init);
    };
    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          source,
          '--output',
          resolve(fixture.filePath, '..', 'owned.md'),
        ]),
        0,
      );
      assert.equal(reads, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('prepares a local video as readable evidence without authentication or hosted requests', async () => {
    const fixture = await tinyVideoFixture();
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    let result:
      | { kind: string; filePath: string; metadata: { hasAudio: boolean } }
      | undefined;
    globalThis.fetch = async () =>
      assert.fail('local evidence requires no hosted call');
    console.log = (value: string) => {
      result = JSON.parse(value);
    };
    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'prepare',
          '--source',
          fixture.filePath,
        ]),
        0,
      );
      assert.equal(result?.kind, 'video');
      assert.equal(result?.filePath, fixture.filePath);
      assert.equal(result?.metadata.hasAudio, true);
      assert.deepEqual(await readFile(fixture.filePath), fixture.bytes);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  });

  it('writes a structured prepare-upload failure to output while preserving the private recovery checkpoint', async () => {
    const fixture = await tinyVideoFixture();
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const outputPath = resolve(fixture.filePath, '..', 'upload-failure.json');
    const originalFetch = globalThis.fetch;
    const operations: string[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(
        String(url),
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      const body = JSON.parse(String(init?.body));
      operations.push(body.operation);
      assert.equal(
        body.operation,
        'prepare-upload',
        'failure must not upload bytes or submit analysis',
      );
      return Response.json(
        {
          code: 'video_analysis_upload_invalid',
          error: 'Upload metadata was rejected.',
          operationId: body.operationId,
          stage: 'uploading_to_provider',
          retryable: false,
          userAction: 'Correct the upload metadata before retrying.',
        },
        { status: 400 },
      );
    };
    try {
      assert.equal(
        await runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          fixture.filePath,
          '--output',
          outputPath,
          '--hosted-operation-id',
          'upload-rejected-operation',
        ]),
        1,
      );
      const output = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(output.error.code, 'video_analysis_upload_invalid');
      assert.equal(output.error.operationId, 'upload-rejected-operation');
      assert.equal(output.error.stage, 'uploading_to_provider');
      assert.equal(
        output.error.userAction,
        'Correct the upload metadata before retrying.',
      );
      const directory = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs');
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      const checkpointPath = resolve(directory, files[0]!);
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
      assert.equal(checkpoint.operationId, 'upload-rejected-operation');
      assert.equal(checkpoint.videoTransfer.phase, 'upload-preparing');
      assert.equal(checkpoint.videoTransfer.filePath, fixture.filePath);
      assert.equal(checkpoint.analysisSubmissionAttempted, undefined);
      assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
      assert.ok(!('videoTransfer' in output));
      assert.deepEqual(operations, ['prepare-upload']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const code of [
    'video_analysis_quote_unavailable',
    'video_analysis_upload_invalid',
  ]) {
    it(`pre-admission ${code} can resume the same uploaded file`, async () => {
      const fixture = await tinyVideoFixture();
      await setLocalSession({
        accountId: 'account_1',
        accountName: 'Account',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'cli-session-token',
        sessionExpiresAt: null,
        userEmail: 'agent@example.com',
        userId: 'user_1',
      });
      const originalFetch = globalThis.fetch;
      const outputPath = resolve(fixture.filePath, '..', 'count-report.md');
      let submissions = 0;
      globalThis.fetch = withGoogleVideoUpload(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.operation, 'analyze');
        submissions++;
        if (submissions === 1)
          return Response.json(
            {
              code,
              analysisSubmissionRejected: true,
              error: 'Input count failed before analysis.',
            },
            { status: 502 },
          );
        return Response.json({
          output: {
            data: {
              id: 'count-run',
              status: 'completed',
              markdown: 'Counted report.\n',
            },
          },
        });
      }, fixture);
      const args = [
        'analyze',
        'video-analysis',
        '--video',
        fixture.filePath,
        '--output',
        outputPath,
        '--hosted-operation-id',
        'operation-1',
      ];
      try {
        assert.equal(await runHostedDomainCommand('media', args), 1);
        assert.equal(await runHostedDomainCommand('media', args), 0);
        assert.equal(submissions, 2);
        assert.equal(await readFile(outputPath, 'utf8'), 'Counted report.\n');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  for (const rejection of [
    'postplus_cli_cloud_release_in_progress',
    'postplus_client_upgrade_required',
    'unknown-json-503',
    'unknown-html-503',
  ]) {
    it(`video recovery preserves submission certainty after ${rejection}`, async () => {
      const fixture = await tinyVideoFixture();
      await setLocalSession({
        accountId: 'account_1',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'cli-session-token',
        sessionExpiresAt: null,
        userId: 'user_1',
      });
      const originalFetch = globalThis.fetch;
      const outputPath = resolve(
        fixture.filePath,
        '..',
        'compatibility-report.md',
      );
      const rejectedBeforeExecution = !rejection.startsWith('unknown-');
      const operations: string[] = [];
      let executions = 0;
      let statusGuardReturned = false;
      globalThis.fetch = withGoogleVideoUpload(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        operations.push(body.operation);
        if (body.operation === 'analyze') {
          assert.equal(body.operationId, 'compatibility-operation');
          if (operations.length === 1) {
            if (rejection === 'unknown-html-503')
              return new Response('<html>Service unavailable</html>', {
                status: 503,
              });
            return Response.json(
              {
                code: rejection,
                // The wording alone must never prove pre-execution rejection.
                error:
                  'PostPlus Cloud is updating. Please retry in about one minute.',
              },
              {
                status:
                  rejection === 'postplus_client_upgrade_required' ? 426 : 503,
              },
            );
          }
          assert.equal(
            rejectedBeforeExecution,
            true,
            'unknown outcomes must not resubmit',
          );
          executions++;
        } else {
          assert.equal(body.operation, 'status');
          assert.equal(body.sourceOperationId, 'compatibility-operation');
          assert.equal(rejectedBeforeExecution, false);
          if (!statusGuardReturned) {
            statusGuardReturned = true;
            return Response.json(
              {
                code: 'postplus_cli_cloud_release_in_progress',
              },
              { status: 503 },
            );
          }
        }
        return Response.json({
          output: {
            data: {
              id: 'compatibility-run',
              status: 'completed',
              markdown: 'Recovered report.\n',
            },
          },
        });
      }, fixture);
      try {
        const firstCall = runHostedDomainCommand('media', [
          'analyze',
          'video-analysis',
          '--video',
          fixture.filePath,
          '--output',
          outputPath,
          '--hosted-operation-id',
          'compatibility-operation',
        ]);
        if (rejectedBeforeExecution || rejection === 'unknown-html-503')
          await assert.rejects(firstCall);
        else assert.equal(await firstCall, 1);
        const directory = resolve(
          process.env.POSTPLUS_CONFIG_DIR!,
          'media-runs',
        );
        const checkpointPath = resolve(
          directory,
          (await readdir(directory))[0]!,
        );
        const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
        assert.equal(checkpoint.operationId, 'compatibility-operation');
        assert.equal(
          checkpoint.analysisSubmissionAttempted,
          rejectedBeforeExecution ? undefined : true,
        );
        assert.equal(checkpoint.videoTransfer.phase, 'uploaded');
        const resume = [
          'poll',
          '--resume-from',
          checkpointPath,
          '--wait-seconds',
          '0',
          '--output',
          outputPath,
        ];
        if (!rejectedBeforeExecution) {
          await assert.rejects(
            () => runHostedDomainCommand('media', resume),
            /Cloud is updating/u,
          );
          assert.equal(
            JSON.parse(await readFile(checkpointPath, 'utf8'))
              .analysisSubmissionAttempted,
            true,
            'a compatibility rejection of status cannot prove the original submit was rejected',
          );
        }
        assert.equal(await runHostedDomainCommand('media', resume), 0);
        assert.deepEqual(
          operations,
          rejectedBeforeExecution
            ? ['analyze', 'analyze']
            : ['analyze', 'status', 'status'],
        );
        assert.equal(executions, rejectedBeforeExecution ? 1 : 0);
        assert.equal(await readFile(outputPath, 'utf8'), 'Recovered report.\n');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  for (const phase of ['resolve-source', 'prepare-upload'] as const) {
    for (const knownRejection of [true, false]) {
      it(`video ${phase} recovery distinguishes compatibility rejection from unknown 503: ${knownRejection}`, async () => {
        const fixture = await tinyVideoFixture();
        await setLocalSession({
          accountId: 'account_1',
          apiBaseUrl: 'https://postplus.test',
          cliSessionToken: 'cli-session-token',
          sessionExpiresAt: null,
          userId: 'user_1',
        });
        const originalFetch = globalThis.fetch;
        const operations: string[] = [];
        let rejected = 0;
        const rejectionCount = phase === 'prepare-upload' ? 2 : 1;
        const outputPath = resolve(fixture.filePath, '..', 'transfer-guard.md');
        const source =
          phase === 'resolve-source'
            ? 'https://www.tiktok.com/@example/video/123'
            : fixture.filePath;
        const upload = withGoogleVideoUpload(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.operation, 'analyze');
          return Response.json({
            output: {
              data: {
                id: 'transfer-guard-run',
                status: 'completed',
                markdown: 'Transfer recovered.\n',
              },
            },
          });
        }, fixture);
        globalThis.fetch = async (url, init) => {
          if (String(url) === 'https://download.test/source.mp4')
            return new Response(fixture.bytes, {
              headers: { 'content-type': 'video/mp4' },
            });
          if (
            String(url) ===
            'https://postplus.test/api/postplus-cli/hosted/capability'
          ) {
            const body = JSON.parse(String(init?.body));
            operations.push(body.operation);
            assert.equal(body.operationId, 'transfer-guard-operation');
            if (body.operation === phase && rejected < rejectionCount) {
              rejected++;
              return Response.json(
                {
                  code: knownRejection
                    ? 'postplus_cli_cloud_release_in_progress'
                    : 'unknown_gateway_failure',
                  error:
                    'PostPlus Cloud is updating. Please retry in about one minute.',
                },
                { status: 503 },
              );
            }
            if (['resolve-source', 'source-status'].includes(body.operation))
              return Response.json({
                output: {
                  status: 'completed',
                  source: {
                    kind: 'video',
                    videoCandidates: [
                      { url: 'https://download.test/source.mp4' },
                    ],
                  },
                },
              });
          }
          return upload(url, init);
        };
        try {
          let command = [
            'analyze',
            'video-analysis',
            '--video',
            source,
            '--hosted-operation-id',
            'transfer-guard-operation',
            '--output',
            outputPath,
          ];
          let checkpointPath = '';
          for (let attempt = 1; attempt <= rejectionCount; attempt++) {
            if (knownRejection)
              await assert.rejects(
                () => runHostedDomainCommand('media', command),
                /Cloud is updating/u,
              );
            else
              assert.equal(await runHostedDomainCommand('media', command), 1);
            const directory = resolve(
              process.env.POSTPLUS_CONFIG_DIR!,
              'media-runs',
            );
            checkpointPath = resolve(directory, (await readdir(directory))[0]!);
            const checkpoint = JSON.parse(
              await readFile(checkpointPath, 'utf8'),
            );
            assert.equal(checkpoint.operationId, 'transfer-guard-operation');
            assert.equal(checkpoint.analysisSubmissionAttempted, undefined);
            if (phase === 'resolve-source')
              assert.equal(
                checkpoint.videoTransfer.sourceSubmissionAttempted,
                knownRejection ? undefined : true,
              );
            else
              assert.equal(
                checkpoint.videoTransfer.uploadPreparationAttempts ?? 0,
                knownRejection ? 0 : attempt,
              );
            command = [
              'poll',
              '--resume-from',
              checkpointPath,
              '--wait-seconds',
              '0',
              '--output',
              outputPath,
            ];
          }
          if (phase === 'prepare-upload' && !knownRejection) {
            await assert.rejects(() =>
              runHostedDomainCommand('media', command),
            );
            assert.deepEqual(
              operations,
              ['prepare-upload', 'prepare-upload'],
              'unknown preparation outcomes keep their bounded allowance',
            );
            const checkpoint = JSON.parse(
              await readFile(checkpointPath, 'utf8'),
            );
            assert.equal(checkpoint.videoTransfer.uploadPreparationAttempts, 2);
            assert.equal(checkpoint.videoTransfer.uploadToken, undefined);
          } else {
            assert.equal(await runHostedDomainCommand('media', command), 0);
            assert.deepEqual(
              operations,
              phase === 'resolve-source'
                ? [
                    'resolve-source',
                    knownRejection ? 'resolve-source' : 'source-status',
                    'prepare-upload',
                    'analyze',
                  ]
                : [
                    'prepare-upload',
                    'prepare-upload',
                    'prepare-upload',
                    'analyze',
                  ],
            );
            assert.equal(
              await readFile(outputPath, 'utf8'),
              'Transfer recovered.\n',
            );
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }

  for (const pauseAt of ['submit', 'poll'] as const) {
    it(`public hosted-lib stops at async video quote on ${pauseAt} and confirms the same operation`, async () => {
      const originalFetch = globalThis.fetch;
      const challenge = buildLargeCreditChallenge({
        requiredTierMillicredits: 100_000,
      });
      const paused = {
        operationId: 'operation-1',
        output: {
          data: {
            id: 'async-quote-run',
            status: 'processing',
            error: {
              code: 'postplus_cli_quote_confirmation_required',
              quoteConfirmation: challenge,
            },
          },
        },
      };
      const bodies: Record<string, unknown>[] = [];
      let confirmed = false;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.operation === 'analyze') {
          assert.equal(body.operationId, 'operation-1');
          assert.equal(body.input.video, 'https://example.com/video.mp4');
          if (body.quoteConfirmationToken) {
            assert.equal(body.quoteConfirmationToken, 'confirmed-token');
            confirmed = true;
            return Response.json({
              output: {
                data: {
                  id: 'async-quote-run',
                  status: 'completed',
                  markdown: 'Confirmed.',
                },
              },
            });
          }
          if (pauseAt === 'poll')
            return Response.json({
              output: { data: { id: 'async-quote-run', status: 'accepted' } },
            });
        }
        assert.equal(confirmed, false);
        return Response.json(paused);
      };
      const args = [
        'analyze',
        'video-analysis',
        '--video',
        'https://example.com/video.mp4',
        '--hosted-operation-id',
        'operation-1',
      ];
      const auth = {
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'cli-session-token',
      };
      try {
        await assert.rejects(
          runHostedRequest({ domain: 'media', args, auth }),
          (error: unknown) => {
            assert.ok(error instanceof HostedQuoteConfirmationRequiredError);
            assert.deepEqual(
              error.challenge,
              readLargeCreditQuoteConfirmationChallenge(challenge),
            );
            assert.equal(
              (error as Error & { handle: string }).handle,
              'async-quote-run',
            );
            return true;
          },
        );
        assert.deepEqual(
          bodies.map((b) => b.operation),
          pauseAt === 'submit' ? ['analyze'] : ['analyze', 'status'],
        );
        await runHostedRequest({
          domain: 'media',
          args: [...args, '--quote-confirmation-token', 'confirmed-token'],
          auth,
        });
        assert.equal(confirmed, true);
        assert.equal(bodies.filter((b) => b.operation === 'analyze').length, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('async video quote retains the checkpoint and upload through failed and successful confirmation', async () => {
    const fixture = await tinyVideoFixture();
    const outputPath = resolve(fixture.filePath, '..', 'async-quote.md');
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const originalFetch = globalThis.fetch;
    const operations: string[] = [];
    let confirms = 0;
    let upgradeSeen = false;
    const paused = {
      operationId: 'operation-1',
      output: {
        data: {
          id: 'async-quote-run',
          status: 'processing',
          error: {
            code: 'postplus_cli_quote_confirmation_required',
            quoteConfirmation: challenge,
          },
        },
      },
    };
    globalThis.fetch = withGoogleVideoUpload(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      operations.push(body.operation);
      if (body.operation === 'status') return Response.json(paused);
      assert.equal(body.operationId, 'operation-1');
      if (!body.quoteConfirmationToken)
        return Response.json({
          output: { data: { id: 'async-quote-run', status: 'accepted' } },
        });
      confirms++;
      if (body.quoteConfirmationToken === 'bad-token')
        return Response.json({ quoteConfirmation: challenge }, { status: 402 });
      if (!upgradeSeen) {
        upgradeSeen = true;
        return Response.json({
          code: 'postplus_client_upgrade_required',
          compatibility: { upgrade: { cli: { required: true } } },
        }, { status: 426 });
      }
      return Response.json({
        output: {
          data: {
            id: 'async-quote-run',
            status: 'completed',
            markdown: 'Confirmed report.',
          },
        },
      });
    }, fixture);
    const args = [
      'analyze',
      'video-analysis',
      '--video',
      fixture.filePath,
      '--output',
      outputPath,
      '--hosted-operation-id',
      'operation-1',
    ];
    try {
      await assert.rejects(
        runHostedDomainCommand('media', args),
        /Quote confirmation challenge/u,
      );
      const directory = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs');
      const checkpointPath = resolve(directory, (await readdir(directory))[0]!);
      const pausedCheckpoint = JSON.parse(
        await readFile(checkpointPath, 'utf8'),
      );
      assert.equal(pausedCheckpoint.analysisSubmissionAttempted, true);
      assert.equal(pausedCheckpoint.analysisQuoteRequired, true);
      assert.equal(pausedCheckpoint.handle, 'async-quote-run');
      assert.equal(pausedCheckpoint.videoTransfer.phase, 'uploaded');
      assert.deepEqual(operations, ['analyze', 'status']);
      await assert.rejects(
        runHostedDomainCommand('media', [
          ...args,
          '--quote-confirmation-token',
          'bad-token',
        ]),
        /Quote confirmation challenge/u,
      );
      assert.deepEqual(
        JSON.parse(await readFile(checkpointPath, 'utf8')),
        pausedCheckpoint,
      );
      let recoveryArgs: string[] | undefined;
      await assert.rejects(
        runHostedDomainCommand('media', [...args, '--quote-confirmation-token', 'confirmed-token']),
        (error: unknown) => {
          assert.ok(error instanceof PostPlusClientUpgradeRequiredError);
          recoveryArgs = error.recoveryArgs;
          assert.deepEqual(recoveryArgs, ['media', ...args, '--quote-confirmation-token', 'confirmed-token']);
          return true;
        },
      );
      assert.equal(await runHostedDomainCommand('media', recoveryArgs!.slice(1)), 0);
      const completed = JSON.parse(await readFile(checkpointPath, 'utf8'));
      assert.equal(completed.analysisSubmissionAttempted, true);
      assert.equal(completed.handle, 'async-quote-run');
      assert.equal(completed.analysisQuoteRequired, undefined);
      assert.equal(confirms, 3);
      assert.deepEqual(operations, ['analyze', 'status', 'analyze', 'analyze', 'analyze']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('video quote rejection preserves upload and allows one confirmed submission of the same operation', async () => {
    const fixture = await tinyVideoFixture();
    const outputPath = resolve(fixture.filePath, '..', 'quote-report.md');
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const originalFetch = globalThis.fetch;
    let analyzes = 0;
    globalThis.fetch = withGoogleVideoUpload(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(
        body.operation,
        'analyze',
        'a confirmed pre-admission rejection must submit, not poll a nonexistent run',
      );
      assert.equal(body.operationId, 'operation-1');
      analyzes++;
      if (analyzes === 1)
        return Response.json(
          {
            error: 'Confirmation required.',
            productErrorCode: 'postplus_cli_quote_confirmation_required',
            quoteConfirmation: challenge,
          },
          { status: 402 },
        );
      assert.equal(body.quoteConfirmationToken, 'confirmed-token');
      return Response.json({
        output: {
          data: {
            id: 'quote-run',
            status: 'completed',
            markdown: 'Confirmed report.\n',
          },
        },
      });
    }, fixture);
    const args = [
      'analyze',
      'video-analysis',
      '--video',
      fixture.filePath,
      '--output',
      outputPath,
      '--hosted-operation-id',
      'operation-1',
    ];
    try {
      await assert.rejects(
        runHostedDomainCommand('media', args),
        /Quote confirmation challenge:/u,
      );
      const directory = resolve(process.env.POSTPLUS_CONFIG_DIR!, 'media-runs');
      const checkpointPath = resolve(directory, (await readdir(directory))[0]!);
      const rejected = JSON.parse(await readFile(checkpointPath, 'utf8'));
      assert.equal(rejected.analysisSubmissionAttempted, undefined);
      assert.equal(rejected.videoTransfer.phase, 'uploaded');
      assert.equal(
        await runHostedDomainCommand('media', [
          ...args,
          '--quote-confirmation-token',
          'confirmed-token',
        ]),
        0,
      );
      assert.equal(
        analyzes,
        2,
        'one rejected pre-admission POST and one accepted POST',
      );
      assert.equal(await readFile(outputPath, 'utf8'), 'Confirmed report.\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('writes quote confirmation challenges beside hosted command outputs', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'result.json');
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error:
            'This request may reserve 100 credits and requires confirmation.',
          productErrorCode: 'postplus_cli_quote_confirmation_required',
          quoteConfirmation: challenge,
        }),
        {
          status: 402,
          headers: { 'content-type': 'application/json' },
        },
      );

    try {
      await assert.rejects(
        () =>
          runHostedDomainCommand('media', [
            'create',
            'video-seedance-2-text',
            '--prompt',
            'demo',
            '--resolution',
            '720p',
            '--duration',
            '5',
            '--output',
            outputPath,
          ]),
        (error) => {
          assert.match(
            String((error as Error).message),
            /Quote confirmation challenge:/u,
          );
          assert.match(
            String((error as Error).message),
            /--quote-confirmation-token <token>/u,
          );
          // The rerun guidance must pin the challenged operation id: the token is
          // server-signed against it, and the operationId flag otherwise defaults
          // to a fresh randomUUID() that would no longer match the token.
          assert.match(
            String((error as Error).message),
            /--hosted-operation-id operation-1 --quote-confirmation-token <token>/u,
          );
          return true;
        },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(`${outputPath}.quote-confirmation.json`, 'utf8'),
        ),
        challenge,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('account read-only commands', () => {
  for (const command of [
    { name: 'balance', run: () => fetchHostedBalance() },
    {
      name: 'runs list',
      run: () =>
        fetchHostedRunsList({
          status: null,
          since: null,
          limit: null,
          json: true,
        }),
    },
    { name: 'runs show', run: () => fetchHostedRunDetail('run-1') },
    { name: 'auth validate', run: () => validateRemoteAuth() },
    { name: 'auth refresh', run: () => refreshRemoteAuth() },
    { name: 'auth revoke', run: () => revokeRemoteAuth() },
  ]) {
    it(`preserves the typed update preflight rejection from ${command.name}`, async () => {
      await setLocalSession({
        accountId: 'account_1',
        accountName: 'Acme',
        accountType: 'personal',
        apiBaseUrl: 'https://postplus.test',
        cliSessionToken: 'test-session',
        sessionExpiresAt: null,
        userEmail: 'agent@example.com',
        userId: 'user_1',
      });
      const payload = {
        code: 'postplus_client_upgrade_required',
        error: 'Please update the client.',
        compatibility: {
          upgrade: {
            cli: { required: true },
            skills: { required: false },
            restartAgentSession: false,
          },
        },
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(payload), { status: 426 });
      try {
        await assert.rejects(command.run(), (error) => {
          assert.ok(error instanceof PostPlusClientUpgradeRequiredError);
          assert.deepEqual(error.payload, payload);
          return true;
        });
        assert.equal(
          (await readLocalConfig())?.cliSessionToken,
          'test-session',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  it('does not turn cloud release-in-progress or matching prose into client recovery', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      accountType: 'personal',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'test-session',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    const originalFetch = globalThis.fetch;
    try {
      for (const code of [
        'postplus_cli_cloud_release_in_progress',
        'unrelated_error',
      ]) {
        globalThis.fetch = async () =>
          new Response(
            JSON.stringify({
              code,
              error: 'Your PostPlus CLI or PostPlus skills are out of date.',
            }),
            { status: 503 },
          );
        await assert.rejects(fetchHostedBalance(), (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error instanceof PostPlusClientUpgradeRequiredError,
            false,
          );
          assert.equal(
            error.message,
            'Your PostPlus CLI or PostPlus skills are out of date.',
          );
          return true;
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads the hosted balance projection with a GET and normalizes it', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      accountType: 'team',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let requestedUrl: string | null = null;
    let requestedMethod: string | undefined;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method;
      return new Response(
        JSON.stringify({
          accountId: 'account_1',
          accountType: 'team',
          accountName: 'Acme',
          availableCredits: 42,
          reservedCredits: 1.5,
          subscriptionStatus: 'active',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const report = await fetchHostedBalance();
      assert.equal(
        requestedUrl,
        'https://postplus.test/api/postplus-cli/hosted/balance',
      );
      // A balance read is a pure GET — it must never POST (no reserve, no ledger).
      assert.equal(requestedMethod, 'GET');
      assert.deepEqual(report, {
        accountId: 'account_1',
        accountType: 'team',
        accountName: 'Acme',
        availableCredits: 42,
        reservedCredits: 1.5,
        subscriptionStatus: 'active',
      });
      const human = formatHostedBalanceReport(report);
      assert.match(human, /Available credits: 42/u);
      assert.match(human, /Reserved \(in-flight\): 1\.5 credits/u);
      assert.match(human, /Acme \(team\)/u);
      assert.match(human, /Subscription: active/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces a hosted balance error message verbatim', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error:
            'PostPlus CLI session is invalid or expired. Sign in again to continue.',
          code: 'postplus_cli_auth_invalid_session',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );

    try {
      await assert.rejects(
        () => fetchHostedBalance(),
        (error: unknown) =>
          error instanceof Error && /invalid or expired/u.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds runs list query paths from filters and lists with settled cost', async () => {
    assert.equal(
      buildRunsListPath(parseRunsListOptions([])),
      '/api/postplus-cli/hosted/runs',
    );
    assert.equal(
      buildRunsListPath(
        parseRunsListOptions([
          '--status',
          'completed',
          '--since',
          '2026-07-01T00:00:00Z',
          '--limit',
          '5',
        ]),
      ),
      '/api/postplus-cli/hosted/runs?status=completed&since=2026-07-01T00%3A00%3A00Z&limit=5',
    );

    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let requestedUrl: string | null = null;
    let requestedMethod: string | undefined;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method;
      return new Response(
        JSON.stringify({
          count: 1,
          runs: [
            {
              id: 'run_1',
              capability: 'media-generation',
              status: 'completed',
              target: 'video-seedance-2-text',
              createdAt: '2026-07-02T10:00:00Z',
              updatedAt: '2026-07-02T10:05:00Z',
              finalizedCredits: 3.2,
              reservedCredits: 4,
              hasError: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const report = await fetchHostedRunsList(
        parseRunsListOptions(['--limit', '10']),
      );
      assert.equal(
        requestedUrl,
        'https://postplus.test/api/postplus-cli/hosted/runs?limit=10',
      );
      assert.equal(requestedMethod, 'GET');
      assert.equal(report.runs.length, 1);
      const human = formatHostedRunsListReport(report);
      assert.match(human, /run_1/u);
      assert.match(human, /3\.2 credits/u);
      assert.doesNotMatch(human, /provider|millicredit/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads a single run detail with settled actual cost', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    let requestedUrl: string | null = null;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      assert.equal(init?.method, 'GET');
      return new Response(
        JSON.stringify({
          id: 'run_1',
          capability: 'media-generation',
          status: 'completed',
          target: 'video-seedance-2-text',
          operationId: 'postplus-cli:media:media-generation:request:abc',
          outputs: { data: { id: 'run_1' } },
          error: null,
          createdAt: '2026-07-02T10:00:00Z',
          updatedAt: '2026-07-02T10:05:00Z',
          completedAt: '2026-07-02T10:05:00Z',
          failedAt: null,
          expiresAt: '2026-07-09T10:00:00Z',
          finalizedCredits: 3.2,
          reservedCredits: 4,
          hasError: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const report = await fetchHostedRunDetail('run_1');
      assert.equal(
        requestedUrl,
        'https://postplus.test/api/postplus-cli/hosted/runs/run_1',
      );
      assert.equal(report.finalizedCredits, 3.2);
      assert.equal(Object.hasOwn(report, 'providerFamily'), false);
      assert.equal(Object.hasOwn(report, 'settlementEvidence'), false);
      const human = formatHostedRunDetailReport(report);
      assert.match(human, /Finalized: 3\.2 PostPlus credits/u);
      assert.doesNotMatch(human, /Moyu|provider|total_cost|markup/u);
      assert.match(human, /This run is terminal\./u);
      const pending = formatHostedRunDetailReport({
        ...report,
        billingPending: true,
        finalizedCredits: null,
        reservedCredits: null,
      });
      assert.match(pending, /Billing: pending verification/u);
      assert.doesNotMatch(pending, /Finalized:|Reserved:|0 PostPlus credits/u);
      const estimated = formatHostedRunDetailReport({
        ...report,
        estimatedOnly: true,
      });
      assert.match(
        estimated,
        /Finalized: 3\.2 PostPlus credits \(estimated settlement; actual usage unconfirmed\)/u,
      );
      const estimatedList = formatHostedRunsListReport({
        runs: [{ ...report, estimatedOnly: true }],
        count: 1,
        filters: { limit: 20, since: null, status: null },
      });
      assert.match(estimatedList, /3\.2 credits \(estimated settlement\)/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits machine-readable JSON on --json for every hosted read command (F coverage)', async () => {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Acme',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'cli-session-token',
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/hosted/balance')) {
        return new Response(
          JSON.stringify({
            accountId: 'account_1',
            accountType: 'team',
            accountName: 'Acme',
            availableCredits: 10,
            availableMillicredits: 10000,
            reservedMillicredits: 0,
            subscriptionStatus: 'active',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/hosted/runs/')) {
        return new Response(
          JSON.stringify({
            id: 'run_1',
            capability: 'media-generation',
            status: 'completed',
            finalizedMillicredits: 100,
            reservedMillicredits: 100,
            createdAt: '2026-07-02T10:00:00Z',
            updatedAt: '2026-07-02T10:05:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ count: 0, runs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    // Capture stdout for each --json invocation and assert it is valid JSON, so
    // every hosted read command is machine-readable (discover→inspect→execute).
    const captureJsonStdout = async (
      run: () => Promise<number>,
    ): Promise<unknown> => {
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      let stdoutText = '';
      process.stdout.write = ((chunk: unknown) => {
        stdoutText += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      try {
        const exitCode = await run();
        assert.equal(exitCode, 0);
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
      return JSON.parse(stdoutText);
    };

    try {
      const balance = await captureJsonStdout(() =>
        runBalanceCommand(['--json']),
      );
      assert.equal((balance as { accountId: string }).accountId, 'account_1');

      const runsList = await captureJsonStdout(() =>
        runRunsCommand(['list', '--json']),
      );
      assert.ok(Array.isArray((runsList as { runs: unknown[] }).runs));

      const runDetail = await captureJsonStdout(() =>
        runRunsCommand(['show', 'run_1', '--json']),
      );
      assert.equal((runDetail as { id: string }).id, 'run_1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('teaches the discover→inspect→execute loop in the media schema notes (F)', () => {
    const report = buildHostedRequestSchemaReport({ domain: 'media' });
    const notes = (report as { notes: string[] }).notes.join('\n');
    // discover: the schema lists selectable endpoints; inspect: --help / example;
    // execute + price: media <verb> and the no-charge estimate.
    assert.match(notes, /--help/u);
    assert.match(notes, /example\.command/u);
    assert.match(notes, /estimate/u);
    assert.ok(
      Array.isArray((report as { endpointKeys?: string[] }).endpointKeys),
    );
  });
});

describe('workflow commands', () => {
  const WORKFLOW_SESSION = {
    accountId: 'account_1',
    accountName: 'Acme',
    accountType: 'team' as const,
    apiBaseUrl: 'https://postplus.test',
    cliSessionToken: 'cli-session-token',
    sessionExpiresAt: null,
    userEmail: 'agent@example.com',
    userId: 'user_1',
  };

  type CapabilityCall = {
    url: string;
    method: string | undefined;
    body: Record<string, unknown>;
  };

  // Stub fetch to capture the single POSTed capability envelope and mimic the
  // /hosted/capability route, which wraps every verb result in { output }.
  function stubCapability(
    output: unknown,
    options: { status?: number; errorBody?: unknown } = {},
  ): { restore: () => void; calls: CapabilityCall[] } {
    const status = options.status ?? 200;
    const originalFetch = globalThis.fetch;
    const calls: CapabilityCall[] = [];
    globalThis.fetch = (async (
      input: unknown,
      init: RequestInit | undefined,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {},
      });
      const payload =
        status === 200
          ? {
              accountId: 'account_1',
              billing: { charged: false },
              charged: false,
              operationId: 'op',
              output,
              subscriptionStatus: 'active',
            }
          : (options.errorBody ?? {
              code: 'postplus_cli_hosted_capability_failed',
              error: 'The requested workflow does not exist for this account.',
              message:
                'The requested workflow does not exist for this account.',
            });
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
        status,
      });
    }) as typeof globalThis.fetch;
    return {
      calls,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  async function captureWorkflowStdout(
    run: () => Promise<number>,
  ): Promise<{ exitCode: number; stdout: string }> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const exitCode = await run();
      return { exitCode, stdout };
    } finally {
      process.stdout.write = originalWrite;
    }
  }

  async function captureWorkflowStreams(
    run: () => Promise<number>,
  ): Promise<{ exitCode: number; stderr: string }> {
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exitCode = await run();
      return { exitCode, stderr };
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  }

  it('create posts the workflow capability envelope and unwraps output', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({
      name: 'Glasses ad',
      url: '/home/workspace/workflow?w=wf-1',
      versionNumber: 1,
      workflowId: 'wf-1',
    });
    try {
      const { exitCode, stdout } = await captureWorkflowStdout(() =>
        runWorkflowCommand([
          'create',
          '--name',
          'Glasses ad',
          '--description',
          'UGC unboxing',
          '--template',
          'video_only',
        ]),
      );
      assert.equal(exitCode, 0);
      assert.equal(stub.calls.length, 1);
      assert.equal(
        stub.calls[0].url,
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      assert.equal(stub.calls[0].method, 'POST');
      const body = stub.calls[0].body;
      assert.equal(body.capability, 'workflow');
      assert.equal(body.operation, 'create');
      assert.equal(body.name, 'Glasses ad');
      // Flags map onto the server's exact field names — a rename to a field the
      // route's strictObject rejects would 400, so pin them here.
      assert.equal(body.description, 'UGC unboxing');
      assert.equal(body.templateId, 'video_only');
      assert.match(String(body.operationId), /^postplus-cli:workflow:create:/u);
      // The route wraps the verb result in { output }; the CLI unwraps it.
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(parsed.workflowId, 'wf-1');
    } finally {
      stub.restore();
    }
  });

  it('list carries search and a numeric limit', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({ workflows: [] });
    try {
      const { exitCode } = await captureWorkflowStdout(() =>
        runWorkflowCommand(['list', '--search', 'glasses', '--limit', '5']),
      );
      assert.equal(exitCode, 0);
      const body = stub.calls[0].body;
      assert.equal(body.operation, 'list');
      assert.equal(body.search, 'glasses');
      assert.equal(body.limit, 5);
    } finally {
      stub.restore();
    }
  });

  it('show and run-show pass their positional id', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({ workflow: {} });
    try {
      await captureWorkflowStdout(() => runWorkflowCommand(['show', 'wf-1']));
      await captureWorkflowStdout(() =>
        runWorkflowCommand(['run-show', 'run-9']),
      );
      assert.equal(stub.calls[0].body.operation, 'get');
      assert.equal(stub.calls[0].body.workflowId, 'wf-1');
      assert.equal(stub.calls[1].body.operation, 'runs-get');
      assert.equal(stub.calls[1].body.runId, 'run-9');
    } finally {
      stub.restore();
    }
  });

  it('runs lists across the account without an id, and scoped with one', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({ runs: [] });
    try {
      await captureWorkflowStdout(() => runWorkflowCommand(['runs']));
      await captureWorkflowStdout(() =>
        runWorkflowCommand(['runs', 'wf-1', '--limit', '3']),
      );
      assert.equal(stub.calls[0].body.operation, 'runs-list');
      assert.equal('workflowId' in stub.calls[0].body, false);
      assert.equal(stub.calls[1].body.workflowId, 'wf-1');
      assert.equal(stub.calls[1].body.limit, 3);
    } finally {
      stub.restore();
    }
  });

  it('propose and save read the --operations JSON array', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const dir = await mkdtemp(resolve(tmpdir(), 'postplus-workflow-ops-'));
    tempDirs.push(dir);
    const opsPath = resolve(dir, 'ops.json');
    await writeFile(
      opsPath,
      JSON.stringify([{ id: 'gen-1', kind: 'update_node', title: 'x' }]),
      'utf8',
    );
    const stub = stubCapability({ validation: { ok: true } });
    try {
      await captureWorkflowStdout(() =>
        runWorkflowCommand(['propose', 'wf-1', '--operations', opsPath]),
      );
      await captureWorkflowStdout(() =>
        runWorkflowCommand([
          'save',
          'wf-1',
          '--operations',
          opsPath,
          '--base-version',
          '2',
        ]),
      );
      assert.equal(stub.calls[0].body.operation, 'edit-propose');
      assert.deepEqual(stub.calls[0].body.operations, [
        { id: 'gen-1', kind: 'update_node', title: 'x' },
      ]);
      assert.equal(stub.calls[1].body.operation, 'version-save');
      assert.equal(stub.calls[1].body.baseVersionNumber, 2);
    } finally {
      stub.restore();
    }
  });

  it('quote passes the instance count', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({ reservedMillicredits: 40000 });
    try {
      await captureWorkflowStdout(() =>
        runWorkflowCommand(['quote', 'wf-1', '--instances', '2']),
      );
      assert.equal(stub.calls[0].body.operation, 'run-quote');
      assert.equal(stub.calls[0].body.instanceCount, 2);
    } finally {
      stub.restore();
    }
  });

  it('launch refuses without --confirm and never posts', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({ submissions: [] });
    try {
      await assert.rejects(
        () =>
          runWorkflowCommand([
            'launch',
            'wf-1',
            '--title',
            'Glasses ad',
            '--instances',
            '1',
            '--max-reserved-credits',
            '40',
          ]),
        (error: unknown) =>
          error instanceof Error && /Refusing to launch/u.test(error.message),
      );
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it('launch requires an acknowledged ceiling', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    await assert.rejects(
      () =>
        runWorkflowCommand([
          'launch',
          'wf-1',
          '--title',
          'Glasses ad',
          '--instances',
          '1',
          '--confirm',
        ]),
      (error: unknown) =>
        error instanceof Error &&
        /Missing required option --max-reserved-credits/u.test(error.message),
    );
  });

  it('launch with --confirm posts run-launch with the acknowledged ceiling', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    const stub = stubCapability({
      instanceCount: 1,
      reservedMillicredits: 40000,
      submissions: [{ hatchetRunId: 'h-1', runId: 'run-1' }],
    });
    try {
      const { exitCode } = await captureWorkflowStdout(() =>
        runWorkflowCommand([
          'launch',
          'wf-1',
          '--title',
          'Glasses ad',
          '--instances',
          '1',
          '--max-reserved-credits',
          '40',
          '--confirm',
        ]),
      );
      assert.equal(exitCode, 0);
      const body = stub.calls[0].body;
      assert.equal(body.operation, 'run-launch');
      assert.equal(body.workflowId, 'wf-1');
      assert.equal(body.workflowTitle, 'Glasses ad');
      assert.equal(body.instanceCount, 1);
      assert.equal(body.maxTotalReservedMillicredits, 40000);
    } finally {
      stub.restore();
    }
  });

  it('rejects unknown options and surfaces server product errors as exit 1', async () => {
    await setLocalSession(WORKFLOW_SESSION);
    await assert.rejects(
      () => runWorkflowCommand(['list', '--nope', 'x']),
      (error: unknown) =>
        error instanceof Error &&
        /Unknown option for workflow list/u.test(error.message),
    );

    const stub = stubCapability(null, { status: 404 });
    try {
      const { exitCode, stderr } = await captureWorkflowStreams(() =>
        runWorkflowCommand(['show', 'wf-missing']),
      );
      assert.equal(exitCode, 1);
      assert.ok(stderr.length > 0);
    } finally {
      stub.restore();
    }
  });

  it('help exits 0 and an unknown subcommand exits 1', async () => {
    const help = await captureWorkflowStdout(() =>
      runWorkflowCommand(['help']),
    );
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /postplus workflow launch/u);
    const bogus = await captureWorkflowStdout(() =>
      runWorkflowCommand(['bogus']),
    );
    assert.equal(bogus.exitCode, 1);
  });
});

describe('release packaging', () => {
  it('publishes every runtime build module emitted from src', async () => {
    const sourceEntries = await readdir(resolve(process.cwd(), 'src'), {
      withFileTypes: true,
    });
    const runtimeBuildFiles = sourceEntries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        if (!entry.name.endsWith('.ts')) return false;
        if (entry.name.endsWith('.test.ts')) return false;
        if (entry.name.endsWith('.spec.ts')) return false;
        return true;
      })
      .map((entry) => `build/${entry.name.replace(/\.ts$/, '.js')}`)
      .sort();

    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { files?: unknown };
    assert.ok(Array.isArray(packageJson.files));

    const packageFiles = new Set(
      packageJson.files.filter(
        (file): file is string => typeof file === 'string',
      ),
    );
    const missingFiles = runtimeBuildFiles.filter(
      (file) => !packageFiles.has(file),
    );

    assert.deepEqual(missingFiles, []);
  });
});

describe('studio commands', () => {
  it('documents bundled public Local Studio in CLI help', async () => {
    const { stdout: mainHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'help',
    ]);
    assert.match(
      mainHelp,
      /postplus studio init\|open\|status\s+Open bundled Local Studio/,
    );

    const { stdout: studioHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'help',
      'studio',
    ]);
    assert.match(studioHelp, /public local workspace/);
    assert.match(studioHelp, /bundled local dashboard/);
    assert.doesNotMatch(studioHelp, /POSTPLUS_STUDIO_RUNTIME_ROOT/);

    const { stdout: openHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'studio',
      'open',
      '--help',
    ]);
    assert.equal(openHelp, studioHelp);
  });

  it('opens Studio with the bundled public runtime', async () => {
    const studioWorkdir = await mkdtemp(
      resolve(tmpdir(), 'postplus-studio-open-'),
    );
    tempDirs.push(studioWorkdir);
    const entrypointUrl = pathToFileURL(
      resolve(process.cwd(), 'src/index.ts'),
    ).href;
    const script = [
      "process.chdir('/');",
      `process.argv = ["node", "postplus", "studio", "open", "--workdir", ${JSON.stringify(
        studioWorkdir,
      )}, "--no-browser", "--json"];`,
      `await import(${JSON.stringify(entrypointUrl)});`,
      'if (process.exitCode) process.exit(process.exitCode);',
    ].join('\n');

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
    ]);
    const parsed = JSON.parse(stdout) as {
      pid?: number;
      reused: boolean;
      studioRoot: string;
      url: string;
    };

    try {
      assert.equal(parsed.reused, false);
      assert.equal(parsed.studioRoot, resolveStudioRoot(studioWorkdir));
      assert.match(parsed.url, /^http:\/\/127\.0\.0\.1:\d+\/dashboard\/$/);

      const response = await fetch(
        `${parsed.url.replace(/\/dashboard\/$/u, '')}/api/project`,
      );
      assert.equal(response.ok, true);
      const snapshot = (await response.json()) as {
        project?: { name?: string };
        studioRoot?: string;
      };
      assert.equal(snapshot.studioRoot, parsed.studioRoot);
      assert.equal(snapshot.project?.name, 'PostPlus Studio');
    } finally {
      if (parsed.pid) {
        try {
          process.kill(parsed.pid);
        } catch {
          // The server can already be gone when the test process exits.
        }
      }
    }
  });

  it('prints Studio server help from the bundled runtime entrypoint', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/studio-server.ts',
      '--help',
    ]);

    assert.match(stdout, /node build\/studio-server\.js --studio-root/);
  });

  it('resolves the visible PostPlus Studio folder under a working directory', () => {
    assert.equal(
      resolveStudioRoot('/tmp/demo'),
      resolve('/tmp/demo/PostPlus Studio'),
    );
    assert.equal(
      resolveStudioRoot('/tmp/demo/PostPlus Studio'),
      resolve('/tmp/demo/PostPlus Studio'),
    );
  });
});

// ANTI-DRIFT PARITY: the bin path (runHostedDomainCommand / runMediaFileCommand
// reading `--request <file>` + disk auth) and the in-process hosted-lib path
// (runHostedRequest with injected requestJson + parameter auth) MUST produce a
// byte-identical hosted HTTP request — same URL, method, headers (authorization,
// x-postplus-skills-release-id, x-postplus-cli-version, x-postplus-client-*,
// x-postplus-skill-name), and JSON body — because they share one resolve+build+
// post core. If this ever fails, the grammar has forked; fix the refactor, never
// weaken the test. operationId is pinned via --hosted-operation-id so the only
// nondeterministic field is removed and the bodies are exactly comparable.
describe('hosted lib / bin request parity', () => {
  const PARITY_AUTH = {
    apiBaseUrl: 'https://postplus.test',
    cliSessionToken: 'cli-session-token',
  } as const;
  const PARITY_RELEASE_ID = 'release-parity-1';
  const PARITY_OP_ID = 'op-parity-fixed-id';

  type CapturedRequest = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };

  // Runs `run` against a fetch stub that records the single hosted request and
  // returns a fixed 200 payload, then restores fetch. The hosted lib path and the
  // bin path are each driven through this so their captured requests can be
  // compared field by field.
  async function captureSingleHostedRequest(
    run: () => Promise<unknown>,
  ): Promise<CapturedRequest> {
    const originalFetch = globalThis.fetch;
    let captured: CapturedRequest | null = null;
    globalThis.fetch = async (input, init) => {
      const headerEntries: Record<string, string> = {};
      const rawHeaders = init?.headers as Record<string, string> | undefined;
      if (rawHeaders) {
        for (const [key, value] of Object.entries(rawHeaders)) {
          headerEntries[key.toLowerCase()] = value;
        }
      }
      captured = {
        url: String(input),
        method: String(init?.method),
        headers: headerEntries,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      return new Response(
        JSON.stringify({ ok: true, parity: true, status: 'completed' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
    if (!captured) {
      throw new Error('Expected exactly one hosted fetch to be captured.');
    }
    return captured;
  }

  // Seeds the disk session + managed-skills release id the BIN path reads, so its
  // auth/releaseId header inputs match what the lib path receives as parameters.
  async function seedBinDiskState(): Promise<void> {
    await setLocalSession({
      accountId: 'account_1',
      accountName: 'Account',
      apiBaseUrl: PARITY_AUTH.apiBaseUrl,
      cliSessionToken: PARITY_AUTH.cliSessionToken,
      sessionExpiresAt: null,
      userEmail: 'agent@example.com',
      userId: 'user_1',
    });
    await writeLocalConfig({
      ...(await readLocalConfig()),
      apiBaseUrl: PARITY_AUTH.apiBaseUrl,
      cliSessionToken: PARITY_AUTH.cliSessionToken,
    });
    await writeManagedSkillBaseline({ releaseId: PARITY_RELEASE_ID, skillNames: [] });
  }

  type ParityCase = {
    name: string;
    domain: 'media' | 'research' | 'publish' | 'media-file';
    // Tokens AFTER the domain, shared by both paths EXCEPT the request source.
    baseArgs: string[];
    // request-json surfaces: the injected object (lib) / written file (bin).
    requestJson?: Record<string, unknown> | unknown[];
  };

  const CASES: ParityCase[] = [
    {
      name: 'media create (flags surface) image-gpt-image-2-text',
      domain: 'media',
      baseArgs: [
        'create',
        'image-gpt-image-2-text',
        '--prompt',
        'a hero shot',
        '--resolution',
        '4K',
        '--quality',
        'High',
        '--hosted-operation-id',
        PARITY_OP_ID,
      ],
    },
    {
      name: 'media create (flags surface) video-seedance-2-text',
      domain: 'media',
      baseArgs: [
        'create',
        'video-seedance-2-text',
        '--prompt',
        'a blue sticky note slides across a white desk',
        '--resolution',
        '720p',
        '--duration',
        '5',
        '--aspect-ratio',
        '9:16',
        '--hosted-operation-id',
        PARITY_OP_ID,
      ],
    },
    {
      name: 'research run google-trends-fast',
      domain: 'research',
      baseArgs: [
        'run',
        'google-trends-fast',
        '--query',
        'portable blender',
        '--country',
        'US',
        '--time-range',
        'today 12-m',
        '--hosted-operation-id',
        PARITY_OP_ID,
      ],
    },
    {
      name: 'publish create-post',
      domain: 'publish',
      baseArgs: ['create-post', '--hosted-operation-id', PARITY_OP_ID],
      requestJson: {
        channelId: 'channel_1',
        content: 'hello world',
      },
    },
  ];

  for (const parityCase of CASES) {
    it(`bin and lib emit byte-identical requests: ${parityCase.name}`, async () => {
      // BIN path: write the request-json file (when the surface needs one), seed
      // disk auth + release id, dispatch through the bin entry function.
      await seedBinDiskState();
      const binArgs = [...parityCase.baseArgs];
      if (parityCase.requestJson !== undefined) {
        const requestDir = await mkdtemp(
          resolve(tmpdir(), 'postplus-cli-parity-'),
        );
        tempDirs.push(requestDir);
        const requestPath = resolve(requestDir, 'request.json');
        await writeFile(requestPath, JSON.stringify(parityCase.requestJson));
        binArgs.push('--request', requestPath);
      }
      if (parityCase.domain === 'research') {
        const outputDir = await mkdtemp(
          resolve(tmpdir(), 'postplus-cli-parity-output-'),
        );
        tempDirs.push(outputDir);
        binArgs.push('--output', resolve(outputDir, 'result.json'));
      }

      const binRequest = await captureSingleHostedRequest(() =>
        parityCase.domain === 'media-file'
          ? runMediaFileCommand(binArgs)
          : runHostedDomainCommand(parityCase.domain, binArgs),
      );

      // LIB path: same args (minus the --request file), inject requestJson +
      // parameter auth + parameter skillsReleaseId. No disk read, no file.
      const libRequest = await captureSingleHostedRequest(() =>
        runHostedRequest({
          domain: parityCase.domain,
          args: parityCase.baseArgs,
          ...(parityCase.requestJson !== undefined
            ? { requestJson: parityCase.requestJson }
            : {}),
          auth: PARITY_AUTH,
          skillsReleaseId: PARITY_RELEASE_ID,
        }),
      );

      // URL + method must match exactly.
      assert.equal(libRequest.url, binRequest.url);
      assert.equal(libRequest.method, binRequest.method);

      // Body must be byte-identical (operationId pinned, so fully deterministic).
      assert.deepEqual(libRequest.body, binRequest.body);

      // Every compatibility + auth header must match exactly, including the
      // release id stamped from disk (bin) vs parameter (lib).
      for (const headerName of [
        'authorization',
        POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.cliVersion,
        POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.contractVersion,
        POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.runtime,
        POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillsReleaseId,
        POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillName,
        'content-type',
        'accept',
      ]) {
        assert.equal(
          libRequest.headers[headerName],
          binRequest.headers[headerName],
          `header ${headerName} must match between bin and lib`,
        );
      }

      // Positive guards: the release id header is actually present (not both
      // undefined), and the authorization carries the session token.
      assert.equal(
        libRequest.headers[
          POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillsReleaseId
        ],
        PARITY_RELEASE_ID,
      );
      assert.equal(
        libRequest.headers.authorization,
        `Bearer ${PARITY_AUTH.cliSessionToken}`,
      );
      // operationId pinned identically on both bodies.
      assert.equal(
        (libRequest.body as Record<string, unknown>).operationId,
        PARITY_OP_ID,
      );
    });
  }

  it('returns the parsed hosted payload in-process (no exit code, no file)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ output: { data: { id: 'run_parity' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const payload = await runHostedRequest({
        domain: 'media',
        args: [
          'create',
          'video-seedance-2-text',
          '--prompt',
          'parity payload',
          '--hosted-operation-id',
          PARITY_OP_ID,
        ],
        auth: PARITY_AUTH,
        skillsReleaseId: PARITY_RELEASE_ID,
      });
      // The lib returns the parsed payload OBJECT — not a number exit code and
      // not a stdout string.
      assert.deepEqual(payload, { output: { data: { id: 'run_parity' } } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns the media schema catalog object in-process (not exit code 0)', async () => {
    // The in-process / context path must RESOLVE to the structured catalog so the
    // model receives it as the call result — NOT writeJson + return 0, which sends
    // the catalog to process stdout and hands the model the number 0.
    const result = await runHostedDomainCommand('media', ['schema', '--json'], {
      auth: PARITY_AUTH,
      skillsReleaseId: PARITY_RELEASE_ID,
    });
    assert.notEqual(result, 0);
    const report = result as Record<string, unknown>;
    assert.equal(report.domain, 'media');
    const endpoints = report.endpoints as Array<{ endpointKey: string }>;
    assert.ok(Array.isArray(endpoints) && endpoints.length > 0);
    const endpointKeys = endpoints.map((endpoint) => endpoint.endpointKey);
    assert.ok(endpointKeys.includes('image-higgsfield-soul-text'));
    assert.ok(endpointKeys.includes('video-seedance-2-mini-text'));

    // BIN-path parity: with no context the catalog goes to stdout and the call
    // returns the 0 exit code, exactly as the human CLI expects.
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let binResult: number | unknown;
    try {
      binResult = await runHostedDomainCommand('media', ['schema', '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(binResult, 0);
    const binReport = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(binReport.domain, 'media');
    assert.ok(
      (binReport.endpoints as Array<{ endpointKey: string }>).some(
        (endpoint) => endpoint.endpointKey === 'image-higgsfield-soul-text',
      ),
    );
  });

  it('throws the structured product error verbatim in-process', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 'postplus_cli_hosted_provider_timeout',
          error: 'Media generation timed out while calling the provider.',
          layer: 'hosted-capability',
          operationId: 'op-from-web-123',
          userMessageRule: 'retry_later',
        }),
        { status: 504, headers: { 'content-type': 'application/json' } },
      );
    try {
      await assert.rejects(
        () =>
          runHostedRequest({
            domain: 'media',
            args: [
              'create',
              'video-seedance-2-text',
              '--prompt',
              'parity error',
              '--hosted-operation-id',
              PARITY_OP_ID,
            ],
            auth: PARITY_AUTH,
            skillsReleaseId: PARITY_RELEASE_ID,
          }),
        (error: unknown) =>
          error instanceof Error &&
          /Media generation timed out/u.test(error.message) &&
          /code=postplus_cli_hosted_provider_timeout/u.test(error.message) &&
          /operationId=op-from-web-123/u.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('hosted media transfer', () => {
  it('resumes a TUS upload from the server-confirmed offset without retransmitting accepted bytes', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-tus-resume-'));
    tempDirs.push(uploadDir);
    const inputPath = resolve(uploadDir, 'clip.mp4');
    await writeFile(inputPath, Buffer.from('0123456789'));
    const fingerprint = await createMediaFileFingerprint(inputPath);
    let remoteOffset = 0;
    let sessionCreates = 0;
    let failFirstPatch = true;
    const patchOffsets: number[] = [];

    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://storage.test/storage/v1/upload/resumable') {
        assert.equal(init?.method, 'POST');
        sessionCreates += 1;
        return new Response(null, {
          headers: { location: '/upload/session-1' },
          status: 201,
        });
      }
      if (url !== 'https://storage.test/upload/session-1') {
        throw new Error(`Unexpected TUS URL: ${url}`);
      }
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'upload-length': String(fingerprint.sizeBytes),
            'upload-offset': String(remoteOffset),
          },
          status: 200,
        });
      }
      assert.equal(init?.method, 'PATCH');
      const offset = Number(
        (init?.headers as Record<string, string>)['upload-offset'],
      );
      patchOffsets.push(offset);
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as NodeJS.ReadableStream) {
        chunks.push(Buffer.from(chunk));
      }
      remoteOffset = offset + Buffer.concat(chunks).byteLength;
      if (failFirstPatch) {
        failFirstPatch = false;
        throw new TypeError('simulated disconnect after server accepted bytes');
      }
      return new Response(null, {
        headers: { 'upload-offset': String(remoteOffset) },
        status: 204,
      });
    }) as typeof fetch;
    const signedUpload = {
      chunkSizeBytes: 4,
      expiresInSeconds: 3_600,
      metadata: {
        bucketName: 'uploads',
        contentType: 'video/mp4',
        objectName: 'object.mp4',
      },
      method: 'TUS' as const,
      requiredHeaders: { 'x-signature': 'secret-upload-token' },
      url: 'https://storage.test/storage/v1/upload/resumable',
    };

    await assert.rejects(
      () =>
        uploadHostedMediaFile({
          mediaReference: 'postplus-media://uploads/object.mp4',
          owner: 'fixture-account',
          absolutePath: inputPath,
          fingerprint,
          operationId: 'operation-1',
          options: { fetchFn, maxAttempts: 1 },
          signedUpload,
        }),
      (error: unknown) =>
        error instanceof HostedMediaTransferError &&
        error.retryable &&
        error.resumeAvailable &&
        error.transferredBytes === 0,
    );

    await uploadHostedMediaFile({
          mediaReference: 'postplus-media://uploads/object.mp4',
          owner: 'fixture-account',
      absolutePath: inputPath,
      fingerprint,
      operationId: 'operation-1',
      options: { fetchFn },
      signedUpload,
    });

    assert.equal(sessionCreates, 1);
    assert.deepEqual(patchOffsets, [0, 4, 8]);
    const checkpoint = JSON.parse(
      await readFile(
        resolve(
          process.env.POSTPLUS_CONFIG_DIR!,
          'media-transfers',
          createHash('sha256').update('operation-1').digest('hex') + '.json',
        ),
        'utf8',
      ),
    ) as { entries: Record<string, unknown> };
    assert.deepEqual(checkpoint.entries, {});
  });

  it('classifies a stalled TUS chunk without exposing the signed URL or token', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-tus-stall-'));
    tempDirs.push(uploadDir);
    const inputPath = resolve(uploadDir, 'clip.mp4');
    await writeFile(inputPath, Buffer.from('stall'));
    const fingerprint = await createMediaFileFingerprint(inputPath);
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/upload/resumable')) {
        return new Response(null, {
          headers: { location: 'https://storage.test/upload/stalled' },
          status: 201,
        });
      }
      if (init?.method === 'PATCH') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('request aborted'));
          });
        });
      }
      throw new Error(`Unexpected TUS request: ${String(input)}`);
    }) as typeof fetch;

    await assert.rejects(
      () =>
        uploadHostedMediaFile({
          mediaReference: 'postplus-media://uploads/object.mp4',
          owner: 'fixture-account',
          absolutePath: inputPath,
          fingerprint,
          operationId: 'operation-stall',
          options: { fetchFn, idleTimeoutMs: 10, maxAttempts: 1 },
          signedUpload: {
            chunkSizeBytes: 6 * 1024 * 1024,
            expiresInSeconds: 3_600,
            metadata: {
              bucketName: 'uploads',
              contentType: 'video/mp4',
              objectName: 'stalled.mp4',
            },
            method: 'TUS',
            requiredHeaders: { 'x-signature': 'secret-upload-token' },
            url: 'https://storage.test/storage/v1/upload/resumable',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof HostedMediaTransferError);
        assert.equal(error.code, 'idle_timeout');
        assert.equal(error.stage, 'transferring');
        assert.equal(error.targetHost, 'storage.test');
        assert.equal(error.resumeAvailable, true);
        assert.doesNotMatch(error.message, /secret-upload-token/u);
        assert.doesNotMatch(error.message, /\/upload\/stalled/u);
        return true;
      },
    );
  });

  it('rejects resume when the source size or mtime changed', async () => {
    const uploadDir = await mkdtemp(resolve(tmpdir(), 'postplus-tus-change-'));
    tempDirs.push(uploadDir);
    const inputPath = resolve(uploadDir, 'clip.mp4');
    await writeFile(inputPath, Buffer.from('before'));
    const fingerprint = await createMediaFileFingerprint(inputPath);
    await writeFile(inputPath, Buffer.from('after-content'));
    const current = await stat(inputPath);
    assert.notEqual(current.size, fingerprint.sizeBytes);

    await assert.rejects(
      () =>
        uploadHostedMediaFile({
          mediaReference: 'postplus-media://uploads/object.mp4',
          owner: 'fixture-account',
          absolutePath: inputPath,
          fingerprint,
          operationId: 'operation-changed',
          signedUpload: {
            chunkSizeBytes: 6 * 1024 * 1024,
            expiresInSeconds: 3_600,
            metadata: {},
            method: 'TUS',
            requiredHeaders: {},
            url: 'https://storage.test/storage/v1/upload/resumable',
          },
        }),
      (error: unknown) =>
        error instanceof HostedMediaTransferError &&
        error.code === 'integrity_mismatch' &&
        !error.resumeAvailable,
    );
  });
});




  it('media-file download resumes only with a matching range validator', async () => {
    const downloadDir = await mkdtemp(
      resolve(tmpdir(), 'postplus-cli-download-resume-'),
    );
    tempDirs.push(downloadDir);
    const mediaPath = resolve(downloadDir, 'clip.bin');
    const mediaBytes = Buffer.from('0123456789');
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    const seenRanges: Array<{ ifRange: string | null; range: string | null }> =
      [];
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);
      seenRanges.push({
        ifRange: headers.get('if-range'),
        range: headers.get('range'),
      });
      if (requestCount === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mediaBytes.subarray(0, 4));
            setTimeout(
              () =>
                controller.error(new Error('simulated interrupted download')),
              5,
            );
          },
        });
        return new Response(body, {
          headers: {
            'accept-ranges': 'bytes',
            'content-length': String(mediaBytes.length),
            etag: '"media-v1"',
          },
          status: 200,
        });
      }
      return new Response(mediaBytes.subarray(4), {
        headers: {
          'content-range': `bytes 4-9/${mediaBytes.length}`,
          etag: '"media-v1"',
        },
        status: 206,
      });
    };

    try {
      await assert.rejects(
        () =>
          runMediaFileCommand([
            'download',
            '--url',
            'https://download.test/resumable-clip',
            '--hosted-operation-id',
            'download-resume-operation',
            '--output-file',
            mediaPath,
          ]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /resumeAvailable=true/u);
          assert.doesNotMatch(error.message, /resumable-clip/u);
          return true;
        },
      );

      const result = await runMediaFileCommand([
        'download',
        '--url',
        'https://download.test/resumable-clip',
        '--hosted-operation-id',
        'download-resume-operation',
        '--output-file',
        mediaPath,
      ]);
      assert.equal(result, 0);
      assert.deepEqual(await readFile(mediaPath), mediaBytes);
      assert.deepEqual(seenRanges, [
        { ifRange: null, range: null },
        { ifRange: '"media-v1"', range: 'bytes=4-' },
      ]);
      assert.deepEqual(await readdir(downloadDir), ['clip.bin']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
