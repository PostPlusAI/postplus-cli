import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  loadReleaseManifest,
  loadReleaseSkillBundle,
} from './postplus-release.js';

import { formatAuthRefreshReport } from './auth-lifecycle.js';
import { formatCliSessionAuthError } from './auth-login.js';
import { formatAuthValidateReport } from './auth-validate.js';
import {
  clearAuthState,
  configureAccessToken,
  configureApiBaseUrl,
  configureRefreshToken,
  formatAuthStatusReport,
  generateAuthStatusReport,
  prepareAuthState,
} from './auth.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import {
  formatGuidedInstallReport,
  generateGuidedInstallReport,
} from './guided-install.js';
import {
  applyInstallReport,
  formatInstallReport,
  generateInstallReport,
  generateInstallStatusReport,
} from './install.js';
import {
  DEFAULT_POSTPLUS_API_BASE_URL,
  getPostPlusConfigDir,
  getPostPlusConfigPath,
  maskSecret,
  readLocalConfig,
  resolveAccessTokenState,
  resolveApiBaseUrlState,
  resolveRefreshTokenState,
  writeLocalConfig,
} from './local-state.js';
import { formatStatusReport, generateStatusReport } from './status.js';
import {
  applyUninstallReport,
  formatUninstallReport,
  generateUninstallReport,
} from './uninstall.js';
import {
  formatUpdateReport,
  generateUpdateReport,
  markUpdateCheckCompleted,
  shouldRunAutomaticUpdateCheck,
} from './update.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const execFileAsync = promisify(execFile);

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'postplus-cli-'));
  tempDirs.push(root);

  const skillsRoot = resolve(root, 'skills');
  await mkdir(skillsRoot, {
    recursive: true,
  });
  await mkdir(resolve(root, '.claude'), {
    recursive: true,
  });
  await symlink(
    '../skills',
    resolve(root, '.claude/skills'),
    'dir',
  );
  await mkdir(resolve(skillsRoot, 'demo-skill'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'demo-skill/SKILL.md'),
    '# Demo Skill\n\nA local demo skill.\n',
  );
  await mkdir(resolve(skillsRoot, 'demo-skill/scripts'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'demo-skill/scripts/demo.mjs'),
    'export function demo() {\n  return "demo-skill";\n}\n',
  );
  await mkdir(resolve(skillsRoot, 'skill-finder-cn'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'skill-finder-cn/SKILL.md'),
    '---\nname: skill-finder-cn\ndescription: catalog lookup\n---\n\n# Skill Finder\n',
  );
  await mkdir(resolve(skillsRoot, 'shared-support/scripts'), {
    recursive: true,
  });
  await writeFile(
    resolve(skillsRoot, 'shared-support/scripts/helper.mjs'),
    'export function helper() {\n  return "shared-support";\n}\n',
  );
  await writeFile(
    resolve(skillsRoot, 'shared-guide.md'),
    '# Shared Guide\n\nUsed by release bundles.\n',
  );
  await mkdir(resolve(skillsRoot, 'dependent-skill/scripts'), {
    recursive: true,
  });
  await writeFile(
    resolve(skillsRoot, 'dependent-skill/SKILL.md'),
    [
      '---',
      'name: dependent-skill',
      'description: depends on shared support',
      '---',
      '',
      '# Dependent Skill',
      '',
      'Read:',
      '',
      '- `skills/shared-guide.md`',
      '',
    ].join('\n'),
  );
  await writeFile(
    resolve(skillsRoot, 'dependent-skill/scripts/run.mjs'),
    'import { helper } from "../../shared-support/scripts/helper.mjs";\nconsole.log(helper());\n',
  );
  await mkdir(resolve(skillsRoot, 'demo-references'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'demo-references/notes.md'),
    '# Demo References\n\nUsed by doc-linked bundles.\n',
  );
  await mkdir(resolve(skillsRoot, 'doc-linked-skill'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'doc-linked-skill/SKILL.md'),
    [
      '---',
      'name: doc-linked-skill',
      'description: depends on shared docs and another skill script',
      '---',
      '',
      '# Doc Linked Skill',
      '',
      'Use:',
      '',
      '- `skills/demo-skill/scripts/demo.mjs`',
      '- `skills/demo-references/notes.md`',
      '',
    ].join('\n'),
  );
  await mkdir(resolve(skillsRoot, 'blocked-skill'), { recursive: true });
  await writeFile(
    resolve(skillsRoot, 'blocked-skill/SKILL.md'),
    '---\nname: blocked-skill\ndescription: should not be released\n---\n\n# Blocked Skill\n',
  );
  await writeFile(
    resolve(skillsRoot, 'registry.json'),
    `${JSON.stringify(
      {
        version: 1,
        package: {
          name: 'fixture-skills',
          primaryIndex: 'skills/INDEX.md',
          description: 'fixture',
        },
        sharedRulebooks: [
          {
            name: 'shared-guide',
            path: 'skills/shared-guide.md',
          },
        ],
        families: [
          {
            id: 'fixture',
            name: 'Fixture',
            purpose: 'fixture',
            skills: [
              {
                name: 'demo-skill',
                path: 'skills/demo-skill/SKILL.md',
                status: 'active',
              },
              {
                name: 'skill-finder-cn',
                path: 'skills/skill-finder-cn/SKILL.md',
                status: 'active',
              },
              {
                name: 'dependent-skill',
                path: 'skills/dependent-skill/SKILL.md',
                status: 'active',
              },
              {
                name: 'doc-linked-skill',
                path: 'skills/doc-linked-skill/SKILL.md',
                status: 'active',
              },
              {
                name: 'blocked-skill',
                path: 'skills/blocked-skill/SKILL.md',
                status: 'blocked/local-cli',
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

async function createInstallTargetDirs() {
  const claudeSkillsDir = await mkdtemp(resolve(tmpdir(), 'postplus-skills-'));
  const codexSkillsDir = await mkdtemp(
    resolve(tmpdir(), 'postplus-codex-skills-'),
  );
  const codexAppSkillsDir = await mkdtemp(
    resolve(tmpdir(), 'postplus-codex-app-skills-'),
  );

  tempDirs.push(claudeSkillsDir);
  tempDirs.push(codexSkillsDir);
  tempDirs.push(codexAppSkillsDir);

  process.env.POSTPLUS_CLAUDE_SKILLS_DIR = claudeSkillsDir;
  process.env.POSTPLUS_CODEX_SKILLS_DIR = codexSkillsDir;
  process.env.POSTPLUS_CODEX_APP_SKILLS_DIR = codexAppSkillsDir;

  return {
    claudeSkillsDir,
    codexSkillsDir,
    codexAppSkillsDir,
  };
}

async function withHostedReleaseFixture<T>(
  repoRoot: string,
  run: (
    manifest: Awaited<ReturnType<typeof loadReleaseManifest>>,
  ) => Promise<T>,
): Promise<T> {
  process.env.POSTPLUS_API_BASE_URL = 'https://postplus.example.com';
  const manifest = await loadReleaseManifest(repoRoot);
  const hostedBundlesBySkillId = new Map(
    await Promise.all(
      manifest.skills.map(async (entry) => [
        entry.skillId,
        await loadReleaseSkillBundle({
          repoRoot,
          skillId: entry.skillId,
        }),
      ] as const),
    ),
  );
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === 'https://postplus.example.com/api/postplus-cli/release-manifest') {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    if (url.startsWith('https://postplus.example.com/api/postplus-cli/release-skills/')) {
      const skillId = decodeURIComponent(
        url.slice('https://postplus.example.com/api/postplus-cli/release-skills/'.length),
      );
      const bundle = hostedBundlesBySkillId.get(skillId);

      if (bundle) {
        return new Response(JSON.stringify(bundle), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
    }

    return new Response(
      JSON.stringify({
        error: 'not found',
      }),
      {
        status: 404,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof fetch;

  try {
    return await run(manifest);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.POSTPLUS_ACCESS_TOKEN;
  delete process.env.POSTPLUS_CONFIG_DIR;
  delete process.env.POSTPLUS_CLAUDE_SKILLS_DIR;
  delete process.env.POSTPLUS_CODEX_SKILLS_DIR;
  delete process.env.POSTPLUS_CODEX_APP_SKILLS_DIR;
  delete process.env.POSTPLUS_API_BASE_URL;
  delete process.env.POSTPLUS_REFRESH_TOKEN;
});

after(async () => {
  process.env = originalEnv;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('generateDoctorReport', () => {
  it('uses the default hosted base url', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const report = await generateDoctorReport();

    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 2);
    assert.equal(report.checks[0]?.id, 'hosted_base_url');
    assert.equal(report.checks[0]?.status, 'pass');
    assert.match(
      report.checks[0]?.detail ?? '',
      new RegExp(DEFAULT_POSTPLUS_API_BASE_URL.replace('.', '\\.')),
    );
  });

  it('reports the hosted release catalog as the only release source', async () => {
    const report = await generateDoctorReport();

    assert.equal(report.checks[1]?.id, 'release_source');
    assert.match(
      formatDoctorReport(report),
      /\[PASS\] skill catalog: CLI commands install from the hosted PostPlus release catalog\./,
    );
  });
});

describe('local-state', () => {
  it('prefers POSTPLUS_ACCESS_TOKEN from env over config', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      accessToken: 'config-access-token',
      accountId: 'account-config',
    });
    process.env.POSTPLUS_ACCESS_TOKEN = 'env-access-token';

    const accessTokenState = await resolveAccessTokenState();

    assert.equal(accessTokenState.source, 'env');
    assert.equal(accessTokenState.value, 'env-access-token');
  });

  it('prefers POSTPLUS_REFRESH_TOKEN from env over config', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      refreshToken: 'config-refresh-token',
    });
    process.env.POSTPLUS_REFRESH_TOKEN = 'env-refresh-token';

    const refreshTokenState = await resolveRefreshTokenState();

    assert.equal(refreshTokenState.source, 'env');
    assert.equal(refreshTokenState.value, 'env-refresh-token');
  });

  it('prefers POSTPLUS_API_BASE_URL from env over config', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      apiBaseUrl: 'https://config.postplus.example.com',
    });
    process.env.POSTPLUS_API_BASE_URL = 'https://env.postplus.example.com';

    const apiBaseUrlState = await resolveApiBaseUrlState();

    assert.equal(apiBaseUrlState.source, 'env');
    assert.equal(apiBaseUrlState.value, 'https://env.postplus.example.com');
  });

  it('falls back to the default production api base url', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const apiBaseUrlState = await resolveApiBaseUrlState();

    assert.equal(apiBaseUrlState.source, 'default');
    assert.equal(apiBaseUrlState.present, true);
    assert.equal(apiBaseUrlState.value, DEFAULT_POSTPLUS_API_BASE_URL);
  });

  it('reads auth state from local config when env is absent', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      accessToken: 'config-access-token',
      accountId: 'account-1',
      refreshToken: 'config-refresh-token',
      sessionExpiresAt: 1_800_000_000,
      userId: 'user-1',
    });

    const accessTokenState = await resolveAccessTokenState();
    const refreshTokenState = await resolveRefreshTokenState();
    const config = await readLocalConfig();

    assert.equal(accessTokenState.source, 'config');
    assert.equal(accessTokenState.present, true);
    assert.equal(refreshTokenState.source, 'config');
    assert.equal(refreshTokenState.present, true);
    assert.equal(config?.accountId, 'account-1');
    assert.equal(config?.userId, 'user-1');
    assert.equal(getPostPlusConfigPath(), resolve(configRoot, 'config.json'));
  });

  it('masks secrets without exposing the full key', () => {
    assert.equal(maskSecret('12345678'), '********');
    assert.equal(maskSecret('1234567890abcdef'), '1234…cdef');
    assert.equal(maskSecret(null), null);
  });

  it('formats auth status from local config state', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      apiBaseUrl: 'https://postplus.example.com',
      accessToken: 'config-access-token',
      accountId: 'account-1',
      refreshToken: 'config-refresh-token',
      sessionExpiresAt: 1_800_000_000,
      userEmail: 'user@example.com',
    });

    const report = await generateAuthStatusReport();
    const formatted = formatAuthStatusReport(report);

    assert.equal(report.ok, true);
    assert.match(
      formatted,
      /\[PASS\] Access token: present \(config\)/,
    );
    assert.match(
      formatted,
      /\[PASS\] Refresh token: present \(config\)/,
    );
    assert.match(
      formatted,
      /\[PASS\] PostPlus Cloud: configured \(config\)/,
    );
    assert.match(formatted, /Account: account-1/);
    assert.match(formatted, /User: user@example.com/);
  });

  it('clears local auth state on logout', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await configureAccessToken('local-access-token');
    await configureRefreshToken('local-refresh-token');
    const report = await clearAuthState();

    assert.equal(report.ok, false);
    assert.equal(report.accessToken.present, false);
    assert.equal(report.refreshToken.present, false);
  });

  it('prepare auth state leaves the status readable without generating extra state', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const report = await prepareAuthState();

    assert.equal(report.ok, false);
    assert.equal(report.config.accountId, null);
  });

  it('stores a hosted base url in local config', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const report = await configureApiBaseUrl('https://postplus.example.com/');

    assert.equal(report.apiBaseUrl.present, true);
    assert.equal(report.apiBaseUrl.value, 'https://postplus.example.com');
  });

  it('supports profile-scoped config directories for developer isolation', () => {
    process.env.POSTPLUS_PROFILE = 'dev-local';

    const configDir = getPostPlusConfigDir().replaceAll('\\', '/');
    const configPath = getPostPlusConfigPath().replaceAll('\\', '/');

    assert.match(configDir, /\/profiles\/dev-local$/);
    assert.match(configPath, /\/profiles\/dev-local\/config\.json$/);
  });

  it('formats remote auth validation results', () => {
    const formatted = formatAuthValidateReport({
      accountId: 'account-1',
      apiBaseUrl: 'https://postplus.example.com',
      ok: true,
      sessionExpiresAt: 1_800_000_000,
      source: 'config',
      subscriptionStatus: 'active',
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    assert.match(formatted, /PostPlus CLI auth validate/);
    assert.match(formatted, /Remote auth: OK/);
    assert.match(formatted, /Account: account-1/);
  });

  it('formats remote auth refresh results', () => {
    const formatted = formatAuthRefreshReport({
      accountId: 'account-1',
      accessTokenExpiresAt: 1_800_000_000,
      apiBaseUrl: 'https://postplus.example.com',
      ok: true,
      subscriptionStatus: 'active',
      userEmail: 'user@example.com',
      userId: 'user-1',
    });

    assert.match(formatted, /PostPlus CLI auth refresh/);
    assert.match(formatted, /Remote auth: OK/);
    assert.match(formatted, /Subscription: active/);
  });
});

describe('status-report', () => {
  it('renders an incomplete overall status when auth is missing', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const formatted = await withHostedReleaseFixture(repoRoot, async () => {
      const doctor = await generateDoctorReport();
      const auth = await generateAuthStatusReport();
      const install = await generateInstallStatusReport();
      const update = await generateUpdateReport({});

      return formatStatusReport({
        ok: doctor.ok && auth.ok && install.ok && update.ok,
        doctor,
        auth,
        install,
        update,
      });
    });

    assert.match(formatted, /Overall: INCOMPLETE/);
    assert.match(formatted, /PostPlus CLI doctor/);
    assert.match(formatted, /PostPlus CLI auth status/);
  });

  it('treats release skills that are merely not installed as non-blocking overall status', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;
    await configureAccessToken('test-access-token');
    await configureRefreshToken('test-refresh-token');
    await configureApiBaseUrl('https://postplus.example.com');

    const report = await withHostedReleaseFixture(repoRoot, async () => {
      const installReport = await generateInstallReport({
        skillIds: ['demo-skill'],
      });
      await applyInstallReport(installReport);
      return generateStatusReport();
    });

    assert.equal(report.ok, true);
    assert.equal(
      report.update.updates.some((item) =>
        item.reasons.includes('not_installed'),
      ),
      true,
    );
  });

  it('keeps overall status incomplete when an installed skill target is missing', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir } = await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;
    await configureAccessToken('test-access-token');
    await configureRefreshToken('test-refresh-token');
    await configureApiBaseUrl('https://postplus.example.com');

    const report = await withHostedReleaseFixture(repoRoot, async () => {
      const installReport = await generateInstallReport({
        skillIds: ['demo-skill'],
      });
      await applyInstallReport(installReport);
      await rm(resolve(claudeSkillsDir, 'demo-skill'), {
        force: true,
        recursive: true,
      });

      return generateStatusReport();
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.update.updates.some((item) =>
        item.reasons.includes('missing_target'),
      ),
      true,
    );
  });
});

describe('auth-login', () => {
  it('formats server initialization failures as product guidance', () => {
    const message = formatCliSessionAuthError({
      code: 'postplus_cli_auth_not_initialized',
      error: 'PostPlus CLI auth is not initialized on this environment.',
    });

    assert.match(message, /not initialized on this environment/i);
    assert.match(message, /postplus auth login/i);
    assert.doesNotMatch(message, /POSTPLUS_CLI_API_SECRET/);
  });
});

describe('install-report', () => {
  it('builds a dry-run install plan for the Claude and Codex skills directories', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const report = await withHostedReleaseFixture(repoRoot, async () =>
      generateInstallReport({
        skillIds: ['demo-skill', 'skill-finder-cn'],
      }),
    );

    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(
      report.targets.map((target) => ({
        id: target.id,
        skillsDir: target.skillsDir,
      })),
      [
        { id: 'claude-code', skillsDir: claudeSkillsDir },
        { id: 'codex', skillsDir: codexSkillsDir },
        { id: 'codex-app', skillsDir: codexAppSkillsDir },
      ],
    );
    assert.equal(report.plan.length, 6);
    assert.match(
      formatInstallReport(report),
      /\[INSTALL\] demo-skill \[claude-code\]:/,
    );
  });

  it('applies install by creating symlinks into the target Claude, Codex, and Codex App skills dirs', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      const report = await generateInstallReport({
        skillIds: ['demo-skill'],
      });
      const applied = await applyInstallReport(report);
      const [claudeLinkTarget, codexLinkTarget, codexAppLinkTarget] =
        await Promise.all([
          readlink(resolve(claudeSkillsDir, 'demo-skill')),
          readlink(resolve(codexSkillsDir, 'demo-skill')),
          readlink(resolve(codexAppSkillsDir, 'demo-skill')),
        ]);

      assert.equal(applied.mode, 'apply');
      assert.match(claudeLinkTarget, /release-bundles/);
      assert.match(codexLinkTarget, /release-bundles/);
      assert.match(codexAppLinkTarget, /release-bundles/);

      const installStatus = await generateInstallStatusReport();
      assert.equal(installStatus.ok, true);
      assert.deepEqual(installStatus.installedSkills, ['demo-skill']);
      assert.equal(
        installStatus.targets.every((target) => target.ok),
        true,
      );
    });
  });

  it('merges newly installed skills into local config instead of overwriting prior installs', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['skill-finder-cn'],
        }),
      );
    });

    const config = await readLocalConfig();

    assert.deepEqual(config?.installedSkills, [
      'demo-skill',
      'skill-finder-cn',
    ]);
    assert.deepEqual(config?.installTargets, [
      'claude-code',
      'codex',
      'codex-app',
    ]);
    assert.deepEqual(config?.skillsDirs, {
      'claude-code': claudeSkillsDir,
      codex: codexSkillsDir,
      'codex-app': codexAppSkillsDir,
    });
    assert.equal(config?.installedSkillVersions?.['demo-skill'], null);
    assert.equal(config?.installedSkillVersions?.['skill-finder-cn'], null);
  });
});

describe('uninstall-report', () => {
  it('builds a dry-run uninstall plan for tracked installs across every target', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
    });

    const report = await generateUninstallReport({
      skillIds: ['demo-skill'],
    });

    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(report.removedSkillIds, ['demo-skill']);
    assert.equal(report.plan.length, 3);
    assert.equal(
      report.plan.every((item) => item.action === 'remove'),
      true,
    );
    assert.match(
      formatUninstallReport(report),
      /\[REMOVE\] demo-skill \[claude-code\]:/,
    );
  });

  it('applies uninstall by removing tracked symlinks and clearing install metadata when nothing remains', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
    });

    const report = await generateUninstallReport({
      skillIds: ['demo-skill'],
    });
    const applied = await applyUninstallReport(report);
    const config = await readLocalConfig();

    assert.equal(applied.mode, 'apply');
    await assert.rejects(lstat(resolve(claudeSkillsDir, 'demo-skill')), /ENOENT/);
    await assert.rejects(lstat(resolve(codexSkillsDir, 'demo-skill')), /ENOENT/);
    await assert.rejects(
      lstat(resolve(codexAppSkillsDir, 'demo-skill')),
      /ENOENT/,
    );
    assert.equal(config?.installedSkills, undefined);
    assert.equal(config?.installTargets, undefined);
    assert.equal(config?.skillsDirs, undefined);
    assert.equal(config?.installedSkillVersions, undefined);
    assert.equal(config?.installedSkillIntegrities, undefined);
  });

  it('preserves remaining install metadata when uninstalling only part of the tracked set', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['skill-finder-cn'],
        }),
      );
    });

    await applyUninstallReport(
      await generateUninstallReport({
        skillIds: ['demo-skill'],
      }),
    );

    const config = await readLocalConfig();

    await assert.rejects(lstat(resolve(claudeSkillsDir, 'demo-skill')), /ENOENT/);
    await assert.rejects(lstat(resolve(codexSkillsDir, 'demo-skill')), /ENOENT/);
    await assert.rejects(
      lstat(resolve(codexAppSkillsDir, 'demo-skill')),
      /ENOENT/,
    );
    assert.equal(
      (await lstat(resolve(claudeSkillsDir, 'skill-finder-cn'))).isSymbolicLink(),
      true,
    );
    assert.deepEqual(config?.installedSkills, ['skill-finder-cn']);
    assert.deepEqual(config?.installTargets, [
      'claude-code',
      'codex',
      'codex-app',
    ]);
    assert.equal(config?.installedSkillVersions?.['demo-skill'], undefined);
    assert.equal(
      config?.installedSkillVersions?.['skill-finder-cn'],
      null,
    );
  });

  it('removes hosted bundle cache directories for uninstalled skills', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
    });

    const bundleRoot = resolve(
      getPostPlusConfigDir(),
      'release-bundles',
      'demo-skill',
      'sha256-demo',
    );
    await mkdir(resolve(bundleRoot, 'skills/demo-skill'), { recursive: true });
    await writeFile(
      resolve(bundleRoot, 'skills/demo-skill/SKILL.md'),
      '# Cached Demo Skill\n',
    );

    await applyUninstallReport(
      await generateUninstallReport({
        skillIds: ['demo-skill'],
      }),
    );

    await assert.rejects(lstat(bundleRoot), /ENOENT/);
  });

  it('rejects untracked skill ids instead of guessing what to remove', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await withHostedReleaseFixture(repoRoot, async () => {
      await applyInstallReport(
        await generateInstallReport({
          skillIds: ['demo-skill'],
        }),
      );
    });

    await assert.rejects(
      generateUninstallReport({
        skillIds: ['skill-finder-cn'],
      }),
      /Unknown installed skill ids: skill-finder-cn/,
    );
  });

  it('fails fast when a tracked uninstall target is no longer a symlink', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    await writeLocalConfig({
      installTargets: ['claude-code', 'codex', 'codex-app'],
      installedSkills: ['demo-skill'],
      skillsDirs: {
        'claude-code': claudeSkillsDir,
        codex: codexSkillsDir,
        'codex-app': codexAppSkillsDir,
      },
    });
    await mkdir(resolve(claudeSkillsDir, 'demo-skill'), { recursive: true });

    await assert.rejects(
      generateUninstallReport({
        skillIds: ['demo-skill'],
      }),
      /Tracked skill path is not a symlink:/,
    );
  });
});

describe('catalog', () => {
  it('loads installable skills from the workspace release manifest', async () => {
    const repoRoot = await createRepoFixture();
    const manifest = await loadReleaseManifest(repoRoot);

    assert.equal(
      manifest.skills.some((entry) => entry.skillId === 'demo-skill'),
      true,
    );
    assert.equal(
      manifest.skills.some((entry) => entry.skillId === 'skill-finder-cn'),
      true,
    );
    assert.match(
      manifest.skills.find((entry) => entry.skillId === 'skill-finder-cn')
        ?.integrity ?? '',
      /^sha256:/,
    );
    assert.equal(
      manifest.skills.some((entry) => entry.skillId === 'blocked-skill'),
      false,
    );
  });

  it('changes release integrity when a non-SKILL file changes', async () => {
    const repoRoot = await createRepoFixture();
    const beforeManifest = await loadReleaseManifest(repoRoot);
    const beforeIntegrity =
      beforeManifest.skills.find((entry) => entry.skillId === 'demo-skill')
        ?.integrity ?? null;

    await writeFile(
      resolve(
        repoRoot,
        'skills/demo-skill/scripts/demo.mjs',
      ),
      'export function demo() {\n  return "demo-skill-updated";\n}\n',
    );

    const afterManifest = await loadReleaseManifest(repoRoot);
    const afterIntegrity =
      afterManifest.skills.find((entry) => entry.skillId === 'demo-skill')
        ?.integrity ?? null;

    assert.notEqual(beforeIntegrity, null);
    assert.notEqual(afterIntegrity, null);
    assert.notEqual(beforeIntegrity, afterIntegrity);
  });

  it('rejects blocked skills from the released bundle surface', async () => {
    const repoRoot = await createRepoFixture();

    await assert.rejects(
      loadReleaseSkillBundle({
        repoRoot,
        skillId: 'blocked-skill',
      }),
      /Unknown released skill: blocked-skill/,
    );
  });

  it('includes declared release support paths in hosted skill bundles', async () => {
    const repoRoot = await createRepoFixture();
    const bundle = await loadReleaseSkillBundle({
      repoRoot,
      skillId: 'dependent-skill',
    });

    assert.deepEqual(
      bundle.files.map((file) => file.path),
      [
        'skills/dependent-skill/scripts/run.mjs',
        'skills/dependent-skill/SKILL.md',
        'skills/shared-guide.md',
        'skills/shared-support/scripts/helper.mjs',
      ],
    );
  });

  it('infers markdown-linked support paths for hosted skill bundles', async () => {
    const repoRoot = await createRepoFixture();
    const bundle = await loadReleaseSkillBundle({
      repoRoot,
      skillId: 'doc-linked-skill',
    });

    assert.deepEqual(
      bundle.files.map((file) => file.path),
      [
        'skills/demo-references/notes.md',
        'skills/demo-skill/scripts/demo.mjs',
        'skills/demo-skill/SKILL.md',
        'skills/doc-linked-skill/SKILL.md',
        'skills/shared-guide.md',
      ],
    );
  });
});

describe('update-report', () => {
  it('tracks whether automatic update checks are due', async () => {
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const now = new Date('2026-04-23T00:00:00.000Z');

    assert.equal(await shouldRunAutomaticUpdateCheck(now), true);

    await markUpdateCheckCompleted(now);

    assert.equal(
      await shouldRunAutomaticUpdateCheck(new Date('2026-04-23T23:59:59.000Z')),
      false,
    );
    assert.equal(
      await shouldRunAutomaticUpdateCheck(new Date('2026-04-24T00:00:00.000Z')),
      true,
    );
  });

  it('reports not_installed skills before any local install', async () => {
    const repoRoot = await createRepoFixture();
    const report = await withHostedReleaseFixture(repoRoot, async () =>
      generateUpdateReport({
        skillIds: ['demo-skill'],
      }),
    );

    assert.equal(report.ok, false);
    assert.deepEqual(report.updates[0]?.reasons, ['not_installed']);
  });

  it('renders release messages from the manifest', () => {
    const formatted = formatUpdateReport({
      ok: true,
      canApply: false,
      messages: [
        {
          body: 'Try the hosted creative APIs for production runs.',
          id: 'hosted-api-cta',
          kind: 'marketing',
          title: 'Hosted APIs',
        },
      ],
      skillsDirs: {
        'claude-code': '/tmp/claude-skills',
        codex: '/tmp/codex-skills',
      },
      sourceKind: 'hosted-release',
      sourceRef: 'https://postplus.example.com',
      unknownInstalledSkillIds: [],
      updates: [],
      upToDateSkillIds: ['demo-skill'],
    });

    assert.match(formatted, /PostPlus messages/);
    assert.match(formatted, /Hosted APIs/);
  });

  it('reports no updates after local install matches the manifest', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;

    const report = await withHostedReleaseFixture(repoRoot, async () => {
      const installReport = await generateInstallReport({
        skillIds: ['demo-skill'],
      });
      await applyInstallReport(installReport);

      return generateUpdateReport({
        skillIds: ['demo-skill'],
      });
    });

    assert.equal(report.ok, true);
    assert.equal(report.updates.length, 0);
    assert.match(formatUpdateReport(report), /No local updates required/);
  });

  it('installs a hosted release bundle without a repo checkout', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;
    process.env.POSTPLUS_API_BASE_URL = 'https://postplus.example.com';

    const [manifest, demoBundle] = await Promise.all([
      loadReleaseManifest(repoRoot),
      loadReleaseSkillBundle({
        repoRoot,
        skillId: 'demo-skill',
      }),
    ]);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (
        url === 'https://postplus.example.com/api/postplus-cli/release-manifest'
      ) {
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (
        url ===
        'https://postplus.example.com/api/postplus-cli/release-skills/demo-skill'
      ) {
        return new Response(JSON.stringify(demoBundle), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      return new Response(
        JSON.stringify({
          error: 'not found',
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof fetch;

    try {
      const report = await generateInstallReport({
        skillIds: ['demo-skill'],
      });

      assert.equal(report.sourceKind, 'hosted-release');
      assert.equal(report.plan.length, 3);

      const applied = await applyInstallReport(report);
      const installedSkillDir = resolve(claudeSkillsDir, 'demo-skill');
      const codexInstalledSkillDir = resolve(codexSkillsDir, 'demo-skill');
      const codexAppInstalledSkillDir = resolve(
        codexAppSkillsDir,
        'demo-skill',
      );
      const installedSkillFile = resolve(installedSkillDir, 'SKILL.md');
      const installedScriptFile = resolve(
        installedSkillDir,
        'scripts/demo.mjs',
      );
      const [installedStats, codexInstalledStats, codexAppInstalledStats] =
        await Promise.all([
        lstat(installedSkillDir),
        lstat(codexInstalledSkillDir),
        lstat(codexAppInstalledSkillDir),
      ]);

      assert.equal(applied.mode, 'apply');
      assert.equal(installedStats.isSymbolicLink(), true);
      assert.equal(codexInstalledStats.isSymbolicLink(), true);
      assert.equal(codexAppInstalledStats.isSymbolicLink(), true);
      assert.match(await readFile(installedSkillFile, 'utf8'), /Demo Skill/);
      assert.match(await readFile(installedScriptFile, 'utf8'), /demo-skill/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs an installed hosted skill with bundled support paths', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir, codexSkillsDir, codexAppSkillsDir } =
      await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;
    process.env.POSTPLUS_API_BASE_URL = 'https://postplus.example.com';

    const [manifest, dependentBundle] = await Promise.all([
      loadReleaseManifest(repoRoot),
      loadReleaseSkillBundle({
        repoRoot,
        skillId: 'dependent-skill',
      }),
    ]);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (
        url === 'https://postplus.example.com/api/postplus-cli/release-manifest'
      ) {
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (
        url ===
        'https://postplus.example.com/api/postplus-cli/release-skills/dependent-skill'
      ) {
        return new Response(JSON.stringify(dependentBundle), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      return new Response(
        JSON.stringify({
          error: 'not found',
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof fetch;

    try {
      const report = await generateInstallReport({
        skillIds: ['dependent-skill'],
      });

      await applyInstallReport(report);

      const installedTarget = resolve(claudeSkillsDir, 'dependent-skill');
      const codexInstalledTarget = resolve(codexSkillsDir, 'dependent-skill');
      const codexAppInstalledTarget = resolve(
        codexAppSkillsDir,
        'dependent-skill',
      );
      const [installedStats, codexInstalledStats, codexAppInstalledStats] =
        await Promise.all([
        lstat(installedTarget),
        lstat(codexInstalledTarget),
        lstat(codexAppInstalledTarget),
      ]);
      const { stdout } = await execFileAsync('node', [
        resolve(installedTarget, 'scripts/run.mjs'),
      ]);

      assert.equal(installedStats.isSymbolicLink(), true);
      assert.equal(codexInstalledStats.isSymbolicLink(), true);
      assert.equal(codexAppInstalledStats.isSymbolicLink(), true);
      assert.match(stdout, /shared-support/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('restores the previous target when hosted replacement fails', async () => {
    const repoRoot = await createRepoFixture();
    const configRoot = await mkdtemp(resolve(tmpdir(), 'postplus-config-'));
    tempDirs.push(configRoot);
    const { claudeSkillsDir } = await createInstallTargetDirs();
    process.env.POSTPLUS_CONFIG_DIR = configRoot;
    process.env.POSTPLUS_API_BASE_URL = 'https://postplus.example.com';

    const existingSkillDir = resolve(claudeSkillsDir, 'demo-skill');
    await mkdir(existingSkillDir, { recursive: true });
    await writeFile(
      resolve(existingSkillDir, 'SKILL.md'),
      '# Existing Skill\n\nExisting install.\n',
    );

    const manifest = await loadReleaseManifest(repoRoot);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (
        url === 'https://postplus.example.com/api/postplus-cli/release-manifest'
      ) {
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }

      if (
        url ===
        'https://postplus.example.com/api/postplus-cli/release-skills/demo-skill'
      ) {
        return new Response(
          JSON.stringify({
            error: 'bundle unavailable',
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: 'not found',
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof fetch;

    try {
      const report = await generateInstallReport({
        skillIds: ['demo-skill'],
        force: true,
      });

      await assert.rejects(
        () => applyInstallReport(report),
        /bundle unavailable/,
      );
      assert.match(
        await readFile(resolve(existingSkillDir, 'SKILL.md'), 'utf8'),
        /Existing Skill/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('guided-install', () => {
  it('renders a guided install prompt that maps to the same install contract', async () => {
    const repoRoot = await createRepoFixture();
    const report = await withHostedReleaseFixture(repoRoot, async () =>
      generateGuidedInstallReport({
        skillIds: ['demo-skill'],
      }),
    );

    assert.equal(report.installCommand, 'postplus install demo-skill');
    assert.deepEqual(report.targets, ['claude-code', 'codex', 'codex-app']);
    assert.equal(report.verifyCommand, 'postplus status');
    assert.match(report.prompt, /Do not copy skill directories manually/);
    const formatted = formatGuidedInstallReport(report);
    assert.match(formatted, /Install command: postplus install demo-skill/);
    assert.match(formatted, /Targets: claude-code, codex, codex-app/);
    assert.match(
      formatted,
      /Run the official PostPlus CLI install contract for Claude Code, Codex, and the Codex app on this machine\./,
    );
  });
});
