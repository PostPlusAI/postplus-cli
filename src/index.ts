#!/usr/bin/env node
import { formatSkillDiscovery } from './skill-discovery.js';
import { PostPlusFailure, writeFailure, toFailureFact, formatFailure } from './failure-contract.js';
import { buildVerbTargetIndex } from './hosted-manifest-index.js';
import { readFile } from 'node:fs/promises';

import {
  formatAuthRefreshReport,
  refreshRemoteAuth,
  revokeRemoteAuthAndReport,
} from './auth-lifecycle.js';
import { loginWithCloudHandoff } from './auth-login.js';
import {
  formatAuthValidateReport,
  validateRemoteAuth,
} from './auth-validate.js';
import {
  clearAuthState,
  formatAuthStatusReport,
  generateAuthStatusReport,
} from './auth.js';
import {
  PostPlusClientUpgradeRequiredError,
  readCurrentCliVersion,
  writeCurrentCliVersionToLocalConfig,
} from './client-compatibility.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import {
  runBalanceCommand,
  runRunsCommand,
} from './hosted-account-commands.js';
import {
  runHostedDomainCommand,
  runMediaFileCommand,
} from './hosted-domain-commands.js';
import { assertConfigFilePermissions } from './local-state.js';
import {
  QUOTE_AUTO_CONFIRM_UNDER_ENV,
  QuoteAutoConfirmCeilingExceededError,
  QuoteConfirmationNonInteractiveError,
  confirmLargeCreditQuote,
  readLargeCreditQuoteConfirmationChallenge,
  resolveLargeCreditQuoteConfirmation,
} from './quote-confirmation.js';
import {
  type PostPlusSkillsInstallScope,
  formatPostPlusSkillsInstallCommand,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import {
  POSTPLUS_SKILLS_SESSION_ACTION,
  formatSkillBaselineVerifyReport,
  runPostPlusSkillUninstall,
  runPostPlusSkillUpdate,
  runPostPlusSkillVerify,
} from './skill-management.js';
import { formatStatusReport, generateStatusReport } from './status.js';
import { resolvePostPlusSkillsScope } from './skill-installation.js';
import { runStudioCommand } from './studio.js';
import {
  POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV,
  clearUpdateCheckCache,
  resolvePostPlusUpdatePlan,
  runCliSelfUpdateIfOutdated,
  runPostPlusClientUpgradeRecovery,
} from './update-check.js';

function printAuthHelp(): void {
  process.stdout.write(`PostPlus CLI — auth commands
Manage the selected account session. Help does not sign in or change credentials.

Usage:
  postplus auth login [--no-browser]  Sign in with your PostPlus account in a browser
  postplus auth status         Show current auth state (tokens, account, expiry)
  postplus auth validate       Validate the current session against PostPlus Cloud
  postplus auth refresh        Refresh the current session tokens
  postplus auth revoke         Revoke the current session on PostPlus Cloud
  postplus auth logout         Clear local auth state

Options:
  --no-browser  Print the login URL without opening a browser (login only)
  --json        Output results as JSON (status, validate, refresh, revoke, logout)

Examples:
  postplus auth login
  postplus auth status --json

Next: Use postplus auth validate to check the session remotely, or postplus doctor to inspect readiness.
Run \`postplus help\` for all commands.
`);
}

async function printHelp(): Promise<void> {
  // Discovery uses this package only, even when runtime catalog overrides exist.
  const catalog = await loadPublicSkillCatalog(undefined, {});
  process.stdout.write(`PostPlus CLI
${catalog.productBrief?.paragraphs[0] ?? 'Install and maintain PostPlus skills, inspect readiness, and run supported tasks.'}
Start: postplus install → postplus list → describe the result you want to your agent.
Use postplus <command> --help, -h, or postplus help <command> [subcommand].

Usage:
  postplus auth login [--no-browser]
  postplus auth refresh [--json]
  postplus auth revoke [--json]
  postplus auth status [--json]
  postplus auth validate [--json]
  postplus auth logout [--json]
  postplus doctor [--skill <skill-id>] [--json]
  postplus balance [--json]
  postplus runs list [--status <status>] [--since <iso>] [--limit <n>] [--json]
  postplus runs show <run-id> [--json]
  postplus research schema [--route <route>] [--json]
  postplus research run <route> --<semantic flags> --wait --output <result.json>
  postplus research run --resume-from <result.json> [--wait-seconds <n>] [--poll-interval-seconds <n>] [--json]
  postplus media schema [--endpoint <endpoint-key>] [--json]
  postplus media <verb> <endpoint-key> --<role/intent flags> [--wait] [--output <result.json>]
  postplus media estimate <endpoint-key> --<same flags> [--json]
  postplus media poll --handle <run-id> [--wait-seconds <n>] [--poll-interval-seconds <n>] [--debug] [--json] [--output <result.json>]
  postplus media-file upload --input-file <path> [--mime <type>] [--skill <skill-id>] [--json] [--output <result.json>]
  postplus media-file download (--reference <postplus-media://...> | --url <https://...>) --output-file <path> [--skill <skill-id>] [--debug] [--json] [--output <result.json>]
  postplus publish schema [--json]
  postplus publish <operation> --request <input.json> [--output <result.json>]
  postplus studio init|open|status   Open bundled Local Studio
  postplus quote confirm --json --challenge-file <path> [--auto-confirm-under <credits>]
  postplus skills verify [--json]
  postplus install [--current-directory]
  postplus update [--current-directory]
  postplus uninstall [--current-directory]
  postplus list [--json]
  postplus status [--skill <skill-id>] [--json]
  postplus version
  postplus help

First-time setup:
  postplus install
  postplus list
  Follow the returned session action, then describe the result you want to your agent.
  Sign in with postplus auth login only when the chosen task requests authentication.

To keep Skills inside the current project:
  postplus install --current-directory

Next: Use postplus status for an overview, or postplus doctor after a readiness failure.
`);
}

type DiagnosticCommandOptions = {
  json: boolean;
  skillId?: string;
};

async function runDoctor(options: DiagnosticCommandOptions): Promise<number> {
  const report = await generateDoctorReport({ skillId: options.skillId });

  if (options.json) {
    writeJson(report);
  } else if (!report.requiredOk) {
    const failed = report.checks.find((check) => check.status === 'fail' && check.severity === 'required')!;
    process.stderr.write(`${formatFailure(failed.failure ?? toFailureFact(new PostPlusFailure(failed.detail, { code: 'postplus_readiness_blocked', action: failed.fix }))) }\n`);
  } else {
    process.stdout.write(`${formatDoctorReport(report)}\n`);
  }

  return report.requiredOk ? 0 : 1;
}

async function runAuthStatus(json: boolean): Promise<number> {
  const report = await generateAuthStatusReport();

  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
  }

  return report.ok ? 0 : 1;
}

