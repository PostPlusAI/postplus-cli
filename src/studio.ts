import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { closeSync, constants as fsConstants, openSync } from 'node:fs';
import net from 'node:net';
import { platform } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export const POSTPLUS_STUDIO_DIRECTORY_NAME = 'PostPlus Studio';
const DEFAULT_STUDIO_ID = 'postplus-studio';

type StudioCommandOptions = {
  browser: boolean;
  json: boolean;
  port: number;
  workdir: string;
};

type StudioStatusReport = {
  ok: boolean;
  studioRoot: string;
  exists: boolean;
  files: {
    studio: boolean;
    manifest: boolean;
    pipeline: boolean;
  };
};

type StudioServerState = {
  baseUrl: string;
  dashboardUrl: string;
  logPath: string;
  pid: number | undefined;
  startedAt: string;
  studioRoot: string;
};

export async function runStudioCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    printStudioHelp();
    return 0;
  }

  if (rest.some((arg) => ['help', '--help', '-h'].includes(arg))) {
    printStudioHelp();
    return 0;
  }

  const options = parseStudioOptions(rest);

  switch (subcommand) {
    case 'init': {
      const result = await initializeStudio(options.workdir);
      writeOutput(options.json, result, formatStudioInitReport(result));
      return 0;
    }
    case 'status': {
      const report = await getStudioStatus(options.workdir);
      writeOutput(options.json, report, formatStudioStatusReport(report));
      return report.ok ? 0 : 1;
    }
    case 'open': {
      const result = await openStudio(options);
      writeOutput(options.json, result, formatStudioOpenReport(result));
      return 0;
    }
    default:
      process.stderr.write(`Unknown studio command: ${subcommand}\n\n`);
      printStudioHelp();
      return 1;
  }
}

function printStudioHelp(): void {
  process.stdout.write(`PostPlus CLI — studio commands

Usage:
  postplus studio init [--workdir <dir>] [--json]
  postplus studio open [--workdir <dir>] [--port 3978] [--no-browser] [--json]
  postplus studio status [--workdir <dir>] [--json]

Local Studio is a public local workspace included in the PostPlus CLI package.
Studio creates a visible "PostPlus Studio" folder inside the selected working directory and opens the bundled local dashboard.
`);
}

function parseStudioOptions(args: string[]): StudioCommandOptions {
  const options: StudioCommandOptions = {
    browser: true,
    json: false,
    port: 3978,
    workdir: process.cwd(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--no-browser') {
      options.browser = false;
      continue;
    }

    if (arg === '--workdir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --workdir.');
      }
      options.workdir = resolve(value);
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --port.');
      }
      options.port = Number(value);
      if (!Number.isInteger(options.port) || options.port <= 0) {
        throw new Error('--port must be a positive integer.');
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for studio command: ${arg}`);
  }

  return options;
}

export function resolveStudioRoot(workdir: string): string {
  const root = resolve(workdir);
  return basename(root) === POSTPLUS_STUDIO_DIRECTORY_NAME
    ? root
    : join(root, POSTPLUS_STUDIO_DIRECTORY_NAME);
}

async function initializeStudio(workdir: string) {
  const studioRoot = resolveStudioRoot(workdir);
  const createdAt = new Date().toISOString();
  await mkdir(studioRoot, { recursive: true });

  for (const dir of [
    'workflows',
    'assets/texts',
    'assets/images',
    'assets/audio',
    'assets/videos',
    'assets/html',
    'assets/references',
    'data',
    'exports',
    '.postplus/locks',
    '.postplus/cache',
    '.postplus/temp',
    '.postplus/runs',
    '.postplus/provider-responses',
    '.postplus/quote-confirmations',
    '.postplus/logs',
  ]) {
    await mkdir(join(studioRoot, dir), { recursive: true });
  }

  await writeJsonIfMissing(join(studioRoot, 'studio.json'), {
    schemaVersion: 1,
    studio_id: DEFAULT_STUDIO_ID,
    name: 'PostPlus Studio',
    root_name: POSTPLUS_STUDIO_DIRECTORY_NAME,
    created_at: createdAt,
    updated_at: createdAt,
  });
  await writeJsonIfMissing(join(studioRoot, 'project.json'), {
    project_id: DEFAULT_STUDIO_ID,
    name: 'PostPlus Studio',
    goal: 'Run PostPlus workflows in a local visual Studio workspace.',
    status: 'active',
    created_at: createdAt,
    updated_at: createdAt,
  });
  await writeJsonIfMissing(join(studioRoot, 'manifest.json'), { assets: [] });
  await writeJsonIfMissing(join(studioRoot, 'pipeline.json'), {
    pipeline_id: 'ad-video-pipeline',
    steps: [
      {
        id: 'brief',
        name: 'Brief',
        status: 'pending',
        updated_at: createdAt,
      },
      {
        id: 'script',
        name: 'Script',
        status: 'pending',
        updated_at: createdAt,
      },
      {
        id: 'storyboard',
        name: 'Storyboard',
        status: 'pending',
        updated_at: createdAt,
      },
    ],
  });
  await writeJsonIfMissing(join(studioRoot, 'context.json'), {
    active_project: DEFAULT_STUDIO_ID,
    active_pipeline: 'ad-video-pipeline',
    active_step: 'brief',
    selected_asset_id: null,
    selected_block_id: null,
    selected_version: null,
    visible_panel: 'dashboard',
    updated_at: createdAt,
  });
  await writeTextIfMissing(join(studioRoot, 'provenance.jsonl'), '');
  await writeTextIfMissing(join(studioRoot, 'activity.jsonl'), '');

  return {
    ok: true,
    studioRoot,
  };
}

async function getStudioStatus(workdir: string): Promise<StudioStatusReport> {
  const studioRoot = resolveStudioRoot(workdir);
  const exists = await pathExists(studioRoot);
  const files = {
    manifest: await pathExists(join(studioRoot, 'manifest.json')),
    pipeline: await pathExists(join(studioRoot, 'pipeline.json')),
    studio: await pathExists(join(studioRoot, 'studio.json')),
  };

  return {
    exists,
    files,
    ok: exists && files.studio && files.manifest && files.pipeline,
    studioRoot,
  };
}

async function openStudio(options: StudioCommandOptions) {
  const { studioRoot } = await initializeStudio(options.workdir);
  const parsed = await launchBundledStudioServer(studioRoot, options.port);

  if (options.browser) {
    openSystemBrowser(parsed.url);
  }

  return {
    ok: true,
    studioRoot,
    ...parsed,
  };
}

async function launchBundledStudioServer(studioRoot: string, startPort: number) {
  const existing = await readLiveStudioServerState(studioRoot);
  if (existing) {
    return {
      logPath: existing.logPath,
      pid: existing.pid,
      reused: true,
      url: existing.dashboardUrl,
    };
  }

  const host = '127.0.0.1';
  const port = await findAvailablePort(startPort, host);
  const baseUrl = `http://${host}:${port}`;
  const dashboardUrl = `${baseUrl}/dashboard/`;
  const logDir = join(studioRoot, '.postplus', 'logs');
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, 'studio-server.log');
  const logFd = openSync(logPath, 'a');
  const serverEntrypoint = resolveBundledStudioServerEntrypoint();
  const packageRoot = resolveCliPackageRoot();
  const child = spawn(
    process.execPath,
    [
      ...buildNodeLoaderArgs(serverEntrypoint),
      serverEntrypoint,
      '--studio-root',
      studioRoot,
      '--host',
      host,
      '--port',
      String(port),
    ],
    {
      cwd: packageRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  child.unref();
  closeSync(logFd);

  try {
    await waitForStudioServer(baseUrl, logPath);
  } catch (error) {
    if (child.pid) {
      try {
        process.kill(child.pid);
      } catch {
        // The process already exited; the readiness error below carries the failure.
      }
    }
    throw error;
  }

  const state: StudioServerState = {
    baseUrl,
    dashboardUrl,
    logPath,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    studioRoot,
  };
  await writeJson(getStudioServerStatePath(studioRoot), state);

  return {
    logPath,
    pid: child.pid,
    reused: false,
    url: dashboardUrl,
  };
}

function resolveBundledStudioServerEntrypoint(): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  const extension = currentModulePath.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(currentModulePath), `studio-server${extension}`);
}

function resolveCliPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function buildNodeLoaderArgs(entrypoint: string): string[] {
  return entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : [];
}

async function readLiveStudioServerState(
  studioRoot: string,
): Promise<StudioServerState | null> {
  const state = await readJsonIfExists<StudioServerState>(
    getStudioServerStatePath(studioRoot),
  );
  if (!state?.baseUrl || !state.dashboardUrl) {
    return null;
  }

  if (await canFetchStudioServer(state.baseUrl)) {
    return state;
  }

  return null;
}

function getStudioServerStatePath(studioRoot: string): string {
  return join(studioRoot, '.postplus', 'studio-server.json');
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!(await pathExists(path))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function waitForStudioServer(baseUrl: string, logPath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await canFetchStudioServer(baseUrl)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Studio server did not become ready at ${baseUrl}. See log: ${logPath}`);
}

async function canFetchStudioServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function findAvailablePort(startPort: number, host: string): Promise<number> {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }
  throw new Error(`No available Studio port found from ${startPort} to ${startPort + 49}.`);
}

function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = net.createServer();
    server.once('error', () => resolveAvailable(false));
    server.once('listening', () => {
      server.close(() => resolveAvailable(true));
    });
    server.listen(port, host);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonIfMissing(path: string, value: unknown): Promise<void> {
  if (await pathExists(path)) {
    return;
  }
  await writeJson(path, value);
}

async function writeTextIfMissing(path: string, value: string): Promise<void> {
  if (await pathExists(path)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function openSystemBrowser(url: string): void {
  const command =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args =
    platform() === 'win32' ? ['/c', 'start', '', url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function writeOutput(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function formatStudioInitReport(result: { studioRoot: string }): string {
  return `PostPlus Studio initialized\n\nStudio root: ${result.studioRoot}\n`;
}

function formatStudioOpenReport(result: { studioRoot: string; url: string }): string {
  return `PostPlus Studio is running\n\nStudio root: ${result.studioRoot}\nURL: ${result.url}\n`;
}

function formatStudioStatusReport(report: StudioStatusReport): string {
  return [
    'PostPlus Studio status',
    '',
    `Studio root: ${report.studioRoot}`,
    `Exists: ${report.exists ? 'yes' : 'no'}`,
    `studio.json: ${report.files.studio ? 'yes' : 'no'}`,
    `manifest.json: ${report.files.manifest ? 'yes' : 'no'}`,
    `pipeline.json: ${report.files.pipeline ? 'yes' : 'no'}`,
    `Status: ${report.ok ? 'ready' : 'not ready'}`,
    '',
  ].join('\n');
}
