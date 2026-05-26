#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { formatAccountBindingLines } from './account-binding-display.js';
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
import { readCurrentCliVersion } from './client-compatibility.js';
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import { runHostedDomainCommand } from './hosted-domain-commands.js';
import { assertConfigFilePermissions } from './local-state.js';
import {
  readLargeCreditQuoteConfirmationChallenge,
  resolveLargeCreditQuoteConfirmation,
} from './quote-confirmation.js';
import {
  POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND,
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  type PostPlusSkillsInstallScope,
  formatPostPlusSkillsInstallCommand,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import {
  formatSkillBaselineVerifyReport,
  runPostPlusSkillUninstall,
  runPostPlusSkillUpdate,
  runPostPlusSkillVerify,
} from './skill-management.js';
import { formatStatusReport, generateStatusReport } from './status.js';
import { runStudioCommand } from './studio.js';
import {
  refreshUpdateCheckCache,
  runCliSelfUpdateIfOutdated,
} from './update-check.js';

function printAuthHelp(): void {
  process.stdout.write(`PostPlus CLI — auth commands

Usage:
  postplus auth login          Sign in with your PostPlus account in a browser
  postplus auth status         Show current auth state (tokens, account, expiry)
  postplus auth validate       Validate the current session against PostPlus Cloud
  postplus auth refresh        Refresh the current session tokens
  postplus auth revoke         Revoke the current session on PostPlus Cloud
  postplus auth logout         Clear local auth state

Options:
  --json    Output results as JSON

Run \`postplus help\` for all commands.
`);
}

function printHelp(): void {
  process.stdout.write(`PostPlus CLI

Usage:
  postplus auth login
  postplus auth refresh [--json]
  postplus auth revoke [--json]
  postplus auth status [--json]
  postplus auth validate [--json]
  postplus auth logout [--json]
  postplus doctor [--skill <skill-id>] [--json]
  postplus research collect --skill <skill-id> --collection-key <key> --input <hosted-envelope.json> [--output <result.json>]
  postplus media capability --request <hosted-capability-request.json> [--output <result.json>]
  postplus publish capability --request <hosted-capability-request.json> [--output <result.json>]
  postplus mobile capability --request <hosted-capability-request.json> [--output <result.json>]
  postplus quote confirm --json --challenge-file <path>
  postplus skills verify [--json]
  postplus studio init|open|status   Open bundled Local Studio
  postplus update [--current-directory]
  postplus uninstall [--current-directory]
  postplus list [--json]
  postplus status [--skill <skill-id>] [--json]
  postplus version
  postplus help

Skills:
  Global:
    ${POSTPLUS_SKILLS_INSTALL_COMMAND}
  Current directory:
    ${POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND}

After first install, run:
  postplus skills verify
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

  const lines = [
    'PostPlus skills',
    '',
    `Source: ${catalog.source}`,
    `Install (global): ${catalog.installCommand}`,
    `Install (current directory): ${formatPostPlusSkillsInstallCommand(catalog.source, 'current-directory')}`,
    '',
  ];

  for (const entry of catalog.skills) {
    lines.push(
      entry.path ? `- ${entry.skillId}: ${entry.path}` : `- ${entry.skillId}`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function runVersion(): Promise<number> {
  process.stdout.write(`${await readCurrentCliVersion()}\n`);
  return 0;
}

async function runSkillUpdateCommand(rest: string[]): Promise<number> {
  const options = parseSkillMutationOptions(rest, 'update');
  const cliSelfUpdate = await runCliSelfUpdateIfOutdated();

  if (cliSelfUpdate.updateAvailable) {
    return cliSelfUpdate.exitCode ?? 1;
  }

  const exitCode = await runPostPlusSkillUpdate(undefined, {
    scope: options.scope,
  });

  if (exitCode === 0) {
    await refreshUpdateCheckCache().catch(() => {});
  }

  return exitCode;
}

async function runSkillUninstallCommand(rest: string[]): Promise<number> {
  const options = parseSkillMutationOptions(rest, 'uninstall');

  return runPostPlusSkillUninstall(undefined, {
    scope: options.scope,
  });
}

async function runSkillsCommand(rest: string[]): Promise<number> {
  const [subcommand] = rest;

  switch (subcommand) {
    case 'verify': {
      const options = rest.slice(1);
      const unknownOption = options.find((option) => option !== '--json');

      if (unknownOption) {
        process.stderr.write(
          `Unknown option for skills verify: ${unknownOption}\n`,
        );
        return 1;
      }

      const report = await runPostPlusSkillVerify();

      if (options.includes('--json')) {
        writeJson(report);
      } else {
        process.stdout.write(`${formatSkillBaselineVerifyReport(report)}\n`);
      }

      return report.ok ? 0 : 1;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`PostPlus CLI — skills commands

Usage:
  postplus skills verify [--json]  Verify installed public skills and record the managed baseline

Options:
  --json    Output results as JSON

Install scope:
  postplus update                       Update global PostPlus skills
  postplus update --current-directory   Update PostPlus skills in the current directory
  postplus uninstall                    Remove global PostPlus skills
  postplus uninstall --current-directory  Remove PostPlus skills from the current directory
`);
      return 0;
    default:
      process.stderr.write(`Unknown skills command: ${subcommand}\n`);
      return 1;
  }
}

async function runQuoteCommand(rest: string[]): Promise<number> {
  const [subcommand, ...options] = rest;

  if (subcommand !== 'confirm') {
    process.stderr.write(`Unknown quote command: ${subcommand ?? ''}\n`);
    return 1;
  }

  const parsed = parseQuoteConfirmOptions(options);

  if (!parsed.json) {
    process.stderr.write('quote confirm requires --json.\n');
    return 1;
  }

  if (!parsed.challengeFile) {
    process.stderr.write('quote confirm requires --challenge-file.\n');
    return 1;
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

  writeJson(await resolveLargeCreditQuoteConfirmation(challenge));
  return 0;
}

function parseQuoteConfirmOptions(args: string[]): {
  challengeFile: string | null;
  json: boolean;
} {
  const options = {
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

    throw new Error(`Unknown option for quote confirm: ${arg}`);
  }

  return options;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  commandName: 'update' | 'uninstall',
): { scope: PostPlusSkillsInstallScope } {
  let scope: PostPlusSkillsInstallScope = 'global';

  for (const arg of args) {
    if (arg === '--current-directory') {
      scope = 'current-directory';
      continue;
    }

    throw new Error(`Unknown option for ${commandName}: ${arg}`);
  }

  return { scope };
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

async function runAuthLogin(): Promise<number> {
  const report = await loginWithCloudHandoff();
  process.stdout.write(
    [
      '',
      'PostPlus CLI login complete.',
      ...formatAccountBindingLines(report),
      `PostPlus Cloud: ${report.apiBaseUrl}`,
      `User: ${report.userEmail ?? 'unknown'}`,
      '',
    ].join('\n'),
  );
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
  const [command, ...rest] = process.argv.slice(2);
  await assertConfigFilePermissions();
  const json = rest.includes('--json');

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      process.exitCode = 0;
      return;
    case '--version':
    case '-v':
    case 'version':
      process.exitCode = await runVersion();
      return;
    case 'help': {
      const [helpTopic] = rest;
      if (helpTopic === 'auth') {
        printAuthHelp();
      } else if (helpTopic === 'skills') {
        await runSkillsCommand(['help']);
      } else if (helpTopic === 'studio') {
        await runStudioCommand(['help']);
      } else {
        printHelp();
      }
      process.exitCode = 0;
      return;
    }
    case 'doctor':
      process.exitCode = await runDoctor(parseDiagnosticOptions(rest));
      return;
    case 'research':
      process.exitCode = await runHostedDomainCommand('research', rest);
      return;
    case 'media':
      process.exitCode = await runHostedDomainCommand('media', rest);
      return;
    case 'publish':
      process.exitCode = await runHostedDomainCommand('publish', rest);
      return;
    case 'mobile':
      process.exitCode = await runHostedDomainCommand('mobile', rest);
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
      process.stderr.write(
        `PostPlus CLI does not install skills directly. Run \`${POSTPLUS_SKILLS_INSTALL_COMMAND}\`.\n`,
      );
      process.exitCode = 1;
      return;
    case 'update':
      process.exitCode = await runSkillUpdateCommand(rest);
      return;
    case 'uninstall':
      process.exitCode = await runSkillUninstallCommand(rest);
      return;
    case 'list':
      process.exitCode = await runList(json);
      return;
    case 'status':
      process.exitCode = await runStatus(parseDiagnosticOptions(rest));
      return;
    case 'auth': {
      const [subcommand, ...authRest] = rest;
      switch (subcommand) {
        case 'login':
          process.exitCode = await runAuthLogin();
          return;
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
          process.stderr.write(`Unknown auth command: ${subcommand}\n\n`);
          printAuthHelp();
          process.exitCode = 1;
          return;
      }
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unexpected PostPlus CLI error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
