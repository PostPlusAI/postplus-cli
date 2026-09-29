import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { diagnosticFetch } from './network-diagnostics.js';
import { runCommand, runInteractiveCommand } from './command-runner.js';

export type ManagedRelease = { cliVersion: string; skillsReleaseId: string };
type Installation = { node: string; cli: string; manager: string };
type Installed = { root: string; installation: Installation };

// Resolve from the package root in both the source tree and the release archive.
// These dependency-free modules also run in the bootstrap before CLI setup.
async function runtimeModule(name: string): Promise<any> {
  return import(new URL(`../runtime-manager/${name}.mjs`, import.meta.url).href);
}

export async function fetchManagedRelease(fetchFn: typeof fetch = diagnosticFetch): Promise<ManagedRelease> {
  return (await runtimeModule('distribution')).fetchRelease(fetchFn);
}

export async function resolveManagedInvocation(environment: NodeJS.ProcessEnv): Promise<{ executable: string; args: string[] }> {
  const root = environment.POSTPLUS_INSTALL_ROOT;
  if (!root || !isAbsolute(root)) throw new Error('PostPlus managed installation root is missing or invalid.');
  const state = await runtimeModule('state');
  const active: Installation | null = await state.readInstallation(root);
  if (!active) throw new Error('PostPlus managed installation is incomplete. Run the official installer to repair it.');
  return { executable: await state.resolveManagedFile(root, active.node), args: [await state.resolveManagedFile(root, active.cli)] };
}

export async function updateManagedInstallation(options: {
  environment: NodeJS.ProcessEnv;
  continuationArgs: string[];
  currentCliEntryPath: string | undefined;
  runInteractiveCommand?: typeof runInteractiveCommand;
  fetchFn?: typeof fetch;
}): Promise<{ exitCode: number; latestVersion: string }> {
  const root = options.environment.POSTPLUS_INSTALL_ROOT;
  if (!root || !isAbsolute(root) || !options.currentCliEntryPath) throw new Error('Cannot identify the PostPlus managed installation.');
  const inside = relative(await realpath(join(root, 'versions')), await realpath(options.currentCliEntryPath));
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('The running CLI does not belong to this PostPlus installation. No installation was changed.');
  }
  const fetchFn = options.fetchFn ?? diagnosticFetch;
  const release = await fetchManagedRelease(fetchFn);
  const env: NodeJS.ProcessEnv = { ...options.environment, POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION: release.cliVersion };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const { installRelease } = await runtimeModule('installation');
  return installRelease({ root, release, fetchFn,
    run: async (executable: string, args: string[]) => (await runCommand(executable, args, { env, timeoutMs: 300_000 })).stdout,
    afterActivate: async (installed: Installed) => ({ latestVersion: release.cliVersion,
      exitCode: await (options.runInteractiveCommand ?? runInteractiveCommand)(join(installed.root, installed.installation.node),
        [join(installed.root, installed.installation.cli), 'update', ...options.continuationArgs], { env }),
    }),
  });
}
