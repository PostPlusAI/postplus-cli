import type { PostPlusInstallTargetId } from './skills-targets.js';
import type { ReleaseManifestSkill } from './postplus-release.js';

import { loadHostedReleaseManifestSource } from './release-source.js';

export type GuidedInstallReport = {
  ok: true;
  prompt: string;
  sourceKind: 'hosted-release';
  sourceRef: string;
  targets: PostPlusInstallTargetId[];
  selectedSkillIds: string[];
  installCommand: string;
  verifyCommand: string;
};

function selectManifestEntries<T extends { skillId: string }>(
  entries: T[],
  skillIds?: string[],
): T[] {
  const selectedSkillIds =
    skillIds && skillIds.length > 0 ? new Set(skillIds) : null;
  const selectedEntries = selectedSkillIds
    ? entries.filter((entry) => selectedSkillIds.has(entry.skillId))
    : entries;

  if (selectedSkillIds) {
    const missing = [...selectedSkillIds].filter(
      (skillId) => !selectedEntries.some((entry) => entry.skillId === skillId),
    );

    if (missing.length > 0) {
      throw new Error(`Unknown skill ids: ${missing.join(', ')}`);
    }
  }

  return selectedEntries;
}

function buildInstallCommand(skillIds: string[]): string {
  return skillIds.length > 0
    ? `postplus install ${skillIds.join(' ')}`
    : 'postplus install';
}

function buildPrompt(input: {
  installCommand: string;
  selectedSkillIds: string[];
}): string {
  const scope =
    input.selectedSkillIds.length > 0
      ? `for these skills: ${input.selectedSkillIds.join(', ')}`
      : 'for the current released skill set';

  return [
    'Run the official PostPlus CLI install contract for Claude Code, Codex, and the Codex app on this machine.',
    `Install scope: ${scope}.`,
    `1. Execute \`${input.installCommand}\`.`,
    '2. Execute `postplus status`.',
    '3. If a command fails, stop and report the exact error.',
    '4. Do not copy skill directories manually, invent fallback installs, or rewrite the install flow.',
  ].join('\n');
}

export async function generateGuidedInstallReport(input: {
  skillIds?: string[];
}): Promise<GuidedInstallReport> {
  const source = await loadHostedReleaseManifestSource();
  const selectedEntries = selectManifestEntries<ReleaseManifestSkill>(
    source.manifest.skills,
    input.skillIds,
  );
  const explicitSkillIds = input.skillIds ?? [];
  const selectedSkillIds = selectedEntries.map((entry) => entry.skillId);
  const installCommand = buildInstallCommand(explicitSkillIds);

  return {
    ok: true,
    prompt: buildPrompt({
      installCommand,
      selectedSkillIds,
    }),
    sourceKind: source.kind,
    sourceRef: source.baseUrl,
    targets: ['claude-code', 'codex', 'codex-app'],
    selectedSkillIds,
    installCommand,
    verifyCommand: 'postplus status',
  };
}

export function formatGuidedInstallReport(report: GuidedInstallReport): string {
  return [
    'PostPlus CLI guided install',
    '',
    `Catalog: ${report.sourceRef}`,
    `Targets: ${report.targets.join(', ')}`,
    `Selected skills: ${report.selectedSkillIds.join(', ') || 'all released skills'}`,
    `Install command: ${report.installCommand}`,
    `Verify command: ${report.verifyCommand}`,
    '',
    'Prompt:',
    report.prompt,
  ].join('\n');
}
