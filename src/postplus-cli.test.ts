import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  CLI_AUTH_LOGIN_TIMEOUT_MS,
  pollCloudAuthLogin,
  startCloudAuthLogin,
} from './auth-login.js';
import { validateRemoteAuth } from './auth-validate.js';
import { formatAuthStatusReport, generateAuthStatusReport } from './auth.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import { readLocalConfig, setLocalSession } from './local-state.js';
import {
  POSTPLUS_SKILLS_AGENT_TARGETS,
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import {
  buildPostPlusSkillUninstallArgs,
  buildPostPlusSkillUpdateArgs,
  generateSkillInstallStatusReport,
} from './skill-management.js';
import {
  formatStatusReport,
  generateStatusReportWithDependencies,
} from './status.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const execFileAsync = promisify(execFile);

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
      accessToken: 'access-token-value',
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'refresh-token-value',
      sessionExpiresAt: 1_900_000_000,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer access-token-value',
        );

        return new Response(
          JSON.stringify({
            accountId: 'account-1',
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
          missingSkills: [],
          requiredCount: 2,
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
            currentVersion: '0.1.12',
            latestVersion: '0.1.12',
            updateAvailable: false,
            updateCommand: 'npm install -g @postplus/cli',
          },
          skills: {
            currentRevision: 'abc123',
            latestRevision: 'abc123',
            updateAvailable: false,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      assert.equal(status.ok, true);
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

  it('reports inactive subscriptions without failing hosted readiness', async () => {
    await setLocalSession({
      accessToken: 'access-token-value',
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'refresh-token-value',
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
            accountId: 'account-1',
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
          missingSkills: [],
          requiredCount: 2,
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
            updateCommand: 'npm install -g @postplus/cli',
          },
          skills: {
            currentRevision: 'abc123',
            latestRevision: 'def456',
            updateAvailable: true,
            updateCommand: 'postplus update',
          },
          warning: null,
        }),
      });
      const formatted = formatStatusReport(status);

      assert.equal(status.ok, true);
      assert.match(formatted, /subscription unknown/);
      assert.doesNotMatch(formatted, /Not ready: subscription/);
      assert.match(formatted, /npm install -g @postplus\/cli/);
      assert.match(formatted, /postplus update/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('doctor fails fast until the user signs in', async () => {
    const report = await generateDoctorReport();
    const formatted = formatDoctorReport(report);

    assert.equal(report.ok, false);
    assert.match(formatted, /PostPlus Cloud/);
    assert.match(formatted, /postplus auth login/);
    assert.doesNotMatch(formatted, /skills add/);
  });

  it('auth status remains incomplete until the user signs in', async () => {
    const report = await generateAuthStatusReport();

    assert.equal(report.ok, false);
    assert.equal(report.accessToken.present, false);
    assert.equal(report.refreshToken.present, false);
  });

  it('omits access token expiry from auth status output', async () => {
    await setLocalSession({
      accessToken: createTestJwt(Math.floor(Date.now() / 1_000) + 3600),
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'refresh-token-value',
      sessionExpiresAt: Math.floor(Date.now() / 1_000) + 3600,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const formatted = formatAuthStatusReport(await generateAuthStatusReport());

    assert.doesNotMatch(formatted, /expires/i);
  });

  it('refreshes an expired session before doctor checks remote auth', async () => {
    process.env.POSTPLUS_ACCESS_TOKEN = 'stale-env-access-token';
    process.env.POSTPLUS_REFRESH_TOKEN = 'stale-env-refresh-token';
    const refreshedAccessToken = createTestJwt(
      Math.floor(Date.now() / 1_000) + 3600,
    );
    const configAccessToken = createTestJwt(
      Math.floor(Date.now() / 1_000) - 60,
    );
    await setLocalSession({
      accessToken: configAccessToken,
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'refresh-token-value',
      sessionExpiresAt: Math.floor(Date.now() / 1_000) - 60,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.endsWith('/api/postplus-cli/auth/refresh')) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          `Bearer ${configAccessToken}`,
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          refreshToken: 'refresh-token-value',
        });

        return new Response(
          JSON.stringify({
            accessToken: refreshedAccessToken,
            accountId: 'account-1',
            refreshToken: 'refresh-token-next',
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
        (init?.headers as Record<string, string>).authorization,
        `Bearer ${refreshedAccessToken}`,
      );

      if (url.endsWith('/api/postplus-cli/auth/whoami')) {
        return new Response(
          JSON.stringify({
            accountId: 'account-1',
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
      assert.deepEqual(requestedUrls, [
        'https://postplus.example.com/api/postplus-cli/auth/refresh',
        'https://postplus.example.com/api/postplus-cli/auth/whoami',
        'https://postplus.example.com/api/postplus-cli/hosted/readiness',
      ]);
      assert.equal(config?.accessToken, refreshedAccessToken);
      assert.equal(config?.refreshToken, 'refresh-token-next');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshes an expired session before auth validate', async () => {
    const refreshedAccessToken = createTestJwt(
      Math.floor(Date.now() / 1_000) + 3600,
    );
    await setLocalSession({
      accessToken: createTestJwt(Math.floor(Date.now() / 1_000) - 60),
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      refreshToken: 'refresh-token-value',
      sessionExpiresAt: Math.floor(Date.now() / 1_000) - 60,
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);

      if (url.endsWith('/api/postplus-cli/auth/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: refreshedAccessToken,
            accountId: 'account-1',
            refreshToken: 'refresh-token-next',
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
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        `Bearer ${refreshedAccessToken}`,
      );

      return new Response(
        JSON.stringify({
          accountId: 'account-1',
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

function createTestJwt(exp: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp })}.signature`;
}

describe('cloud auth handoff', () => {
  it('keeps the CLI login window at 30 minutes', () => {
    assert.equal(CLI_AUTH_LOGIN_TIMEOUT_MS, 30 * 60 * 1000);
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
          accessToken: 'access-token-value',
          accountId: 'account-1',
          refreshToken: 'refresh-token-value',
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
      assert.equal(completed.accessToken, 'access-token-value');
      assert.equal(completed.refreshToken, 'refresh-token-value');
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
  it('loads and parses the public skill index', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          '# Skills Index',
          '',
          '## Shared Rulebooks',
          '',
          '- `shared-release-shell-rules`',
          '  - Path: `skills/shared-release-shell-rules.md`',
          '',
          '## Released Skills',
          '',
          '### Demo',
          'Demo family.',
          '',
          '- `demo-skill`',
          '  - Path: `skills/demo-skill/SKILL.md`',
          '- `second-skill`',
          '  - Path: `skills/second-skill/SKILL.md`',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        },
      );

    try {
      const catalog = await loadPublicSkillCatalog();

      assert.equal(catalog.source, 'PostPlusAI/postplus-skills');
      assert.equal(catalog.installCommand, POSTPLUS_SKILLS_INSTALL_COMMAND);
      assert.deepEqual(catalog.skills, [
        {
          skillId: 'demo-skill',
          path: 'skills/demo-skill/SKILL.md',
        },
        {
          skillId: 'second-skill',
          path: 'skills/second-skill/SKILL.md',
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill index has no released section', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('# Skills Index\n\n## Shared Rulebooks\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /missing ## Released Skills section/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast when the public skill index has an empty release list', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('# Skills Index\n\n## Released Skills\n', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });

    try {
      await assert.rejects(
        () => loadPublicSkillCatalog(),
        /no released skills were found/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('skill management commands', () => {
  it('builds update and uninstall commands for released PostPlus skills only', () => {
    assert.deepEqual(buildPostPlusSkillUpdateArgs(['a', 'b']), [
      '-y',
      'skills',
      'update',
      'a',
      'b',
      '--yes',
    ]);
    assert.deepEqual(buildPostPlusSkillUninstallArgs(['a', 'b']), [
      '-y',
      'skills',
      'remove',
      'a',
      'b',
      '--agent',
      ...POSTPLUS_SKILLS_AGENT_TARGETS,
      '--yes',
    ]);
  });

  it('reports missing released skills from skills list output', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          '# Skills Index',
          '',
          '## Released Skills',
          '',
          '- `demo-skill`',
          '  - Path: `skills/demo-skill/SKILL.md`',
          '- `missing-skill`',
          '  - Path: `skills/missing-skill/SKILL.md`',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
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
          /npx -y skills add PostPlusAI\/postplus-skills --full-depth --skill '\*' --agent claude-code codex cursor github-copilot windsurf trae trae-cn --yes/,
        );
        return true;
      },
    );
  });
});
