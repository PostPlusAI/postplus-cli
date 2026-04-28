import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { generateAuthStatusReport } from './auth.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import {
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import { formatStatusReport, generateStatusReport } from './status.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const originalEnv = { ...process.env };

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
  it('reports PostPlus Cloud auth readiness without skill install state', async () => {
    process.env.POSTPLUS_ACCESS_TOKEN = 'access-token-value';
    process.env.POSTPLUS_REFRESH_TOKEN = 'refresh-token-value';
    process.env.POSTPLUS_API_BASE_URL = 'https://postplus.example.com';

    const status = await generateStatusReport();
    assert.equal(status.ok, true);
    assert.equal(status.auth.ok, true);
    assert.equal(status.doctor.ok, true);
    assert.match(formatStatusReport(status), /PostPlus CLI status/);
    assert.doesNotMatch(formatStatusReport(status), /install status/i);
  });

  it('doctor reports PostPlus Cloud readiness without skill install state', async () => {
    const report = await generateDoctorReport();
    const formatted = formatDoctorReport(report);

    assert.equal(report.ok, true);
    assert.match(formatted, /PostPlus Cloud/);
    assert.doesNotMatch(formatted, /skills add/);
  });

  it('auth status remains incomplete until the user signs in', async () => {
    const report = await generateAuthStatusReport();

    assert.equal(report.ok, false);
    assert.equal(report.accessToken.present, false);
    assert.equal(report.refreshToken.present, false);
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
});

describe('removed skill management commands', () => {
  for (const command of ['install', 'update', 'uninstall']) {
    it(`fails fast for postplus ${command}`, async () => {
      await assert.rejects(
        execFileAsync(process.execPath, [
          '--import',
          'tsx',
          'src/index.ts',
          command,
        ]),
        (error) => {
          const execError = error as Error & {
            stderr?: string;
          };

          assert.match(
            execError.stderr ?? '',
            /npx -y skills add PostPlusAI\/postplus-skills --all/,
          );
          return true;
        },
      );
    });
  }
});
