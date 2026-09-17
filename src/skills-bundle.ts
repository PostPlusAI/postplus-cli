import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_SKILLS_ROOT = fileURLToPath(new URL('../bundled-skills/', import.meta.url));
export const SKILLS_INSTALLER_PACKAGE = 'skills@1.5.26';

export class SkillsBundleError extends Error {
  readonly code = 'postplus_skills_bundle_invalid';
  readonly stage = 'skills_bundle';
  readonly service = 'local';
  readonly retryable = false;
  readonly action = 'Reinstall PostPlus CLI from the official package.';
}

export type SkillsManifest = {
  schemaVersion: 1;
  releaseId: string;
  skills: Array<{ name: string; path: string; contentHash: string }>;
};

// Length framing makes paths and arbitrary binary contents unambiguous. Sorting
// uses code units, never locale-dependent ordering, on both release and runtime.
export async function hashSkillDirectory(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new SkillsBundleError('Skill content contains a symbolic link or special file.');
    }
  }
  await visit('');
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    const contents = await readFile(join(root, path));
    hash.update(path).update('\0').update(String(contents.length)).update('\0').update(contents);
  }
  return hash.digest('hex');
}

export async function readSkillsManifest(root = BUNDLED_SKILLS_ROOT): Promise<SkillsManifest> {
  try {
    const value = JSON.parse(await readFile(join(root, 'skills-manifest.json'), 'utf8'));
    if (value?.schemaVersion !== 1 || typeof value.releaseId !== 'string' ||
        !value.releaseId.trim() || !Array.isArray(value.skills) || !value.skills.length) {
      throw new Error('Invalid manifest metadata.');
    }
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const skill of value.skills) {
      if (typeof skill?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(skill.name) ||
          typeof skill.path !== 'string' || !skill.path.startsWith('skills/') ||
          !skill.path.endsWith('/SKILL.md') || skill.path.split('/').some((part: string) => !part || part === '.' || part === '..') ||
          skill.path.includes('\\') || !/^[a-f0-9]{64}$/.test(skill.contentHash) ||
          names.has(skill.name) || paths.has(skill.path)) throw new Error('Invalid manifest skill.');
      names.add(skill.name); paths.add(skill.path);
      let location = resolve(root);
      for (const part of skill.path.split('/')) {
        location = join(location, part);
        if ((await lstat(location)).isSymbolicLink()) throw new Error('Bundle contains a symbolic link.');
      }
      if (await hashSkillDirectory(dirname(location)) !== skill.contentHash) throw new Error(`Bundle content mismatch: ${skill.name}.`);
    }
    return value as SkillsManifest;
  } catch (cause) {
    throw new SkillsBundleError('The bundled PostPlus skills are missing or damaged.', { cause });
  }
}
