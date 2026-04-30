#!/usr/bin/env node
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
import { formatDoctorReport, generateDoctorReport } from './doctor.js';
import { assertConfigFilePermissions } from './local-state.js';
import {
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import {
  runPostPlusSkillUninstall,
  runPostPlusSkillUpdate,
} from './skill-management.js';
import { formatStatusReport, generateStatusReport } from './status.js';
import { refreshUpdateCheckBaseline } from './update-check.js';

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
  postplus doctor [--json]
  postplus update
  postplus uninstall
  postplus list [--json]
  postplus status [--json]
  postplus help

Skills:
  ${POSTPLUS_SKILLS_INSTALL_COMMAND}
`);
}

async function runDoctor(json: boolean): Promise<number> {
  const report = await generateDoctorReport();

  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatDoctorReport(report)}\n`);
  }

  return report.ok ? 0 : 1;
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

async function runStatus(json: boolean): Promise<number> {
  const report = await generateStatusReport();

  if (json) {
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
    `Install: ${catalog.installCommand}`,
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

async function runSkillUpdateCommand(): Promise<number> {
  const exitCode = await runPostPlusSkillUpdate();

  if (exitCode === 0) {
    await refreshUpdateCheckBaseline().catch(() => {});
  }

  return exitCode;
}

async function runSkillUninstallCommand(): Promise<number> {
  return runPostPlusSkillUninstall();
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
      `Account: ${report.accountId}`,
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
    case 'help': {
      const [helpTopic] = rest;
      if (helpTopic === 'auth') {
        printAuthHelp();
      } else {
        printHelp();
      }
      process.exitCode = 0;
      return;
    }
    case 'doctor':
      process.exitCode = await runDoctor(json);
      return;
    case 'install':
      process.stderr.write(
        `PostPlus CLI does not install skills directly. Run \`${POSTPLUS_SKILLS_INSTALL_COMMAND}\`.\n`,
      );
      process.exitCode = 1;
      return;
    case 'update':
      process.exitCode = await runSkillUpdateCommand();
      return;
    case 'uninstall':
      process.exitCode = await runSkillUninstallCommand();
      return;
    case 'list':
      process.exitCode = await runList(json);
      return;
    case 'status':
      process.exitCode = await runStatus(json);
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
