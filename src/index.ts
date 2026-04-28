#!/usr/bin/env node
import {
  formatAuthRefreshReport,
  refreshRemoteAuth,
  revokeRemoteAuthAndReport,
} from './auth-lifecycle.js';
import { assertConfigFilePermissions } from './local-state.js';
import { loginWithBrowserHandoff } from './auth-login.js';
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
  formatDoctorReport,
  generateDoctorReport,
} from './doctor.js';
import {
  formatGuidedInstallReport,
  generateGuidedInstallReport,
} from './guided-install.js';
import {
  applyInstallReport,
  formatInstallReport,
  generateInstallReport,
} from './install.js';
import { loadHostedReleaseManifestSource } from './release-source.js';
import { formatStatusReport, generateStatusReport } from './status.js';
import {
  applyUninstallReport,
  formatUninstallReport,
  generateUninstallReport,
} from './uninstall.js';
import {
  applyUpdateReport,
  collectUpdateNotice,
  formatUpdateReport,
  generateUpdateReport,
  markUpdateCheckCompleted,
  shouldRunAutomaticUpdateCheck,
  type UpdateNotice,
} from './update.js';

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
  postplus guide install [skill-id ...] [--json]
  postplus install [skill-id ...] [--dry-run] [--force] [--json]
  postplus list [--json]
  postplus status [--json]
  postplus uninstall [skill-id ...] [--dry-run] [--json]
  postplus update [skill-id ...] [--apply] [--force] [--json]
  postplus help
`);
}

async function runDoctor(json: boolean, notice: UpdateNotice | null): Promise<number> {
  const report = await generateDoctorReport();

  if (json) {
    writeJsonWithNotice(report, notice);
  } else {
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    writeStderrNotice(notice);
  }

  return report.ok ? 0 : 1;
}

async function runAuthStatus(json: boolean, notice: UpdateNotice | null): Promise<number> {
  const report = await generateAuthStatusReport();

  if (json) {
    writeJsonWithNotice(report, notice);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
    writeStderrNotice(notice);
  }

  return report.ok ? 0 : 1;
}

async function runStatus(json: boolean, notice: UpdateNotice | null): Promise<number> {
  const report = await generateStatusReport();

  if (json) {
    writeJsonWithNotice(report, notice);
  } else {
    process.stdout.write(`${formatStatusReport(report)}\n`);
    writeStderrNotice(notice);
  }

  return report.ok ? 0 : 1;
}

async function runInstall(options: {
  dryRun: boolean;
  force: boolean;
  json: boolean;
  skillIds: string[];
}, notice: UpdateNotice | null): Promise<number> {
  const report = await generateInstallReport({
    skillIds: options.skillIds,
    force: options.force,
  });
  const finalReport = options.dryRun
    ? report
    : await applyInstallReport(report);

  if (options.json) {
    writeJsonWithNotice(finalReport, notice);
  } else {
    process.stdout.write(`${formatInstallReport(finalReport)}\n`);
    writeStderrNotice(notice);
  }

  return 0;
}

async function runUninstall(options: {
  dryRun: boolean;
  json: boolean;
  skillIds: string[];
}, notice: UpdateNotice | null): Promise<number> {
  const report = await generateUninstallReport({
    skillIds: options.skillIds,
  });
  const finalReport = options.dryRun
    ? report
    : await applyUninstallReport(report);

  if (options.json) {
    writeJsonWithNotice(finalReport, notice);
  } else {
    process.stdout.write(`${formatUninstallReport(finalReport)}\n`);
    writeStderrNotice(notice);
  }

  return 0;
}

async function runGuidedInstall(options: {
  json: boolean;
  skillIds: string[];
}, notice: UpdateNotice | null): Promise<number> {
  const report = await generateGuidedInstallReport({
    skillIds: options.skillIds,
  });

  if (options.json) {
    writeJsonWithNotice(report, notice);
  } else {
    process.stdout.write(`${formatGuidedInstallReport(report)}\n`);
    writeStderrNotice(notice);
  }

  return 0;
}

async function runList(json: boolean, notice: UpdateNotice | null): Promise<number> {
  const source = await loadHostedReleaseManifestSource();
  const manifest = source.manifest;

  if (json) {
    writeJsonWithNotice(manifest, notice);
  } else {
    const lines = [
      'PostPlus CLI skills',
      '',
      `Catalog: ${source.baseUrl}`,
      '',
    ];
    for (const entry of manifest.skills) {
      lines.push(`- ${entry.skillId}: ${entry.displayName}`);
      if (entry.description) {
        lines.push(`  ${entry.description}`);
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    writeStderrNotice(notice);
  }

  return 0;
}

async function runUpdate(options: {
  apply: boolean;
  force: boolean;
  json: boolean;
  skillIds: string[];
}): Promise<number> {
  const report = await generateUpdateReport({
    skillIds: options.skillIds,
  });
  const finalReport = options.apply
    ? await applyUpdateReport({
        report,
        force: options.force,
      })
    : report;
  await markUpdateCheckCompleted();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatUpdateReport(finalReport)}\n`);
  }

  return finalReport.ok ? 0 : 1;
}

