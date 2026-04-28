import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type PostPlusInstallTargetId = 'claude-code' | 'codex' | 'codex-app';

export type PostPlusInstallTarget = {
  id: PostPlusInstallTargetId;
  label: string;
  skillsDir: string;
};

function resolveSkillsDirOverride(
  envVar:
    | 'POSTPLUS_CLAUDE_SKILLS_DIR'
    | 'POSTPLUS_CODEX_SKILLS_DIR'
    | 'POSTPLUS_CODEX_APP_SKILLS_DIR',
): string | null {
  const override = process.env[envVar]?.trim();
  return override && override.length > 0 ? resolve(override) : null;
}

function getClaudeSkillsDir(): string {
  return (
    resolveSkillsDirOverride('POSTPLUS_CLAUDE_SKILLS_DIR') ??
    join(homedir(), '.claude', 'skills')
  );
}

function getCodexSkillsDir(): string {
  return (
    resolveSkillsDirOverride('POSTPLUS_CODEX_SKILLS_DIR') ??
    join(homedir(), '.agents', 'skills')
  );
}

function getCodexAppSkillsDir(): string {
  const override = resolveSkillsDirOverride('POSTPLUS_CODEX_APP_SKILLS_DIR');
  if (override) {
    return override;
  }

  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome && codexHome.length > 0) {
    return resolve(codexHome, 'skills');
  }

  return join(homedir(), '.codex', 'skills');
}

export function getInstallTargets(): PostPlusInstallTarget[] {
  const targets: PostPlusInstallTarget[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      skillsDir: getClaudeSkillsDir(),
    },
    {
      id: 'codex',
      label: 'Codex',
      skillsDir: getCodexSkillsDir(),
    },
    {
      id: 'codex-app',
      label: 'Codex App',
      skillsDir: getCodexAppSkillsDir(),
    },
  ];

  const uniqueDirs = new Set(targets.map((target) => target.skillsDir));
  if (uniqueDirs.size !== targets.length) {
    throw new Error(
      'PostPlus install targets must resolve to different skills directories.',
    );
  }

  return targets;
}
