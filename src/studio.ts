import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
  POSTPLUS_STUDIO_RUNTIME_ROOT=<vibe_marketing repo> postplus studio open [--workdir <dir>] [--port 3978] [--no-browser] [--json]
  postplus studio status [--workdir <dir>] [--json]

Local Studio is a private/candidate authoring surface. Public CLI installs do not include the Studio runtime.
studio open requires POSTPLUS_STUDIO_RUNTIME_ROOT pointing to the vibe_marketing authoring repo unless the runtime is discoverable from a private authoring workspace.

Studio creates a visible "PostPlus Studio" folder inside the selected working directory.
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
  const runtimeRoot = await resolveStudioRuntimeRoot();
  const launcher = join(
    runtimeRoot,
    'skills/00-core/postplus-workspace-dashboard/scripts/launch_workspace_dashboard.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [
      launcher,
      '--studio-root',
      studioRoot,
      '--host',
      '127.0.0.1',
      '--port',
      String(options.port),
      '--skip-build',
    ],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to open Studio.');
  }

  const parsed = JSON.parse(result.stdout) as {
    logPath?: string;
    pid?: number;
    reused?: boolean;
    url: string;
  };

  if (options.browser) {
    openSystemBrowser(parsed.url);
  }

  return {
    ok: true,
    runtimeRoot,
    studioRoot,
    ...parsed,
  };
}

async function resolveStudioRuntimeRoot(): Promise<string> {
  const envRoot = process.env.POSTPLUS_STUDIO_RUNTIME_ROOT?.trim();
  if (envRoot) {
    return assertStudioRuntimeRoot(resolve(envRoot));
  }

  const candidates = [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
    ...ancestorDirs(process.cwd()),
  ];

  for (const base of candidates) {
    for (const candidate of [
      base,
      join(base, 'packages/vibe_marketing'),
      join(base, '../packages/vibe_marketing'),
      join(base, '../../packages/vibe_marketing'),
    ]) {
      if (await isStudioRuntimeRoot(resolve(candidate))) {
        return resolve(candidate);
      }
    }
  }

  throw new Error(
    'PostPlus Studio runtime was not found. Set POSTPLUS_STUDIO_RUNTIME_ROOT to the vibe_marketing authoring repo.',
  );
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = resolve(start);

  while (dirname(current) !== current) {
    current = dirname(current);
    dirs.push(current);
  }

  return dirs;
}

async function assertStudioRuntimeRoot(root: string): Promise<string> {
  if (!(await isStudioRuntimeRoot(root))) {
    throw new Error(`Invalid PostPlus Studio runtime root: ${root}`);
  }
  return root;
}

async function isStudioRuntimeRoot(root: string): Promise<boolean> {
  return pathExists(
    join(
      root,
      'skills/00-core/postplus-workspace-dashboard/scripts/launch_workspace_dashboard.mjs',
    ),
  );
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
