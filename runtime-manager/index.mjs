#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../build/command-runner.js';
import { PostPlusFailure, writeFailure } from '../build/failure-contract.js';
import { diagnosticFetch } from '../build/network-diagnostics.js';
import { fetchRelease, validateRelease } from './distribution.mjs';
import { registerCommandPath } from './path-registration.mjs';
import { defaultInstallRoot, installRelease } from './installation.mjs';

export async function setup({ release, root = defaultInstallRoot(), command = 'install', currentDirectory = false, programOnly = false, repair = false,
  cliArchive, nodeArchive, environment = process.env, fetchFn = diagnosticFetch }) {
  const env = { ...environment, POSTPLUS_INSTALL_ROOT: root };
  // Resolve the runtime we selected. User NODE_OPTIONS cannot redirect a managed
  // installation to injected modules or incompatible startup flags.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = async (executable, args) => (await runCommand(executable, args, { env, timeoutMs: 300_000 })).stdout;
  return installRelease({ release, root, fetchFn, run, cliArchive, nodeArchive, repair,
    afterActivate: async installed => {
      if (programOnly) {
        const pathRegistration = await registerCommandPath(installed.root);
        return { ok: true, command: 'prepare-program', installation: { managed: true, commandPath: installed.commandPath,
          cliVersion: release.cliVersion, nodeVersion: release.node.version, pathRegistration } };
      }
      let report;
      try {
        const result = await runCommand(join(installed.root, installed.installation.node),
          [join(installed.root, installed.installation.cli), command, '--json', ...(currentDirectory ? ['--current-directory'] : [])],
          { env: { ...env, POSTPLUS_INSTALL_ROOT: installed.root,
            POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION: release.cliVersion }, timeoutMs: 300_000 });
        report = JSON.parse(result.stdout);
        if (report.ok !== true) throw new Error('PostPlus skill setup did not return verified success.');
      } catch (cause) {
        throw new PostPlusFailure('PostPlus program is installed, but skill setup did not complete.', {
          code: 'postplus_skills_setup_incomplete', stage: 'skills-installation', service: 'local', retryable: false,
          action: `Use the installed command at ${installed.commandPath} to finish ${command}; the program update was preserved.`,
        }, { cause });
      }
      const pathRegistration = await registerCommandPath(installed.root);
      return { ...report, installation: { managed: true, commandPath: installed.commandPath,
        cliVersion: release.cliVersion, nodeVersion: release.node.version,
        reusedRuntime: installed.reusedNode, repairs: installed.repairs, pathRegistration,
        currentSessionAction: `Use ${installed.commandPath} for subsequent commands in this session; new shells will load the registered PATH.` },
        nextAction: report.session?.newSessionRequired ? report.session.action : 'Continue the user’s original task.' };
    },
  });
}

async function main(args) {
  const command = args.shift();
  if (!['install', 'update'].includes(command)) throw new Error('Use the official PostPlus installer, or postplus update.');
  const options = {};
  let currentDirectory = false;
  let programOnly = false;
  let repair = false;
  while (args.length) {
    const key = args.shift();
    if (key === '--repair') { repair = true; continue; }
    if (key === '--program-only') { programOnly = true; continue; }
    if (key === '--current-directory') { currentDirectory = true; continue; }
    if (!['--root', '--release-file', '--cli-archive', '--node-archive'].includes(key) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid PostPlus setup option.');
    if (key in options) throw new Error('Duplicate PostPlus setup option.');
    options[key] = args.shift();
  }
  const release = options['--release-file']
    ? validateRelease(JSON.parse(await readFile(resolve(options['--release-file']), 'utf8')))
    : await fetchRelease(diagnosticFetch);
  const report = await setup({ command, currentDirectory, programOnly, repair, release,
    root: options['--root'] || defaultInstallRoot(), cliArchive: options['--cli-archive'], nodeArchive: options['--node-archive'] });
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    writeFailure(error, { json: true, stage: 'managed-installation', helpCommand: 'Use the official PostPlus installer; do not change system Node.' });
    process.exitCode = 1;
  });
}
