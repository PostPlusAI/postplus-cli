import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadReleaseManifest,
  loadReleaseSkillBundle,
} from './postplus-release.js';

type Registry = {
  sharedRulebooks?: Array<{
    path?: string;
  }>;
  families?: Array<{
    id?: string;
    skills?: Array<{
      name?: string;
      path?: string;
      releaseSupportPaths?: string[];
      status?: string;
    }>;
  }>;
};

type ReleasedSkill = {
  familyId: string;
  skillId: string;
  skillFile: string;
  releaseSupportPaths: string[];
};

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const skillsRepoRoot = process.env.POSTPLUS_SKILLS_REPO_DIR?.trim()
  ? resolve(process.env.POSTPLUS_SKILLS_REPO_DIR.trim())
  : repoRoot;
const bundleRoot = skillsRepoRoot;
const registryPath = resolve(bundleRoot, 'skills/registry.json');
const skillsRepoSkipReason = existsSync(registryPath)
  ? undefined
  : 'Set POSTPLUS_SKILLS_REPO_DIR to a postplus-skills checkout to run release-skill contract tests.';

const DOT_POSTPLUS_SKILLS = new Set([
  '1688-tools',
  'amazon-research',
  'audio-transcription',
  'broll-catalog-builder',
  'broll-match-engine',
  'creative-qa',
  'creator-outreach',
  'edit-enhancement-packager',
  'editing-decision-engine',
  'frame-extraction',
  'google-trends-research',
  'image-batch-runner',
  'instagram-tools',
  'linkedin-research',
  'subtitle-packager',
  'tiktok-research',
  'tiktok-shop-research',
  'video-transcription',
  'video-batch-runner',
  'voice-batch-runner',
  'xhs-media-collector',
  'x-tools',
  'xiaohongshu-article-packager',
  'xiaohongshu-card-notes',
  'xiaohongshu-tools',
  'youtube-research',
]);

const BOUNDED_FIRST_PASS_SKILLS = new Set([
  '1688-tools',
  'amazon-research',
  'audio-transcription',
  'broll-catalog-builder',
  'broll-match-engine',
  'edit-enhancement-packager',
  'editing-decision-engine',
  'google-trends-research',
  'instagram-tools',
  'linkedin-research',
  'subtitle-packager',
  'tiktok-research',
  'tiktok-shop-research',
  'video-transcription',
  'xhs-media-collector',
  'x-tools',
  'xiaohongshu-article-packager',
  'xiaohongshu-card-notes',
  'xiaohongshu-tools',
  'youtube-research',
]);

const FAIL_FAST_SKILLS = new Set([
  'amazon-research',
  'audio-transcription',
  'broll-catalog-builder',
  'broll-match-engine',
  'edit-enhancement-packager',
  'editing-decision-engine',
  'frame-extraction',
  'google-trends-research',
  'image-batch-runner',
  'instagram-tools',
  'linkedin-research',
  'subtitle-packager',
  'tiktok-research',
  'tiktok-shop-research',
  'video-transcription',
  'x-tools',
  'xhs-media-collector',
  'xiaohongshu-article-packager',
  'xiaohongshu-card-notes',
  'xiaohongshu-tools',
  'youtube-research',
]);

const AGENT_MANAGED_LOCAL_DEP_SKILLS = new Set([
  'broll-catalog-builder',
  'frame-extraction',
]);

const RELEASED_FAMILY_VERIFICATION_COVERAGE = {
  'routing-contracts': {
    degradedSkillId: 'creator-outreach',
    successSkillId: 'creator-outreach',
  },
  instagram: {
    degradedSkillId: 'instagram-tools',
    successSkillId: 'instagram-tools',
  },
  'marketplace-sourcing': {
    degradedSkillId: 'amazon-research',
    successSkillId: 'amazon-research',
  },
  'media-production': {
    degradedSkillId: 'image-batch-runner',
    successSkillId: 'image-batch-runner',
  },
  'platform-research': {
    degradedSkillId: 'linkedin-research',
    successSkillId: 'youtube-research',
  },
  tiktok: {
    degradedSkillId: 'tiktok-research',
    successSkillId: 'tiktok-shop-research',
  },
  xiaohongshu: {
    degradedSkillId: 'xiaohongshu-tools',
    successSkillId: 'xhs-media-collector',
  },
  'workspace-publishing': {
    degradedSkillId: 'skill-finder-cn',
    successSkillId: 'skill-finder-cn',
  },
  x: {
    degradedSkillId: 'x-tools',
    successSkillId: 'x-tools',
  },
} as const;

const LEGACY_PATTERNS = [
  /clawhub/i,
  /openclaw/i,
  /clawdbot/i,
  /customers\/<customer-id>\//i,
  /customers\/[a-z0-9_-]+\//i,
  /~\/self-improving\//i,
];

function isReleaseReadyStatus(status: string | undefined) {
  if (!status) {
    return false;
  }

  if (status.startsWith('blocked/')) {
    return false;
  }

  return !status.includes('/experimental');
}

