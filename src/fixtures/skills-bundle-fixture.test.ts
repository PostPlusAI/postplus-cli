import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashSkillDirectory } from "../skills-bundle.js";

export const INSTALLER_LABELS = [
  "Claude Code",
  "Codex",
  "Cursor",
  "GitHub Copilot",
  "Windsurf",
  "Trae",
  "Trae CN",
  "OpenClaw",
  "Hermes Agent",
];
export const OFFICIAL_SKILL_CONTENT = "official skill\n";

export async function writeFixtureBundle(
  root: string,
  catalog: {
    releaseId: string;
    skills: Array<{ name: string; path: string; status?: string }>;
    [key: string]: unknown;
  },
) {
  const skills = [];
  for (const entry of catalog.skills.filter(
    (skill) =>
      skill.status === "released" || skill.status?.startsWith("released/"),
  )) {
    const path = join(root, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, OFFICIAL_SKILL_CONTENT);
    skills.push({
      name: entry.name,
      path: entry.path,
      contentHash: await hashSkillDirectory(dirname(path)),
    });
  }
  await mkdir(join(root, "skills"), { recursive: true });
  await writeFile(join(root, "skills/catalog.json"), JSON.stringify(catalog));
  await writeFile(
    join(root, "skills-manifest.json"),
    JSON.stringify({ schemaVersion: 1, releaseId: catalog.releaseId, skills }),
  );
  return Object.fromEntries(
    skills.map((entry) => [entry.name, entry.contentHash]),
  );
}

export async function writeInstalledFixture(
  path: string,
  content = OFFICIAL_SKILL_CONTENT,
) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), content);
  return hashSkillDirectory(path);
}

// Fixture adapter ABI: IDs are declared with the fixture labels, not inferred by PostPlus.
const fixtureAgentIds = ['claude-code', 'codex', 'cursor', 'github-copilot', 'windsurf', 'trae', 'trae-cn', 'openclaw', 'hermes-agent'];
export function serializeInstallerEntries(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('scope' in entry) || !('agents' in entry) || !('path' in entry) || 'directories' in entry) return entry;
    let realPath: string;
    try { realPath = realpathSync(entry.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; realPath = resolve(entry.path); }
    return { ...entry, directories: [{ path: entry.path, realPath, directoryName: entry.name, metadataName: entry.name, metadataError: null, agentIds: entry.agents.map((label: string) => fixtureAgentIds[INSTALLER_LABELS.indexOf(label)]).filter(Boolean) }] };
  });
}