async function runStatus(options: DiagnosticCommandOptions): Promise<number> {
  const report = await generateStatusReport({ skillId: options.skillId });

  if (options.json) {
    writeJson(report);
  } else if (!report.ok) {
    const failed = report.doctor.checks.find((check) => check.status === 'fail' && check.severity === 'required');
    process.stderr.write(`${formatFailure(failed?.failure ?? toFailureFact(new PostPlusFailure(failed?.detail ?? 'PostPlus is not ready.', { code: 'postplus_readiness_blocked', action: failed?.fix ?? 'Run postplus status --json to identify the blocked component.' }))) }\n`);
  } else {
    process.stdout.write(`${formatStatusReport(report)}\n`);
  }

  return report.ok ? 0 : 1;
}

async function runList(json: boolean): Promise<number> {
  const catalog = await loadPublicSkillCatalog();

  if (json) {
    writeJson(catalog);
    return 0;
  }

  process.stdout.write(`${formatSkillDiscovery(catalog)}\n`);

  return 0;
}

async function runVersion(): Promise<number> {
  process.stdout.write(`${await readCurrentCliVersion()}\n`);
  return 0;
}

async function runSkillUpdateCommand(rest: string[]): Promise<number> {
  if (rest.some(isHelpArg)) return printSkillMutationHelp('update', rest.includes('--json'));
  const options = parseSkillMutationOptions(rest, 'update');
  const updatePlan = resolvePostPlusUpdatePlan();
  const scope = updatePlan.skills && !rest.includes('--current-directory')
    ? await resolvePostPlusSkillsScope()
    : options.scope;

  if (updatePlan.cli) {
    const cliSelfUpdate = await runCliSelfUpdateIfOutdated({
      continuationArgs: scope === 'current-directory' && !rest.includes('--current-directory') ? [...rest, '--current-directory'] : rest,
      quiet: updatePlan.implicitRecovery || options.json,
    });

    if (cliSelfUpdate.failure) {
      throw new PostPlusFailure(cliSelfUpdate.failure.message, cliSelfUpdate.failure, { cause: new Error(`npm installation exited with code ${cliSelfUpdate.exitCode}.`) });
    }
    if (cliSelfUpdate.updateAvailable) {
      return cliSelfUpdate.exitCode ?? 1;
    }
  }

  if (!updatePlan.skills) {
    await writeCurrentCliVersionToLocalConfig();
    await clearUpdateCheckCache();
    if (options.json) writeJson({ ok: true, command: 'update', components: ['cli'] });
    return 0;
  }

  return runPostPlusSkillUpdate(undefined, {
    ...options,
    messageMode: updatePlan.implicitRecovery ? 'implicit' : 'explicit',
    scope,
  });
}

