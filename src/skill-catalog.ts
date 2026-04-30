export const POSTPLUS_SKILLS_REPO = 'PostPlusAI/postplus-skills';
export const POSTPLUS_SKILLS_AGENT_TARGETS = [
  'claude-code',
  'codex',
  'cursor',
  'github-copilot',
  'windsurf',
  'trae',
  'trae-cn',
] as const;
const POSTPLUS_SKILLS_AGENT_ARGS = POSTPLUS_SKILLS_AGENT_TARGETS.join(' ');
export const POSTPLUS_SKILLS_INSTALL_COMMAND =
  `npx -y skills add PostPlusAI/postplus-skills --full-depth --skill '*' --agent ${POSTPLUS_SKILLS_AGENT_ARGS} --yes`;
export const POSTPLUS_SKILLS_LIST_COMMAND =
  'npx -y skills add PostPlusAI/postplus-skills --list --full-depth';

const POSTPLUS_SKILLS_INDEX_URL =
  'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/INDEX.md';

export type PublicSkillCatalogEntry = {
  skillId: string;
  path: string | null;
};

export type PublicSkillCatalogReport = {
  source: string;
  indexUrl: string;
  installCommand: string;
  listCommand: string;
  skills: PublicSkillCatalogEntry[];
};

export async function loadPublicSkillCatalog(): Promise<PublicSkillCatalogReport> {
  const response = await fetch(POSTPLUS_SKILLS_INDEX_URL, {
    headers: {
      accept: 'text/markdown,text/plain',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to load PostPlus skill catalog (${response.status}): ${response.statusText}`,
    );
  }

  const indexText = await response.text();
  const skills = parseSkillIndex(indexText);

  if (skills.length === 0) {
    throw new Error(
      'PostPlus public skill catalog is invalid: no released skills were found.',
    );
  }

  return {
    source: POSTPLUS_SKILLS_REPO,
    indexUrl: POSTPLUS_SKILLS_INDEX_URL,
    installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
    listCommand: POSTPLUS_SKILLS_LIST_COMMAND,
    skills,
  };
}

function parseSkillIndex(indexText: string): PublicSkillCatalogEntry[] {
  const skills: PublicSkillCatalogEntry[] = [];
  let inReleasedSkills = false;
  let sawReleasedSkillsSection = false;
  let currentSkill: string | null = null;

  for (const line of indexText.split('\n')) {
    if (line.trim() === '## Released Skills') {
      inReleasedSkills = true;
      sawReleasedSkillsSection = true;
      continue;
    }

    if (!inReleasedSkills) {
      continue;
    }

    const skillMatch = line.match(/^- `([^`]+)`\s*$/);
    if (skillMatch) {
      currentSkill = skillMatch[1] ?? null;
      if (currentSkill) {
        skills.push({
          skillId: currentSkill,
          path: null,
        });
      }
      continue;
    }

    const pathMatch = line.match(/^\s+- Path: `([^`]+)`\s*$/);
    if (pathMatch && currentSkill) {
      const last = skills.at(-1);
      if (last?.skillId === currentSkill) {
        last.path = pathMatch[1] ?? null;
      }
    }
  }

  if (!sawReleasedSkillsSection) {
    throw new Error(
      'PostPlus public skill catalog is invalid: missing ## Released Skills section.',
    );
  }

  return skills;
}
