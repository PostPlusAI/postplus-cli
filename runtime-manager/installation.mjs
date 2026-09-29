import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareArtifact } from './artifacts.mjs';
import { activateInstallation, readInstallation, verifyInstallation, withInstallationLock } from './state.mjs';
import { selectNodeArtifact, validateRelease } from './distribution.mjs';

export function defaultInstallRoot(environment = process.env) {
  return resolve(environment.POSTPLUS_INSTALL_ROOT || (process.platform === 'win32'
    ? join(environment.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'PostPlus')
    : join(environment.XDG_DATA_HOME || join(homedir(), '.local/share'), 'postplus')));
}

async function writeLauncher(root, source, name) {
  const target = join(root, 'bin', name);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, await readFile(new URL(source, import.meta.url)), { mode: 0o755, flag: 'wx' });
  try { await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}

export async function installRelease({ release, root, fetchFn, run, cliArchive, nodeArchive, afterActivate, repair = false }) {
  validateRelease(release);
  root = resolve(root);
  return withInstallationLock(root, async () => {
    root = await realpath(root);
    let previous;
    const repairs = [];
    try { previous = await readInstallation(root); }
    catch (error) {
      if (!repair) throw error;
      previous = null;
      repairs.push({ component: 'installation-record', reason: error.message });
    }
    const artifact = selectNodeArtifact(release);
    let nodeDirectory = `runtimes/node-v${release.node.version}-${process.platform}-${process.arch}-${artifact.sha256.slice(0, 12)}`;
    let cliDirectory = `versions/${release.cliVersion}/${release.cli.sha256}`;
    // A prior explicit repair may have selected a fresh generation of these
    // same approved bytes. Reuse that generation only after full verification.
    const nodeSuffix = process.platform === 'win32' ? '/node.exe' : '/bin/node';
    if (previous?.node.startsWith(nodeDirectory + '-repair-') && previous.node.endsWith(nodeSuffix)) {
      nodeDirectory = previous.node.slice(0, -nodeSuffix.length);
    }
    if (previous?.cli.startsWith(cliDirectory + '-repair-') && previous.cli.endsWith('/build/index.js')) {
      cliDirectory = previous.cli.slice(0, -'/build/index.js'.length);
    }
    const nodeResult = await prepareArtifact(root, artifact, join(root, nodeDirectory), fetchFn, nodeArchive, { repair });
    const cliResult = await prepareArtifact(root, release.cli, join(root, cliDirectory), fetchFn, cliArchive, { repair });
    nodeDirectory = relative(root, nodeResult.directory).replaceAll('\\', '/');
    cliDirectory = relative(root, cliResult.directory).replaceAll('\\', '/');
    for (const [component, result] of [['runtime', nodeResult], ['program', cliResult]]) {
      if (result.repaired) repairs.push({ component, reason: result.repairReason });
    }
    const pkg = JSON.parse(await readFile(join(cliResult.directory, 'package.json'), 'utf8'));
    const skills = JSON.parse(await readFile(join(cliResult.directory, 'bundled-skills/skills-manifest.json'), 'utf8'));
    if (pkg.name !== '@postplus/cli' || pkg.version !== release.cliVersion || skills.releaseId !== release.skillsReleaseId) {
      throw new Error('PostPlus package and skill identities do not match the approved release.');
    }
    const installation = {
      cliVersion: release.cliVersion, nodeVersion: release.node.version,
      node: `${nodeDirectory}/${process.platform === 'win32' ? 'node.exe' : 'bin/node'}`,
      cli: `${cliDirectory}/build/index.js`, manager: `${cliDirectory}/runtime-manager/index.mjs`,
    };
    await verifyInstallation(root, installation, run);
    await mkdir(join(root, 'bin'), { recursive: true });
    if (process.platform === 'win32') {
      await writeLauncher(root, './launch.ps1', 'postplus.ps1');
      await writeLauncher(root, './launch.cmd', 'postplus.cmd');
    } else {
      await writeLauncher(root, './launch.sh', 'postplus');
      await chmod(join(root, 'bin/postplus'), 0o755);
    }
    // The active record is the only switch. Existing commands retain their
    // immutable files; no old program/runtime directory is deleted here.
    await activateInstallation(root, installation, run);
    const result = { root, installation, previous, repairs, reusedNode: nodeResult.reused,
      reusedCli: cliResult.reused, commandPath: join(root, 'bin', process.platform === 'win32' ? 'postplus.cmd' : 'postplus') };
    return afterActivate ? afterActivate(result) : result;
  });
}
