import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
  CLI_AUTH_LOGIN_TIMEOUT_MS,
  openCloudAuthVerificationUrlIfConfigured,
  pollCloudAuthLogin,
  startCloudAuthLogin,
} from './auth-login.js';
import {
  formatAuthValidateReport,
  validateRemoteAuth,
} from './auth-validate.js';
import { formatAuthStatusReport, generateAuthStatusReport } from './auth.js';
import { POSTPLUS_CLIENT_COMPATIBILITY_HEADERS } from './client-compatibility.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import { runHostedDomainCommand } from './hosted-domain-commands.js';
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
  POSTPLUS_CLI_UPDATE_COMMAND,
  generateUpdateStatusReport,
  runCliSelfUpdateIfOutdated,
} from './update-check.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const execFileAsync = promisify(execFile);

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
            modelKeys: ['gemini-video-analysis'],
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
          id: 'video-analysis:gemini-video-analysis',
          label: 'Video analysis: gemini-video-analysis',
          modelKey: 'gemini-video-analysis',
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
  tempDirs.push(configDir);
  process.env.POSTPLUS_CONFIG_DIR = configDir;
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
          '0.1.38',
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
            currentVersion: '0.1.38',
            latestVersion: '0.1.38',
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
      assert.equal((await readLocalConfig())?.cliVersion, '0.1.38');
      assert.equal(status.ok, true);
      assert.equal(status.doctor.schemaVersion, 1);
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

      assert.equal(report.schemaVersion, 1);
      assert.equal(report.ok, false);
      assert.match(
        formatted,
        /Media generation: image-nano-banana-2-text \(Provider configuration\)/,
      );
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

      assert.equal(report.schemaVersion, 1);
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
  it('keeps the CLI login window at 30 minutes', () => {
    assert.equal(CLI_AUTH_LOGIN_TIMEOUT_MS, 30 * 60 * 1000);
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
                modelKeys: ['gemini-video-analysis'],
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
            modelKeys: ['gemini-video-analysis'],
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

        return new Response(JSON.stringify({ version: '0.1.39' }), {
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
    assert.equal(result.currentVersion, '0.1.38');
    assert.equal(result.latestVersion, '0.1.39');
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
      "for agent in claude-code codex cursor github-copilot windsurf trae trae-cn openclaw hermes-agent; do npx -y skills add PostPlusAI/postplus-skills --full-depth --skill '*' --agent \"$agent\" --yes; done",
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
          ]),
        }),
      });

      assert.equal(report.ok, true);
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
      assert.equal(config?.cliVersion, '0.1.38');
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
    assert.match(researchHelp, /postplus research capability/u);
    assert.match(researchHelp, /postplus research schema/u);

    for (const domain of ['media', 'publish', 'mobile']) {
      const { stdout } = await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        'src/index.ts',
        domain,
        'help',
      ]);
      assert.match(stdout, new RegExp(`postplus ${domain} capability`, 'u'));
      assert.match(stdout, new RegExp(`postplus ${domain} schema`, 'u'));
      if (domain === 'media') {
        assert.match(stdout, /--endpoint <endpoint-key>/u);
      }
    }
  });

  it('prints public hosted request schemas without requiring auth', async () => {
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
    assert.equal(researchReport.selectedCollectionKey, 'youtube-channel-summary');
    assert.ok(
      (researchReport.collectionKeys as string[]).includes(
        'youtube-channel-summary',
      ),
    );
    assert.ok(
      (researchReport.sourceKeys as string[]).includes('youtube-videos'),
    );
    assert.deepEqual(
      (
        (
          researchReport.examples as Record<string, unknown>
        )['public-content-collection.scrape'] as Record<string, unknown>
      ).input,
      [
        {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    );
    assert.deepEqual(
      (
        (
          researchReport.examples as Record<string, unknown>
        )['research.collection-envelope'] as Record<string, unknown>
      ).input,
      {
        channels: ['@Google'],
        includeChannelInfo: true,
        includeVideos: false,
        maxVideosPerChannel: 0,
      },
    );

    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'media',
      'schema',
      '--endpoint',
      'video-seedance-2-text-turbo',
      '--json',
    ]);
    const report = JSON.parse(stdout) as Record<string, unknown>;

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.domain, 'media');
    assert.match(String(report.command), /postplus media capability/u);
    assert.ok(
      (report.endpointKeys as string[]).includes('video-seedance-2-text-turbo'),
    );

    const examples = report.examples as Record<string, unknown>;
    const request = examples[
      'media-generation.request'
    ] as Record<string, unknown>;
    assert.equal(request.capability, 'media-generation');
    assert.equal(request.operation, 'request');
    assert.equal(request.endpointKey, 'video-seedance-2-text-turbo');
    assert.equal(Object.hasOwn(request, 'skillName'), false);
    assert.equal(Object.hasOwn(request, 'operationId'), false);
    assert.equal(Object.hasOwn(request, 'requestDimensions'), false);

    const { stdout: publishStdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/index.ts',
      'publish',
      'schema',
      '--json',
    ]);
    const publishReport = JSON.parse(publishStdout) as Record<string, unknown>;
    const publishExamples = publishReport.examples as Record<string, unknown>;
    assert.deepEqual(publishExamples['social-publishing.create-post'], {
      capability: 'social-publishing',
      operation: 'create-post',
      input: {
        body: {
          posts: [],
        },
      },
    });
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
        assert.match(execError.stderr ?? '', /video-seedance-2-text-turbo/u);
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

  it('fails fast when hosted capability request files omit capability fields', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(requestPath, JSON.stringify({ input: {} }));

    await assert.rejects(
      () =>
        runHostedDomainCommand('media', [
          'capability',
          '--request',
          requestPath,
        ]),
      /must include string capability/u,
    );
  });

  it('posts hosted domain requests with explicit capability and operation', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const outputPath = resolve(requestDir, 'result.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: 'media-generation',
        operation: 'status',
        handle: 'media-run-1',
        skillName: 'video-batch-runner',
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
        'capability',
        '--request',
        requestPath,
        '--output',
        outputPath,
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.handle, 'media-run-1');
      assert.equal(body.operation, 'status');
      assert.equal(Object.hasOwn(body, 'skillName'), false);
      assert.equal(body.quoteConfirmationToken, undefined);
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:media-generation:status:/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('posts public-content research capability requests', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: 'public-content-collection',
        input: [
          {
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        ],
        operation: 'scrape',
        sourceKey: 'youtube-videos',
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
      const result = await runHostedDomainCommand('research', [
        'capability',
        '--request',
        requestPath,
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'public-content-collection');
      assert.equal(body.operation, 'scrape');
      assert.equal(body.sourceKey, 'youtube-videos');
      assert.match(
        String(body.operationId),
        /^postplus-cli:research:public-content-collection:scrape:/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('derives media-generation billing dimensions from the public request', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: 'media-generation',
        endpointKey: 'video-seedance-2-text-turbo',
        input: {
          duration: 5,
          prompt: 'demo',
          resolution: '720p',
        },
        operation: 'request',
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
        'capability',
        '--request',
        requestPath,
      ]);
      assert.equal(result, 0);
      const body = postedBody as Record<string, unknown>;
      assert.equal(body.capability, 'media-generation');
      assert.equal(body.operation, 'request');
      assert.match(
        String(body.operationId),
        /^postplus-cli:media:media-generation:request:/u,
      );
      assert.deepEqual(body.requestDimensions, {
        audioMode: 'on',
        billableUnitCount: 1,
        duration: 5,
        operationKey: 'video-seedance-2-text-turbo',
        referenceVideoCount: 0,
        referenceVideoMode: 'without_reference_videos',
        requestBytes: 50,
        resolution: '720p',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects public media-generation requests with hand-written billing dimensions', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: 'media-generation',
        endpointKey: 'video-seedance-2-text-turbo',
        input: {
          duration: 5,
          prompt: 'demo',
          resolution: '720p',
        },
        operation: 'request',
        requestDimensions: {
          billableUnitCount: 1,
        },
      }),
    );

    await assert.rejects(
      () =>
        runHostedDomainCommand('media', [
          'capability',
          '--request',
          requestPath,
        ]),
      /must not include requestDimensions/u,
    );
  });

  it('writes quote confirmation challenges beside hosted command outputs', async () => {
    const requestDir = await mkdtemp(resolve(tmpdir(), 'postplus-cli-hosted-'));
    tempDirs.push(requestDir);
    const requestPath = resolve(requestDir, 'request.json');
    const outputPath = resolve(requestDir, 'result.json');
    const challenge = buildLargeCreditChallenge({
      requiredTierMillicredits: 100_000,
    });
    await writeFile(
      requestPath,
      JSON.stringify({
        capability: 'media-generation',
        endpointKey: 'video-seedance-2-text-turbo',
        input: {
          duration: 5,
          prompt: 'demo',
          resolution: '720p',
        },
        operation: 'request',
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
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'This request may reserve 100 credits and requires confirmation.',
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
            'capability',
            '--request',
            requestPath,
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
          return true;
        },
      );
      assert.deepEqual(
        JSON.parse(await readFile(`${outputPath}.quote-confirmation.json`, 'utf8')),
        challenge,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