function isManagementCommand(command: string | undefined): boolean {
  return (
    !command ||
    command.startsWith('-') ||
    ['auth', 'doctor', 'guide', 'help', 'install', 'list', 'status', 'uninstall', 'update'].includes(command)
  );
}

function buildNoticeStderr(notice: UpdateNotice): string {
  const lines = ['PostPlus update check', ''];
  if (notice.updateCount > 0) {
    lines.push(notice.message);
    lines.push(`Run \`${notice.command}\` to install available updates.`);
    lines.push('');
  }
  if (notice.serverMessages.length > 0) {
    lines.push('PostPlus messages:');
    for (const m of notice.serverMessages) {
      lines.push(`- ${m.title}: ${m.body}`);
      if (m.ctaLabel || m.ctaUrl) {
        lines.push(`  ${[m.ctaLabel, m.ctaUrl].filter(Boolean).join(' ')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function maybeCollectUpdateNotice(command: string | undefined): Promise<UpdateNotice | null> {
  if (isManagementCommand(command)) {
    return null;
  }
  return collectUpdateNotice();
}

function injectNoticeIntoJson(json: unknown, notice: UpdateNotice | null): unknown {
  if (!notice || typeof json !== 'object' || json === null || Array.isArray(json)) {
    return json;
  }
  return { ...json, _notice: { update: { message: notice.message, command: notice.command }, serverMessages: notice.serverMessages.length > 0 ? notice.serverMessages : undefined } };
}

function writeJsonWithNotice(value: unknown, notice: UpdateNotice | null): void {
  process.stdout.write(`${JSON.stringify(injectNoticeIntoJson(value, notice), null, 2)}\n`);
}

function writeStderrNotice(notice: UpdateNotice | null): void {
  if (notice) {
    process.stderr.write(`${buildNoticeStderr(notice)}\n`);
  }
}

async function runAuthLogout(json: boolean): Promise<number> {
  const report = await clearAuthState();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
  }
  return 0;
}

async function runAuthRefresh(json: boolean): Promise<number> {
  const report = await refreshRemoteAuth();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAuthRefreshReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

async function runAuthRevoke(json: boolean): Promise<number> {
  const report = await revokeRemoteAuthAndReport();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAuthStatusReport(report)}\n`);
  }
  return 0;
}

async function runAuthLogin(): Promise<number> {
  const report = await loginWithBrowserHandoff();
  process.stdout.write(
    [
      '',
      'PostPlus CLI login complete.',
      `Account: ${report.accountId}`,
      `PostPlus Cloud: ${report.apiBaseUrl}`,
      `User: ${report.userEmail ?? 'unknown'}`,
      `Session expires at: ${
        typeof report.sessionExpiresAt === 'number'
          ? new Date(report.sessionExpiresAt * 1000).toISOString()
          : 'unknown'
      }`,
      '',
    ].join('\n'),
  );
  return report.ok ? 0 : 1;
}

async function runAuthValidate(json: boolean): Promise<number> {
  const report = await validateRemoteAuth();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAuthValidateReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  await assertConfigFilePermissions();
  const json = rest.includes('--json');
  const notice = json ? await maybeCollectUpdateNotice(command) : null;

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
    case 'doctor': {
      process.exitCode = await runDoctor(json, notice);
      return;
    }
    case 'guide': {
      const [subcommand, ...guideRest] = rest;

      if (subcommand === 'install') {
        process.exitCode = await runGuidedInstall({
          json: guideRest.includes('--json'),
          skillIds: guideRest.filter((value) => !value.startsWith('--')),
        }, notice);
        return;
      }

      process.stderr.write(
        `Unknown guide command: ${subcommand ?? '(missing)'}\n\n`,
      );
      printHelp();
      process.exitCode = 1;
      return;
    }
    case 'install': {
      process.exitCode = await runInstall({
        dryRun: rest.includes('--dry-run'),
        force: rest.includes('--force'),
        json,
        skillIds: rest.filter((value) => !value.startsWith('--')),
      }, notice);
      return;
    }
    case 'list': {
      process.exitCode = await runList(json, notice);
      return;
    }
    case 'status': {
      process.exitCode = await runStatus(json, notice);
      return;
    }
    case 'uninstall': {
      process.exitCode = await runUninstall({
        dryRun: rest.includes('--dry-run'),
        json,
        skillIds: rest.filter((value) => !value.startsWith('--')),
      }, notice);
      return;
    }
    case 'update': {
      process.exitCode = await runUpdate({
        apply: rest.includes('--apply'),
        force: rest.includes('--force'),
        json: rest.includes('--json'),
        skillIds: rest.filter((value) => !value.startsWith('--')),
      });
      return;
    }
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
          process.exitCode = await runAuthStatus(authRest.includes('--json'), notice);
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
          process.stderr.write(
            `Unknown auth command: ${subcommand}\n\n`,
          );
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