async function loadReleasedSkills() {
  const raw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(raw) as Registry;
  const sharedRulebooks = Array.from(
    new Set(
      (registry.sharedRulebooks ?? [])
        .map((entry) => entry.path?.trim() ?? '')
        .filter((entry) => entry.length > 0),
    ),
  );
  const releasedSkills: ReleasedSkill[] = [];

  for (const family of registry.families ?? []) {
    const familyId = family.id?.trim() ?? 'unknown';

    for (const skill of family.skills ?? []) {
      if (!isReleaseReadyStatus(skill.status)) {
        continue;
      }

      const skillPath = skill.path?.trim();
      const skillId = skill.name?.trim();
      if (!skillPath || !skillId) {
        continue;
      }

      releasedSkills.push({
        familyId,
        skillId,
        skillFile: resolve(bundleRoot, skillPath),
        releaseSupportPaths: Array.from(
          new Set([
            ...sharedRulebooks,
            ...(skill.releaseSupportPaths ?? [])
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ]),
        ),
      });
    }
  }

  return releasedSkills.sort((left, right) =>
    left.skillId.localeCompare(right.skillId),
  );
}

function bundleHasPath(
  bundle: Awaited<ReturnType<typeof loadReleaseSkillBundle>>,
  relativePath: string,
) {
  return bundle.files.some(
    (file) =>
      file.path === relativePath || file.path.startsWith(`${relativePath}/`),
  );
}

test('released skill docs stay aligned with the current PostPlus release contract', { skip: skillsRepoSkipReason }, async () => {
  const releasedSkills = await loadReleasedSkills();

  for (const skill of releasedSkills) {
    const text = await readFile(skill.skillFile, 'utf8');

    assert.match(
      text,
      /shared-release-shell-rules\.md/,
      `${skill.skillId} must reference the shared release-shell rules`,
    );

    for (const pattern of LEGACY_PATTERNS) {
      assert.doesNotMatch(
        text,
        pattern,
        `${skill.skillId} still contains legacy release-surface wording: ${pattern}`,
      );
    }

    assert.doesNotMatch(
      text,
      /^\s*node skills\//m,
      `${skill.skillId} must anchor script examples at the installed skill directory instead of repo-root skills/ paths`,
    );

    if (DOT_POSTPLUS_SKILLS.has(skill.skillId)) {
      assert.match(
        text,
        /\.postplus(?:\/|\b)/,
        `${skill.skillId} must document .postplus intermediate-state usage`,
      );
    }

    if (BOUNDED_FIRST_PASS_SKILLS.has(skill.skillId)) {
      assert.ok(
        [/first pass/i, /start small/i, /start with:/i, /bounded/i].some(
          (pattern) => pattern.test(text),
        ),
        `${skill.skillId} must document a bounded first pass`,
      );
    }

    if (FAIL_FAST_SKILLS.has(skill.skillId)) {
      assert.ok(
        [
          /stop immediately/i,
          /fail fast/i,
          /unauthorized/i,
          /stable network error/i,
          /stable capability/i,
          /capability is unavailable/i,
        ].some((pattern) => pattern.test(text)),
        `${skill.skillId} must document fail-fast hosted-boundary behavior`,
      );
    }

    if (AGENT_MANAGED_LOCAL_DEP_SKILLS.has(skill.skillId)) {
      assert.ok(
        [/proactively/i, /install/i, /host package/i, /version/i].every(
          (pattern) => pattern.test(text),
        ),
        `${skill.skillId} must document agent-managed local dependency installation`,
      );
    }
  }
});

test('released manifest and bundles cover the full released skill surface', { skip: skillsRepoSkipReason }, async () => {
  const releasedSkills = await loadReleasedSkills();
  const manifest = await loadReleaseManifest(skillsRepoRoot);

  assert.equal(
    manifest.skillCount,
    releasedSkills.length,
    'release manifest count must match the released registry surface',
  );

  for (const skill of releasedSkills) {
    const bundle = await loadReleaseSkillBundle({
      repoRoot: skillsRepoRoot,
      skillId: skill.skillId,
    });

    assert.ok(
      bundleHasPath(bundle, `skills/${skill.skillId}/SKILL.md`),
      `${skill.skillId} bundle must include its SKILL.md`,
    );

    for (const supportPath of skill.releaseSupportPaths) {
      assert.ok(
        bundleHasPath(bundle, supportPath),
        `${skill.skillId} bundle must include release support path ${supportPath}`,
      );
    }
  }
});

test('released skill families keep one verified success anchor and one degraded anchor', { skip: skillsRepoSkipReason }, async () => {
  const releasedSkills = await loadReleasedSkills();
  const releasedFamilyIds = Array.from(
    new Set(releasedSkills.map((skill) => skill.familyId)),
  ).sort();

  assert.deepEqual(
    Object.keys(RELEASED_FAMILY_VERIFICATION_COVERAGE).sort(),
    releasedFamilyIds,
    'every released family must declare one success anchor and one degraded anchor',
  );

  for (const familyId of releasedFamilyIds) {
    const coverage =
      RELEASED_FAMILY_VERIFICATION_COVERAGE[
        familyId as keyof typeof RELEASED_FAMILY_VERIFICATION_COVERAGE
      ];
    const familySkillIds = new Set(
      releasedSkills
        .filter((skill) => skill.familyId === familyId)
        .map((skill) => skill.skillId),
    );

    assert.equal(
      familySkillIds.has(coverage.successSkillId),
      true,
      `${familyId} success anchor must stay on a released skill`,
    );
    assert.equal(
      familySkillIds.has(coverage.degradedSkillId),
      true,
      `${familyId} degraded anchor must stay on a released skill`,
    );
  }
});
