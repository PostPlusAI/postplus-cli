import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

// The launcher and updater share this small, non-executable record. A newline
// format lets the first launcher read it without system Node, jq, or eval.
const HEADER = 'postplus-installation-v1';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function encodeInstallation(value) {
  if (!value || !VERSION.test(value.cliVersion) || !VERSION.test(value.nodeVersion)) {
    throw new Error('Invalid PostPlus installation version.');
  }
  for (const key of ['node', 'cli', 'manager']) {
    const path = value[key];
    if (typeof path !== 'string' || isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid managed ${key} path.`);
    }
  }
  if (!value.node.startsWith(`runtimes/node-v${value.nodeVersion}-`) ||
      !value.cli.startsWith(`versions/${value.cliVersion}/`) ||
      !value.manager.startsWith(`versions/${value.cliVersion}/`)) {
    throw new Error('Managed paths do not match the installation versions.');
  }
  return [HEADER, value.cliVersion, value.nodeVersion, value.node, value.cli, value.manager, ''].join('\n');
}

export function decodeInstallation(text) {
  const lines = text.split('\n');
  if (lines.length !== 7 || lines[0] !== HEADER || lines[6] !== '') {
    throw new Error('Invalid PostPlus installation record. Run the official installer to repair it.');
  }
  const value = { cliVersion: lines[1], nodeVersion: lines[2], node: lines[3], cli: lines[4], manager: lines[5] };
  encodeInstallation(value);
  return value;
}

export async function readInstallation(root) {
  try { return decodeInstallation(await readFile(join(root, 'active'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveManagedFile(root, path) {
  const realRoot = await realpath(root);
  const target = join(realRoot, path);
  const info = await lstat(target);
  const resolved = await realpath(target);
  const inside = relative(realRoot, resolved);
  if (info.isSymbolicLink() || !info.isFile() || !inside || inside === '..' ||
      inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('PostPlus managed file is missing, linked outside its installation, or not a regular file.');
  }
  return resolved;
}

export async function verifyInstallation(root, value, run) {
  encodeInstallation(value);
  const node = await resolveManagedFile(root, value.node);
  const cli = await resolveManagedFile(root, value.cli);
  await resolveManagedFile(root, value.manager);
  const nodeVersion = await run(node, ['--version']);
  if (nodeVersion.trim() !== `v${value.nodeVersion}`) throw new Error('PostPlus Node version verification failed.');
  const cliVersion = await run(node, [cli, '--version']);
  if (cliVersion.trim() !== value.cliVersion) throw new Error('PostPlus CLI version verification failed.');
}

export async function activateInstallation(root, value, run) {
  // Callers hold the installation lock. Do not write the active record until
  // both real executables have passed verification.
  await verifyInstallation(root, value, run);
  const temp = join(root, `.active-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(encodeInstallation(value));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temp, join(root, 'active')); }
  finally { await rm(temp, { force: true }); }
}

export async function withInstallationLock(root, action, options = {}) {
  // Share the CLI's tested lock ownership, timeout, and interrupted-child rules.
  const { withPostPlusUpdateLock } = await import('../build/local-state.js');
  return withPostPlusUpdateLock(action, { ...options, installationRoot: root });
}