async function runSkillInstallCommand(rest: string[]): Promise<number> {
  if (rest.some(isHelpArg)) return printSkillMutationHelp('install', rest.includes('--json'));
  const options = parseSkillMutationOptions(rest, 'install');

  return runPostPlusSkillUpdate(undefined, {
    ...options,
    command: 'install',
    messageMode: 'explicit',
    scope: options.scope,
  });
}

async function runSkillUninstallCommand(rest: string[]): Promise<number> {
  if (rest.some(isHelpArg)) return printSkillMutationHelp('uninstall', rest.includes('--json'));
  const options = parseSkillMutationOptions(rest, 'uninstall');

  return runPostPlusSkillUninstall(undefined, {
    ...options,
    scope: options.scope,
  });
}

async function runSkillsCommand(rest: string[]): Promise<number> {
  if (rest[0] === 'verify' && rest.slice(1).some(isHelpArg)) return runSkillsCommand(['help']);
  const [subcommand] = rest;

  switch (subcommand) {
    case 'verify': {
      const options = rest.slice(1);
      const unknownOption = options.find((option) => option !== '--json');

      if (unknownOption) {
        throw new Error(`Unknown option for skills verify: ${unknownOption}`);
      }

      const report = await runPostPlusSkillVerify();

      if (options.includes('--json')) {
        writeJson(report);
      } else {
        process.stdout.write(
          `${formatSkillBaselineVerifyReport(report)}\n`,
        );
      }

      return report.ok ? 0 : 1;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`PostPlus CLI — skills commands

Usage:
  postplus skills verify [--json]  Check installed public skills against their verified release

Options:
  --json    Output results as JSON
  --help, -h  Show help without verifying files

Examples:
  postplus skills verify
  postplus skills verify --json

Next: Follow the reported action; use postplus install to repair from this CLI's bundled skills.

Install scope:
  postplus install                      Repair global skills from the local bundle
  postplus install --current-directory  Repair current project skills from the local bundle
  postplus update                       Update current project Skills when present, otherwise global
  postplus update --current-directory   Update PostPlus skills in the current directory
  postplus uninstall                    Remove global PostPlus skills
  postplus uninstall --current-directory  Remove PostPlus skills from the current directory

Local changes:
  Interactive updates ask to back up locally modified managed skills before replacing them.
  Non-interactive updates stop before replacing local changes unless --yes explicitly authorizes backup and replacement.
  --json changes output only; it does not authorize replacement.
`);
      return 0;
    default:
      throw new Error(`Unknown command: skills ${subcommand}`);
  }
}

