import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { type ReadStream, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  CLI_AUTH_LOGIN_POLL_BUDGET_MS,
  openCloudAuthVerificationUrlIfConfigured,
  pollCloudAuthLogin,
  startCloudAuthLogin,
} from './auth-login.js';
import {
  formatAuthValidateReport,
  validateRemoteAuth,
} from './auth-validate.js';
import { formatAuthStatusReport, generateAuthStatusReport } from './auth.js';
import {
  POSTPLUS_CLI_UPDATE_COMMAND,
  POSTPLUS_CLIENT_COMPATIBILITY_HEADERS,
} from './client-compatibility.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import {
  fetchHostedBalance,
  fetchHostedRunDetail,
  fetchHostedRunsList,
  formatHostedBalanceReport,
  formatHostedRunDetailReport,
  formatHostedRunsListReport,
  parseRunsListOptions,
  buildRunsListPath,
  runBalanceCommand,
  runRunsCommand,
} from './hosted-account-commands.js';
import {
  runHostedDomainCommand,
  runMediaFileCommand,
} from './hosted-domain-commands.js';
import { buildHostedRequestSchemaReport } from './hosted-request-schemas.js';
import { runHostedRequest } from './hosted-lib.js';
import { generateLocalDependencyReport } from './local-dependencies.js';
import {
  readLocalConfig,
  setLocalSession,
  writeLocalConfig,
  writeManagedSkillBaseline,
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
  generateStatusReport,
  generateStatusReportWithDependencies,
} from './status.js';
import { resolveStudioRoot } from './studio.js';
import {
  generateUpdateStatusReport,
  runCliSelfUpdateIfOutdated,
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
    collectionKeys: [],
    endpointKeys: [],
    hostedCapabilities: [],
    localDependencies: [],
    modelKeys: [],
    sourceKeys: [],
  };
}

function isPublicCatalogUrl(url: string): boolean {
  return url.includes('PostPlusAI/postplus-skills/main/skills/catalog.json');
}

function createPublicCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
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

function createVideoAnalysisCatalogResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'video-analysis',
          path: 'skills/video-analysis/SKILL.md',
          requirements: {
            hostedCapabilities: ['media-file', 'video-analysis'],
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
            hostedCapabilities: ['media-generation'],
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
      schemaVersion: 1,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'social-media-publisher',
          path: 'skills/50-publishing/social-media-publisher/SKILL.md',
          requirements: {
            accountConnections: ['social-publishing-workspace'],
            hostedCapabilities: ['social-publishing'],
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
          checks: [
            {
              id: 'provider_configuration',
              label: 'Provider configuration',
              ok: false,
              required: true,
            },
          ],
          id: 'media-file:upload',
          label: 'Media file: upload',
          mediaFileOperation: 'upload',
          ok: false,
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
      schemaVersion: 1,
      releaseId: 'catalog-1',
      source: 'PostPlusAI/postplus-skills',
      skills: [
        {
          name: 'youtube-research',
          path: 'skills/20-research/youtube-research/SKILL.md',
          requirements: {
            collectionKeys: [
              'youtube-channel-summary',
              'youtube-comments',
              'youtube-video-download',
            ],
            hostedCapabilities: [
              'hosted-collection',
              'public-content-collection',
              'public-content-discovery',
            ],
            sourceKeys: ['youtube-videos'],
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

beforeEach(async () => {
  process.env = { ...originalEnv };
  const configDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-test-'));
  const stateDir = await mkdtemp(resolve(tmpdir(), 'postplus-skills-state-'));
  tempDirs.push(configDir);
  tempDirs.push(stateDir);
  process.env.POSTPLUS_CONFIG_DIR = configDir;
  process.env.XDG_STATE_HOME = stateDir;
});

after(async () => {
  process.env = originalEnv;
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
          '2',
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
      assert.equal(status.doctor.schemaVersion, 2);
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

  it('repairs stale managed skill metadata before hosted readiness during status', async () => {
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

      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.1.35' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
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
      const status = await generateStatusReport();

      assert.equal(status.ok, true);
      assert.equal(status.skills.managedSkillsReleaseId, 'catalog-2');
      assert.deepEqual(status.skills.scopes, ['global', 'project']);
      assert.equal(status.updates.skills.currentReleaseId, 'catalog-2');
      assert.equal(status.updates.skills.latestReleaseId, 'catalog-2');
      assert.equal(status.updates.skills.updateAvailable, false);
      assert.deepEqual(hostedSkillsReleaseIds, ['catalog-2']);
      assert.equal(
        (await readLocalConfig())?.managedSkills?.releaseId,
        'catalog-2',
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
            updateCommand: 'npm install -g @postplus/cli@latest',
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
      assert.match(formatted, /npm install -g @postplus\/cli/);
      assert.match(formatted, /postplus update/);
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
              upgrade: {
                cli: {
                  command: 'npm install -g @postplus/cli@latest',
                },
                restartAgentSession: true,
                skills: {
                  command: 'postplus update',
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

      assert.equal(status.ok, false);
      assert.match(
        formatted,
        /agent, run both update commands now before retrying/i,
      );
      assert.match(formatted, /npm install -g @postplus\/cli/);
      assert.match(formatted, /postplus update/);
      assert.match(formatted, /restart your agent session/i);
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

      assert.equal(status.ok, false);
      assert.match(formatted, /PostPlus Cloud is updating/);
      assert.doesNotMatch(formatted, /npm install -g @postplus\/cli/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps status usable when only task-specific local dependencies are missing', async () => {
    const status = await generateStatusReportWithDependencies({
      generateDoctor: async () => ({
        schemaVersion: 1,
        ok: false,
        requiredOk: true,
        checks: [
          {
            id: 'local_dependencies',
            label: 'Task-specific local media dependencies',
            status: 'fail',
            severity: 'task_specific',
            detail: 'Missing 1/2: ffmpeg for frame-extraction',
            fix: 'Run the affected PostPlus skill in a local agent.',
            metadata: {
              bootstrapRule: 'postplus-shared',
              missingDependencies: [
                {
                  dependency: 'ffmpeg',
                  detail: 'not found',
                  skillIds: ['frame-extraction'],
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

      assert.equal(report.schemaVersion, 2);
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
      const report = await generateDoctorReport({ skillId: 'video-analysis' });
      const formatted = formatDoctorReport(report);

      assert.equal(report.skillId, 'video-analysis');
      assert.equal(report.ok, true);
      assert.equal(report.requiredOk, true);
      assert.match(formatted, /Hosted capabilities for video-analysis/);
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

      assert.equal(report.schemaVersion, 2);
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
    assert.doesNotMatch(stdout, /Waiting for browser sign-in/u);
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

  it('opens the cloud sign-in URL only when an opener command is configured', () => {
    const originalCommand = process.env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND;

    try {
      delete process.env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND;
      assert.equal(
        openCloudAuthVerificationUrlIfConfigured(
          'https://postplus.example.com/auth/cli-login',
        ),
        false,
      );

      process.env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND = 'true';
      assert.equal(
        openCloudAuthVerificationUrlIfConfigured(
          'https://postplus.example.com/auth/cli-login',
        ),
        true,
      );
    } finally {
      if (originalCommand === undefined) {
        delete process.env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND;
      } else {
        process.env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND = originalCommand;
      }
    }
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
          schemaVersion: 1,
          releaseId: 'catalog-1',
          source: 'PostPlusAI/postplus-skills',
          skills: [
            {
              name: 'demo-skill',
              path: 'skills/demo-skill/SKILL.md',
              requirements: {
                collectionKeys: ['instagram-posts'],
                endpointKeys: ['image-demo'],
                hostedCapabilities: ['hosted-collection'],
                localDependencies: ['ffmpeg', 'python3:yt_dlp'],
                modelKeys: ['video-analysis'],
                sourceKeys: ['facebook-post-by-url'],
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
      assert.equal(catalog.installCommand, POSTPLUS_SKILLS_INSTALL_COMMAND);
      assert.deepEqual(catalog.skills, [
        {
          localDependencies: ['ffmpeg', 'python3:yt_dlp'],
          requirements: {
            ...createEmptySkillRequirements(),
            collectionKeys: ['instagram-posts'],
            endpointKeys: ['image-demo'],
            hostedCapabilities: ['hosted-collection'],
            localDependencies: ['ffmpeg', 'python3:yt_dlp'],
            modelKeys: ['video-analysis'],
            sourceKeys: ['facebook-post-by-url'],
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
          schemaVersion: 1,
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
          schemaVersion: 1,
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
  it('self-updates the CLI before any skills catalog read when npm latest is newer', async () => {
    const calls: string[][] = [];
    const output: string[] = [];
    const result = await runCliSelfUpdateIfOutdated({
      fetchFn: async (input) => {
        const url = String(input);

        assert.match(url, /registry\.npmjs\.org/);

        return new Response(JSON.stringify({ version: NEXT_CLI_VERSION }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      runInteractiveCommand: async (command, args) => {
        calls.push([command, ...args]);
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
    assert.deepEqual(calls, [['npm', 'install', '-g', '@postplus/cli@latest']]);
    assert.match(output.join(''), /Re-run `postplus update`/);
  });

  it('continues without npm install when the CLI is already latest', async () => {
    const calls: string[][] = [];
    const result = await runCliSelfUpdateIfOutdated({
      fetchFn: async () =>
        new Response(JSON.stringify({ version: '0.1.32' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
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

      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.1.18' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
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
      const report = await generateUpdateStatusReport({ force: true });

      assert.equal(report.skills.currentReleaseId, 'catalog-1');
      assert.equal(report.skills.latestReleaseId, 'catalog-2');
      assert.equal(report.skills.updateAvailable, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes status update state from remote after skills verify advances the baseline', async () => {
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

      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.1.32' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (isPublicCatalogUrl(url)) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
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
      await generateUpdateStatusReport({ force: true });
      catalogReleaseId = 'catalog-2';

      const verify = await runPostPlusSkillVerify({
        runCommand: listInstalled,
      });
      const status = await generateStatusReportWithDependencies({
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
          schemaVersion: 1,
          ok: true,
          requiredOk: true,
          checks: [],
        }),
        generateSkillStatus: () =>
          generateSkillInstallStatusReport({
            runCommand: listInstalled,
          }),
      });

      assert.equal(verify.baselineUpdated, true);
      assert.equal(verify.verifiedSkillsReleaseId, 'catalog-2');
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
    assert.equal(notice.costMillicredits, 288_000);
    assert.equal(notice.ceilingMillicredits, 300_000);

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
        assert.equal(error.costMillicredits, 288_000);
        assert.equal(error.ceilingMillicredits, 100_000);
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
      '--agent',
      ...POSTPLUS_SKILLS_AGENT_TARGETS,
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
      [
        '-y',
        'skills',
        'remove',
        'a',
        'b',
        '--agent',
        ...POSTPLUS_SKILLS_AGENT_TARGETS,
        '--yes',
      ],
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
          schemaVersion: 1,
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
      assert.deepEqual(report.missingSkills, ['missing-skill']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('lists project and global skills sequentially to avoid npx cache races', async () => {
    const originalFetch = globalThis.fetch;
    let activeListCalls = 0;
    const calls: string[][] = [];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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

      assert.equal(report.ok, true);
      assert.deepEqual(calls, [
        ['-y', 'skills', 'list', '--json'],
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
          schemaVersion: 1,
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
          schemaVersion: 1,
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
      await writeManagedSkillBaseline({
        releaseId: 'catalog-1',
        skillNames: ['demo-skill', 'retired-skill'],
      });
      const exitCode = await runPostPlusSkillUpdate({
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          return 0;
        },
      });
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length * 2);
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
        buildPostPlusSkillUninstallArgs(
          ['retired-skill'],
          'global',
          'claude-code',
        ),
      );
      assert.deepEqual(config?.managedSkills?.skillNames, [
        'demo-skill',
        'new-skill',
      ]);
      assert.equal(config?.managedSkills?.releaseId, 'catalog-2');
      assert.equal(config?.cliVersion, CURRENT_CLI_VERSION);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates current skills and removes retired PostPlus skills tracked by the installer lock', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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
      await writeGlobalSkillsInstallerLock({
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
      });

      const exitCode = await runPostPlusSkillUpdate({
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          return 0;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length * 2);
      assert.deepEqual(
        calls[POSTPLUS_SKILLS_AGENT_TARGETS.length],
        buildPostPlusSkillUninstallArgs(
          ['retired-skill'],
          'global',
          'claude-code',
        ),
      );
      assert.doesNotMatch(calls.flat().join(' '), /local-user-skill/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates current-directory public skills when requested', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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

  it('verifies installed public skills before recording the managed baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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
      assert.equal(report.baselineUpdated, true);
      assert.equal(report.previousManagedSkillsReleaseId, null);
      assert.equal(report.verifiedSkillsReleaseId, 'catalog-2');
      assert.deepEqual(calls, [
        ['-y', 'skills', 'list', '--json'],
        ['-y', 'skills', 'list', '--json', '--global'],
      ]);
      assert.deepEqual(config?.managedSkills?.skillNames, [
        'demo-skill',
        'new-skill',
      ]);
      assert.equal(config?.managedSkills?.releaseId, 'catalog-2');
      assert.match(formatSkillBaselineVerifyReport(report), /postplus status/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports retired installed PostPlus skills from the installer lock after the baseline was advanced', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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
      assert.equal(config?.managedSkills?.releaseId, 'catalog-2');
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
          schemaVersion: 1,
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
          schemaVersion: 1,
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
      assert.equal(config?.managedSkills?.releaseId, 'catalog-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uninstalls current and retired managed skills before clearing the baseline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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
        runInteractiveCommand: async (_command, args) => {
          calls.push(args);
          return 0;
        },
      });
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUninstallArgs(
          ['demo-skill', 'retired-skill'],
          'global',
          'claude-code',
        ),
      );
      assert.equal(config?.managedSkills, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uninstalls current-directory public skills when requested', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
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
          runInteractiveCommand: async (_command, args) => {
            calls.push(args);
            return 0;
          },
        },
        { scope: 'current-directory' },
      );
      const config = await readLocalConfig();

      assert.equal(exitCode, 0);
      assert.equal(calls.length, POSTPLUS_SKILLS_AGENT_TARGETS.length);
      assert.deepEqual(
        calls[0],
        buildPostPlusSkillUninstallArgs(
          ['demo-skill', 'retired-skill'],
          'current-directory',
          'claude-code',
        ),
      );
      assert.equal(config?.managedSkills, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not provide postplus install as a functional installer', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'install',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /for agent in claude-code codex cursor github-copilot windsurf trae trae-cn openclaw hermes-agent; do npx -y skills add PostPlusAI\/postplus-skills --global --full-depth --skill '\*' --agent "\$agent" --yes; done/,
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
    const { stdout: researchHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'help',
    ]);
    assert.match(researchHelp, /postplus research collect/u);
    assert.match(researchHelp, /postplus research scrape/u);
    assert.match(researchHelp, /postplus research schema/u);

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

  it('prints manifest-driven public hosted request schemas without requiring auth', async () => {
    const { stdout: researchStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'schema',
      '--collection-key',
      'youtube-channel-summary',
      '--json',
    ]);
    const researchReport = JSON.parse(researchStdout) as Record<
      string,
      unknown
    >;
    assert.equal(
      researchReport.selectedCollectionKey,
      'youtube-channel-summary',
    );
    // The full enum sets of selectable targets come from the manifest, not a
    // hand-maintained catalog of example payloads.
    assert.ok(
      (researchReport.collectionKeys as string[]).includes(
        'youtube-channel-summary',
      ),
    );
    assert.ok(
      (researchReport.sourceKeys as string[]).includes('youtube-videos'),
    );
    // Research collection/scrape input is opaque JSON the agent authors, so the
    // report describes input shapes rather than fabricated example payloads.
    assert.equal(Object.hasOwn(researchReport, 'examples'), false);
    const researchSchemaIds = (
      researchReport.schemas as Array<{ id: string }>
    ).map((schema) => schema.id);
    assert.ok(researchSchemaIds.includes('research.collection-input'));
    assert.ok(
      researchSchemaIds.includes('public-content-collection.scrape-input'),
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

  it('rejects unknown hosted research schema collection keys', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        'research',
        'schema',
        '--collection-key',
        'instagram-missing-provider',
        '--json',
      ]),
      (error) => {
        const execError = error as Error & {
          stderr?: string;
        };

        assert.match(
          execError.stderr ?? '',
          /Unknown research collection instagram-missing-provider/u,
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
    assert.match(stdout, /--audio {2}\[media-url; required\]/u);
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

  it('prints per-target --help for opaque research, video-analysis, and publish surfaces', async () => {
    const { stdout: collectHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'collect',
      'tiktok-videos',
      '--help',
    ]);
    assert.match(collectHelp, /research collect tiktok-videos/u);
    assert.match(collectHelp, /Capability: hosted-collection/u);
    assert.match(collectHelp, /a provider-shaped JSON object of input/u);

    const { stdout: scrapeHelp } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'research',
      'scrape',
      'facebook-profile-posts',
      '--help',
    ]);
    assert.match(scrapeHelp, /Capability: public-content-collection/u);
    assert.match(
      scrapeHelp,
      /a non-empty JSON array of provider-shaped scrape records/u,
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
    assert.match(analyzeHelp, /opaque Gemini request payload/u);

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

  it('posts the manifest-driven research collect verb to /hosted/collection', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const outputPath = resolve(requestDir, 'result.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        keyword: 'portable blender',
        geo: 'US',
        timeframe: 'today 12-m',
        enableTrendingSearches: false,
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
    let postedUrl: string | null = null;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      postedUrl = String(input);
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ status: 'completed', payload: { itemCount: 1 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const result = await runHostedDomainCommand('research', [
        'collect',
        'google-trends-fast',
        '--request',
        requestPath,
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/collection',
      );
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.collectionKey, 'google-trends-fast');
      assert.equal(body.skillName, 'google-trends-research');
      assert.deepEqual(body.input, {
        keyword: 'portable blender',
        geo: 'US',
        timeframe: 'today 12-m',
        enableTrendingSearches: false,
      });
      assert.match(
        String(body.operationId),
        /^postplus-cli:research:collect:google-trends-fast:/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('polls hosted research collection handles through the hosted collection route', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'poll-result.json');
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
          charged: false,
          output: [{ url: 'https://www.facebook.com/facebook/' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const result = await runHostedDomainCommand('research', [
        'collect',
        '--run-handle',
        'hosted-collection-run-handle',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/collection',
      );
      assert.deepEqual(postedBody, {
        runHandle: 'hosted-collection-run-handle',
        runHandleType: 'hosted-collection',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('polls public-content research scrape handles through the hosted collection route', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const outputPath = resolve(requestDir, 'poll-result.json');
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
          charged: false,
          output: [{ url: 'https://www.facebook.com/facebook/' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const result = await runHostedDomainCommand('research', [
        'scrape',
        '--run-handle',
        's_public_content_snapshot',
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/collection',
      );
      assert.deepEqual(postedBody, {
        runHandle: 's_public_content_snapshot',
        runHandleType: 'public-content-collection',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown research collect collection key', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(requestPath, JSON.stringify({ keyword: 'x' }));

    await assert.rejects(
      runHostedDomainCommand('research', [
        'collect',
        'not-a-collection',
        '--request',
        requestPath,
      ]),
      /Unknown research collect collection not-a-collection/u,
    );
  });

  it('posts the manifest-driven research scrape verb to /hosted/capability with an array input', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const outputPath = resolve(requestDir, 'result.json');
    await writeFile(
      requestPath,
      JSON.stringify([
        {
          url: 'https://www.facebook.com/openai',
          num_of_posts: 5,
        },
      ]),
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
    let postedUrl: string | null = null;
    let postedBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      postedUrl = String(input);
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ charged: true, output: [{ post_id: 'p1' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    try {
      const result = await runHostedDomainCommand('research', [
        'scrape',
        'facebook-profile-posts',
        '--request',
        requestPath,
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      assert.equal(
        postedUrl,
        'https://postplus.test/api/postplus-cli/hosted/capability',
      );
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'public-content-collection');
      assert.equal(body.operation, 'scrape');
      assert.equal(body.sourceKey, 'facebook-profile-posts');
      assert.deepEqual(body.input, [
        {
          url: 'https://www.facebook.com/openai',
          num_of_posts: 5,
        },
      ]);
      // skillName is the compatibility header, never on the public capability body.
      assert.equal('skillName' in body, false);
      assert.match(
        String(body.operationId),
        /^postplus-cli:research:scrape:facebook-profile-posts:/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown research scrape source key', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(requestPath, JSON.stringify([{ url: 'https://x.test' }]));

    await assert.rejects(
      runHostedDomainCommand('research', [
        'scrape',
        'not-a-source',
        '--request',
        requestPath,
      ]),
      /Unknown research scrape source not-a-source/u,
    );
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
          estimatedMillicredits: 2000,
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
          /Unknown media estimate endpoint not-an-endpoint/u.test(error.message),
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a literal resume command on an async-pending media submit in both human and --json modes', async () => {
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

    // A terminal payload has nothing to resume — stay silent.
    const terminalStderr = await runSubmit([], {
      output: { data: { id: 'run_1', status: 'completed' } },
    });
    assert.doesNotMatch(terminalStderr, /resume/iu);
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
    globalThis.fetch = async (input, init) => {
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
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
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

  it('submits a manifest-driven video-analysis request (request-json) posting the opaque Gemini payload verbatim', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Analyze this video for hook, pacing, and CTA.' }],
        },
      ],
      generationConfig: { temperature: 0.2 },
    };
    await writeFile(requestPath, JSON.stringify(payload));

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
        'analyze',
        'video-analysis',
        '--request',
        requestPath,
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'video-analysis');
      assert.equal(body.operation, 'analyze');
      assert.equal(body.modelKey, 'video-analysis');
      assert.deepEqual(body.payload, payload);
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:video-analysis:analyze:/u,
      );
      // The locked Web contract is strict — the body carries no media-generation
      // envelope keys (no requestDimensions, endpointKey, input, estimatedUsage).
      assert.equal(Object.hasOwn(body, 'requestDimensions'), false);
      assert.equal(Object.hasOwn(body, 'endpointKey'), false);
      assert.equal(Object.hasOwn(body, 'input'), false);
      assert.equal(Object.hasOwn(body, 'estimatedUsage'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media analyze forwards --video-seconds as estimatedUsage.videoSeconds', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'Analyze this short clip.' }] },
      ],
    };
    await writeFile(requestPath, JSON.stringify(payload));

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
      const result = await runHostedDomainCommand('media', [
        'analyze',
        'video-analysis',
        '--request',
        requestPath,
        '--video-seconds',
        '30',
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      // Restores the video-analysis routing reachability the retired ffprobe runner
      // had: the caller-supplied duration reaches the Web routing/preflight boundary.
      assert.deepEqual(body.estimatedUsage, { videoSeconds: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('media analyze fast-fails on a non-positive --video-seconds before any hosted call', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(requestPath, JSON.stringify({ contents: [] }));

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
            '--request',
            requestPath,
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

  it('media-file upload returns a hosted media URL after create-upload-url, PUT, and upload', async () => {
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
        if (requestBody.operation === 'upload') {
          // Faithful to production: the provider upload response nests the fetch
          // URL under `data` and does NOT carry storageReference. The CLI itself
          // composes storageReference back in at output.storageReference.
          return new Response(
            JSON.stringify({
              output: {
                data: {
                  download_url: 'https://uploads.example.com/clip.mp4',
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
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

      assert.equal(hostedBodies.length, 2);
      const body = hostedBodies[0] as Record<string, unknown>;
      assert.equal(body.capability, 'media-file');
      assert.equal(body.operation, 'create-upload-url');
      assert.deepEqual(body.file, {
        mimeType: 'video/mp4',
        name: 'clip.mp4',
        sizeBytes: fileBytes.length,
      });
      assert.equal(body.operationId, 'upload-test-op');
      const uploadBody = hostedBodies[1] as Record<string, unknown>;
      assert.equal(uploadBody.capability, 'media-file');
      assert.equal(uploadBody.operation, 'upload');
      assert.equal(uploadBody.operationId, 'upload-test-op:upload');
      assert.deepEqual(uploadBody.file, {
        mimeType: 'video/mp4',
        name: 'clip.mp4',
        storageReference,
      });
      // The bytes were streamed to the signed target, not embedded in the JSON body.
      assert.equal(putContentType, 'video/mp4');
      assert.deepEqual(putBytes, fileBytes);

      const output = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(
        output.output.data.download_url,
        'https://uploads.example.com/clip.mp4',
      );
      assert.deepEqual(output.output.storageReference, storageReference);
      // The persistent postplus-media:// reference minted by create-upload-url is
      // composed into the final result beside storageReference/download_url.
      assert.equal(output.output.mediaReference, mediaReference);
    } finally {
      globalThis.fetch = originalFetch;
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
          const message = error instanceof Error ? error.message : String(error);
          assert.match(
            message,
            /^Unknown option for media create: --reference-image\. Endpoint image-gpt-image-2-text does not accept it; it is supported by: /u,
          );
          assert.match(message, /image-gpt-image-2-edit/u);
          assert.doesNotMatch(message, /image-gpt-image-2-text.*supported by.*image-gpt-image-2-text/u);
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
          const message = error instanceof Error ? error.message : String(error);
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
          availableMillicredits: 42000,
          reservedMillicredits: 1500,
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
        availableMillicredits: 42000,
        reservedMillicredits: 1500,
        subscriptionStatus: 'active',
      });
      const human = formatHostedBalanceReport(report);
      assert.match(human, /Available credits: 42/u);
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
          error: 'PostPlus CLI session is invalid or expired. Sign in again to continue.',
          code: 'postplus_cli_auth_invalid_session',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );

    try {
      await assert.rejects(
        () => fetchHostedBalance(),
        (error: unknown) =>
          error instanceof Error &&
          /invalid or expired/u.test(error.message),
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
              finalizedMillicredits: 3200,
              reservedMillicredits: 4000,
              providerStatus: 'succeeded',
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
      assert.match(human, /3200mc/u);
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
          providerFamily: 'moyu',
          providerModelPath: 'video-generation/seedance',
          providerStatus: 'succeeded',
          providerTaskId: 'task_9',
          providerUrls: { get: 'https://cdn.example.com/x.mp4' },
          outputs: { data: { id: 'run_1' } },
          error: null,
          requestDimensions: { seconds: 5 },
          createdAt: '2026-07-02T10:00:00Z',
          updatedAt: '2026-07-02T10:05:00Z',
          completedAt: '2026-07-02T10:05:00Z',
          failedAt: null,
          expiresAt: '2026-07-09T10:00:00Z',
          finalizedMillicredits: 3200,
          reservedMillicredits: 4000,
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
      assert.equal(report.finalizedMillicredits, 3200);
      const human = formatHostedRunDetailReport(report);
      assert.match(human, /Settled cost: 3200 millicredits \(actual\)/u);
      assert.match(human, /This run is terminal\./u);
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
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      return new Response(JSON.stringify({ ok: true, parity: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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
      managedSkills: { releaseId: PARITY_RELEASE_ID, skillNames: [] },
    });
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
      name: 'research collect google-trends-fast',
      domain: 'research',
      baseArgs: [
        'collect',
        'google-trends-fast',
        '--hosted-operation-id',
        PARITY_OP_ID,
      ],
      requestJson: {
        keyword: 'portable blender',
        geo: 'US',
        timeframe: 'today 12-m',
        enableTrendingSearches: false,
      },
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
      new Response(
        JSON.stringify({ output: { data: { id: 'run_parity' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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