async function runQuoteCommand(rest: string[]): Promise<number> {
  if (!rest.length || isHelpArg(rest[0]!) || (rest[0] === 'confirm' && rest.some(isHelpArg))) return printQuoteHelp();
  const [subcommand, ...options] = rest;

  if (subcommand !== 'confirm') {
    throw new Error(`Unknown command: quote ${subcommand}`);
  }

  const parsed = parseQuoteConfirmOptions(options);

  if (!parsed.json) {
    throw new Error('quote confirm requires --json.');
  }

  if (!parsed.challengeFile) {
    throw new Error('quote confirm requires --challenge-file.');
  }

  const challenge = readLargeCreditQuoteConfirmationChallenge(
    JSON.parse(await readFile(parsed.challengeFile, 'utf8')),
  );

  if (!challenge) {
    process.stderr.write(
      'Invalid large credit quote confirmation challenge.\n',
    );
    return 1;
  }

  const ceilingMillicredits = resolveQuoteAutoConfirmCeiling(
    parsed.autoConfirmUnder,
  );

  try {
    writeJson(
      await resolveLargeCreditQuoteConfirmation(challenge, {
        confirm: confirmLargeCreditQuote,
        ceilingMillicredits,
      }),
    );
  } catch (error) {
    if (
      error instanceof QuoteAutoConfirmCeilingExceededError ||
      error instanceof QuoteConfirmationNonInteractiveError
    ) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }

    throw error;
  }

  return 0;
}

/**
 * Resolves the public credit ceiling into internal ledger units. Precedence:
 * explicit --auto-confirm-under flag, then the
 * POSTPLUS_QUOTE_AUTO_CONFIRM_UNDER_CREDITS env var. Returns null when
 * neither is set, leaving today's interactive behavior unchanged.
 */
function resolveQuoteAutoConfirmCeiling(
  flagValue: number | null,
): number | null {
  if (flagValue !== null) {
    return Math.round(flagValue * 1_000);
  }

  const envValue = process.env[QUOTE_AUTO_CONFIRM_UNDER_ENV];
  if (envValue === undefined || envValue.trim() === '') {
    return null;
  }

  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid ${QUOTE_AUTO_CONFIRM_UNDER_ENV}: expected a non-negative number of PostPlus credits.`,
    );
  }

  return Math.round(parsed * 1_000);
}

function parseQuoteConfirmOptions(args: string[]): {
  autoConfirmUnder: number | null;
  challengeFile: string | null;
  json: boolean;
} {
  const options = {
    autoConfirmUnder: null as number | null,
    challengeFile: null as string | null,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--challenge-file') {
      const challengeFile = args[index + 1];

      if (!challengeFile || challengeFile.startsWith('--')) {
        throw new Error('Missing value for --challenge-file.');
      }

      options.challengeFile = challengeFile;
      index += 1;
      continue;
    }

    if (arg === '--auto-confirm-under') {
      const rawValue = args[index + 1];

      if (!rawValue || rawValue.startsWith('--')) {
        throw new Error('Missing value for --auto-confirm-under.');
      }

      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          'Invalid value for --auto-confirm-under: expected a non-negative number of PostPlus credits.',
        );
      }

      options.autoConfirmUnder = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for quote confirm: ${arg}`);
  }

  return options;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isHelpArg(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

function parseDiagnosticOptions(args: string[]): DiagnosticCommandOptions {
  const options: DiagnosticCommandOptions = {
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--skill') {
      const skillId = args[index + 1];

      if (!skillId || skillId.startsWith('--')) {
        throw new Error('Missing value for --skill.');
      }

      options.skillId = skillId;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for diagnostics command: ${arg}`);
  }

  return options;
}

function parseSkillMutationOptions(
  args: string[],
  commandName: 'install' | 'update' | 'uninstall',
): { scope: PostPlusSkillsInstallScope; json: boolean; yes: boolean } {
  let json = false;
  let yes = false;
  let scope: PostPlusSkillsInstallScope = 'global';

  for (const arg of args) {
    if (arg === '--json') { json = true; continue; }
    if (arg === '--yes') { yes = true; continue; }
    if (arg === '--current-directory') {
      scope = 'current-directory';
      continue;
    }

    throw new Error(`Unknown option for ${commandName}: ${arg}`);
  }

  return { scope, json, yes };
}

async function runAuthLogout(json: boolean): Promise<number> {
  const report = await clearAuthState();
  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
  }
  return 0;
}

async function runAuthRefresh(json: boolean): Promise<number> {
  const report = await refreshRemoteAuth();
  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatAuthRefreshReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

async function runAuthRevoke(json: boolean): Promise<number> {
  const report = await revokeRemoteAuthAndReport();
  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
  }
  return 0;
}

async function runAuthLogin(browser: boolean): Promise<number> {
  const report = await loginWithCloudHandoff({ browser });
  if (report.ok) {
    process.stdout.write('Successfully authenticated.\n');
  }
  return report.ok ? 0 : 1;
}

async function runAuthValidate(json: boolean): Promise<number> {
  const report = await validateRemoteAuth();
  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatAuthValidateReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.node);
  if (!minimum) throw new Error('Invalid CLI Node runtime requirement.');
  const actual = process.versions.node.split('.').map(Number);
  const required = minimum.slice(1).map(Number);
  const difference = actual
    .map((part, index) => part - required[index]!)
    .find((part) => part !== 0);
  if (difference !== undefined && difference < 0)
    throw new Error(
      `PostPlus CLI requires Node.js ${manifest.engines.node}; found ${process.versions.node}. Upgrade Node.js before running this command.`,
    );
  const inputArgs = process.argv.slice(2);
  const args = inputArgs[0] === 'help' && inputArgs[1] && !inputArgs[1].startsWith('-')
    ? [...inputArgs.slice(1), '--help'] : inputArgs;
  const [command, ...rest] = args;
  // Help and bundled capability discovery do not inspect or mutate account state.
  if (command && command !== 'list' && !args.some(isHelpArg)) await assertConfigFilePermissions();
  const json = rest.includes('--json');

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      await printHelp();
      process.exitCode = 0;
      return;
    case '--version':
    case '-v':
    case 'version':
      if (rest.some(isHelpArg)) { process.exitCode = printReadOnlyHelp('version', json); return; }
      assertOnlyOptions(rest, [], 'version');
      process.exitCode = await runVersion();
      return;
    case 'help': {
      const [helpTopic] = rest;
      if (helpTopic === 'doctor' || helpTopic === 'status') {
        printDiagnosticHelp(helpTopic, json);
      } else if (helpTopic === 'auth') {
        printAuthHelp();
      } else if (helpTopic === 'skills') {
        await runSkillsCommand(['help']);
      } else if (helpTopic === 'studio') {
        await runStudioCommand(['help']);
      } else {
        await printHelp();
      }
      process.exitCode = 0;
      return;
    }
    case 'doctor':
      if (rest.some(isHelpArg)) { process.exitCode = printDiagnosticHelp('doctor', json); return; }
      process.exitCode = await runDoctor(parseDiagnosticOptions(rest));
      return;
    case 'balance':
      process.exitCode = await runBalanceCommand(rest);
      return;
    case 'runs':
      process.exitCode = await runRunsCommand(rest);
      return;
    // The bin path never passes the in-process context, so these always resolve
    // to the numeric exit code (the `unknown` return is the hosted-lib path only).
    case 'research':
      process.exitCode = (await runHostedDomainCommand(
        'research',
        rest,
      )) as number;
      return;
    case 'media':
      process.exitCode = (await runHostedDomainCommand(
        'media',
        rest,
      )) as number;
      return;
    case 'media-file':
      process.exitCode = (await runMediaFileCommand(rest)) as number;
      return;
    case 'publish':
      process.exitCode = (await runHostedDomainCommand(
        'publish',
        rest,
      )) as number;
      return;
    case 'quote':
      process.exitCode = await runQuoteCommand(rest);
      return;
    case 'skills':
      process.exitCode = await runSkillsCommand(rest);
      return;
    case 'studio':
      process.exitCode = await runStudioCommand(rest);
      return;
    case 'install':
      process.exitCode = await runSkillInstallCommand(rest);
      return;
    case 'update':
      process.exitCode = await runSkillUpdateCommand(rest);
      return;
    case 'uninstall':
      process.exitCode = await runSkillUninstallCommand(rest);
      return;
    case 'list':
      if (rest.some(isHelpArg)) { process.exitCode = printReadOnlyHelp('list', json); return; }
      assertOnlyOptions(rest, ['--json'], 'list');
      process.exitCode = await runList(json);
      return;
    case 'status':
      if (rest.some(isHelpArg)) { process.exitCode = printDiagnosticHelp('status', json); return; }
      process.exitCode = await runStatus(parseDiagnosticOptions(rest));
      return;
    case 'auth': {
      const [subcommand, ...authRest] = rest;
      if (authRest.some(isHelpArg)) {
        if (!['login', 'refresh', 'revoke', 'status', 'validate', 'logout'].includes(subcommand ?? '')) throw new Error(`Unknown command: auth ${subcommand}`);
        printAuthHelp(); process.exitCode = 0; return;
      }
      if (['refresh', 'revoke', 'status', 'validate', 'logout'].includes(subcommand ?? '')) assertOnlyOptions(authRest, ['--json'], `auth ${subcommand}`);
      switch (subcommand) {
        case 'login': {
          if (authRest.some(isHelpArg)) {
            printAuthHelp();
            process.exitCode = 0;
            return;
          }
          const unknownOption = authRest.find((arg) => arg !== '--no-browser');
          if (unknownOption !== undefined) {
            throw new Error(`Unknown option for auth login: ${unknownOption}`);
          }
          process.exitCode = await runAuthLogin(
            !authRest.includes('--no-browser'),
          );
          return;
        }
        case 'refresh':
          process.exitCode = await runAuthRefresh(authRest.includes('--json'));
          return;
        case 'revoke':
          process.exitCode = await runAuthRevoke(authRest.includes('--json'));
          return;
        case 'status':
          process.exitCode = await runAuthStatus(authRest.includes('--json'));
          return;
        case 'validate':
          process.exitCode = await runAuthValidate(authRest.includes('--json'));
          return;
        case 'logout':
          process.exitCode = await runAuthLogout(authRest.includes('--json'));
          return;
        case 'help':
        case '--help':
        case '-h':
        case undefined:
          printAuthHelp();
          process.exitCode = 0;
          return;
        default:
          throw new Error(`Unknown command: auth ${subcommand}`);
      }
    }
    default:
      throw new PostPlusFailure(`Unknown command: ${command}`, { code: 'postplus_unknown_command', stage: 'parse', action: 'Run postplus --help.' });
  }
}

async function runMainWithRecovery(): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof PostPlusClientUpgradeRequiredError) {
      const recovery = await runPostPlusClientUpgradeRecovery({
        originalArgs: error.recoveryArgs ?? process.argv.slice(2),
        payload: error.payload,
      });
      if (recovery.exitCode !== 0 && (!recovery.attempted || recovery.updateExitCode !== 0 || recovery.restartAgentSessionRequired)) {
        throw new PostPlusFailure(recovery.restartAgentSessionRequired ? 'PostPlus updated; this task needs a new agent session.' : 'PostPlus could not complete the required update.', {
          code: recovery.restartAgentSessionRequired ? 'postplus_agent_restart_required' : 'postplus_client_upgrade_failed',
          stage: 'compatibility-recovery', service: 'cli', retryable: false,
          action: recovery.restartAgentSessionRequired ? POSTPLUS_SKILLS_SESSION_ACTION : 'Stop automatic recovery and report this failure; do not run another update or resubmit the task.',
        }, { cause: error });
      }
      process.exitCode = recovery.exitCode === 0 ? 0 : 1;
      return;
    }

    throw error;
  }
}

runMainWithRecovery().then(() => {
  if (process.exitCode && process.exitCode !== 0) process.exitCode = 1;
}).catch((error: unknown) => {
  writeFailure(error, { automaticRecovery: process.env[POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV] === '1', json: process.argv.includes('--json'), stage: process.argv[2] ?? 'command', helpCommand: helpCommandForArgs(process.argv.slice(2)) });
  process.exitCode = 1;
});

function printSkillMutationHelp(command: string, json: boolean): number {
  const help = { purpose: command === 'install' ? 'Install the matching bundled skills; reuse already correct content.' : command === 'update' ? 'Update the CLI and reconcile its matching managed skills.' : 'Remove managed PostPlus skills while protecting local changes.', examples: [`postplus ${command}`, `postplus ${command} --current-directory`], next: command === 'uninstall' ? 'Success means managed skills have been removed after protecting local changes. Start a new agent session to stop using previously loaded skills.' : 'Success means every supported installation target has been verified against this CLI bundle. It does not refresh the current agent session. Follow the reported action. Changes may require a new agent session; --yes authorizes backup and replacement only with user approval. ' + POSTPLUS_SKILLS_SESSION_ACTION, command: `postplus ${command}`, usage: `postplus ${command} [--current-directory] [--json] [--yes]`, options: { '--current-directory': 'Target this project.', '--json': 'Return machine-readable output.', '--yes': command === 'uninstall' ? 'Authorize backup and removal of locally changed managed skills.' : 'Authorize backup and replacement of locally modified managed skills.' } };
  if (json) process.stdout.write(`${JSON.stringify(help)}\n`);
  else process.stdout.write(`${help.purpose}\n\nUsage: ${help.usage}\n\nOptions:\n${Object.entries(help.options).map(([flag, detail]) => `${flag}  ${detail}`).join('\n')}\n\nExamples:\n${help.examples.join('\n')}\n\nNext: ${help.next}\n`);
  return 0;
}

function printDiagnosticHelp(command: 'doctor' | 'status', json: boolean): number {
  const help = {
    command: `postplus ${command}`,
    purpose: command === 'doctor'
      ? 'Check PostPlus readiness and identify blocking problems. Use after a setup or task readiness failure.'
      : 'Show overall PostPlus status: readiness checks, authentication, installed skills, and available updates.',
    usage: `postplus ${command} [--skill <skill-id>] [--json]`,
    options: {
      '--skill <skill-id>': 'Inspect requirements relevant to a specific released skill.',
      '--json': 'Show the complete structured report.',
      '--help, -h': 'Show help without login, checks, or network requests.',
    },
    checks: command === 'doctor'
      ? ['Client compatibility', 'Service configuration', 'Hosted capabilities', 'Local dependencies', 'Authentication', 'Skill catalog']
      : ['Includes doctor checks, auth state, installed skill content, and update information'],
    examples: [`postplus ${command}`, `postplus ${command} --skill video-transcription --json`],
    results: command === 'doctor'
      ? 'Blocking required checks return exit code 1. Exit code 0 does not guarantee every task-specific capability is ready.'
      : 'Exit code 1 means a reported component needs attention; inspect --json for details.',
    next: 'Follow the reported action, then check again. Verify installed skill content with postplus skills verify.',
    related: command === 'doctor'
      ? 'postplus status includes doctor plus auth, installed skills, and update information.'
      : 'postplus doctor focuses on readiness checks and their suggested actions.',
    limits: 'The command may contact PostPlus services. It does not prove this agent session has loaded skills. Help itself is offline.',
  };
  if (json) process.stdout.write(`${JSON.stringify(help)}\n`);
  else process.stdout.write(`${help.purpose}\n\nUsage:\n  ${help.usage}\n\nOptions:\n${Object.entries(help.options).map(([flag, detail]) => `  ${flag}  ${detail}`).join('\n')}\n\nChecks:\n  ${help.checks.join(', ')}\n\nExamples:\n  ${help.examples.join('\n  ')}\n\nResults:\n  ${help.results}\n\nNext:\n  ${help.next}\n  ${help.related}\n\n${help.limits}\n`);
  return 0;
}

function assertOnlyOptions(args: string[], allowed: string[], command: string): void {
  const invalid = args.find((arg) => !allowed.includes(arg));
  if (invalid) throw new Error(`Unknown option for ${command}: ${invalid}`);
}

function printReadOnlyHelp(command: 'list' | 'version', json: boolean): number {
  const help = { command: `postplus ${command}`,
    purpose: command === 'list' ? 'Discover what PostPlus can do, grouped by the task you want to complete.' : 'Show the installed CLI version.',
    usage: `postplus ${command}${command === 'list' ? ' [--json]' : ''}`,
    options: command === 'list' ? '--json: structured output; --help, -h: help' : '--help, -h: help',
    examples: [`postplus ${command}`], next: command === 'list' ? 'Describe a task from the examples to your agent. Use postplus list --json for full skill details.' : 'Use postplus status for readiness and update information.' };
  process.stdout.write(json ? `${JSON.stringify(help)}\n` : `${help.purpose}\nUsage: ${help.usage}\nOptions: ${help.options}\nExamples: ${help.examples.join('\n')}\nNext: ${help.next}\n`);
  return 0;
}

function printQuoteHelp(): number {
  process.stdout.write(`Authorize a quoted operation only after user approval. Help does not confirm or execute anything.
Usage: postplus quote confirm --json --challenge-file <path> [--auto-confirm-under <credits>]
Options:
  --challenge-file  Read the challenge returned by the blocked operation.
  --json  Required structured response.
  --auto-confirm-under  Use only the user's already approved credit threshold.
  --help, -h  Show this help.
Examples:
  postplus quote confirm --json --challenge-file ./challenge.json
Next: After approval, use the returned token with the original operation's retry instructions.
`);
  return 0;
}

function helpCommandForArgs(args: string[]): string {
  const [command, subcommand, target] = args[0] === 'help' ? args.slice(1) : args;
  if (!command || command.startsWith('-')) return 'postplus';
  const parts = ['postplus', command];
  const children: Record<string, string[]> = {
    auth: ['login', 'refresh', 'revoke', 'status', 'validate', 'logout'], skills: ['verify'], quote: ['confirm'],
    runs: ['list', 'show'], studio: ['init', 'open', 'status'],
    research: ['schema', 'run'], media: ['schema', 'poll', 'prepare', 'estimate', ...buildVerbTargetIndex('media').keys()],
    publish: ['schema', ...[...buildVerbTargetIndex('publish').values()].flatMap((targets) => [...targets.keys()])],
    'media-file': ['upload', 'download'],
  };
  if (subcommand && children[command]?.includes(subcommand)) {
    if (/^[a-z][a-z0-9-]*$/.test(subcommand)) parts.push(subcommand);
  }
  if (target && parts.length === 3) {
    const index = command === 'media' || command === 'research' ? buildVerbTargetIndex(command) : null;
    const valid = command === 'research' || subcommand === 'estimate'
      ? [...(index?.values() ?? [])].some((targets) => targets.has(target))
      : index?.get(subcommand!)?.has(target);
    if (valid) parts.push(target);
  }
  return parts.join(' ');
}
