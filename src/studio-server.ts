#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

type StudioServerOptions = {
  host: string;
  port: number;
  studioRoot: string;
};

type StudioSnapshot = {
  activity: unknown[];
  manifest: unknown;
  pipeline: unknown;
  project: unknown;
  provenance: unknown[];
  studio: unknown;
  studioRoot: string;
};

export async function startStudioServer(
  argv = process.argv.slice(2),
): Promise<http.Server> {
  const options = parseOptions(argv);
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response, options);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });

  return server;
}

function parseOptions(argv: string[]): StudioServerOptions {
  const options: Partial<StudioServerOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--studio-root') {
      const value = readOptionValue(argv, index, arg);
      options.studioRoot = resolve(value);
      index += 1;
      continue;
    }

    if (arg === '--host') {
      options.host = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const value = Number(readOptionValue(argv, index, arg));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--port must be a positive integer.');
      }
      options.port = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage:
  node build/studio-server.js --studio-root <dir> --host 127.0.0.1 --port 3978
`);
      process.exit(0);
    }

    throw new Error(`Unknown Studio server option: ${arg}`);
  }

  if (!options.studioRoot) {
    throw new Error('Studio server requires --studio-root.');
  }

  return {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 3978,
    studioRoot: options.studioRoot,
  };
}

function readOptionValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: StudioServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${options.host}`);

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.', ok: false });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/project') {
    sendJson(response, 200, await readStudioSnapshot(options.studioRoot));
    return;
  }

  if (
    url.pathname === '/' ||
    url.pathname === '/dashboard' ||
    url.pathname === '/dashboard/'
  ) {
    sendHtml(response, renderDashboardHtml());
    return;
  }

  sendJson(response, 404, { error: 'Not found.', ok: false });
}

async function readStudioSnapshot(studioRoot: string): Promise<StudioSnapshot> {
  return {
    activity: await readJsonLines(join(studioRoot, 'activity.jsonl')),
    manifest: await readJsonFile(join(studioRoot, 'manifest.json')),
    pipeline: await readJsonFile(join(studioRoot, 'pipeline.json')),
    project: await readJsonFile(join(studioRoot, 'project.json')),
    provenance: await readJsonLines(join(studioRoot, 'provenance.jsonl')),
    studio: await readJsonFile(join(studioRoot, 'studio.json')),
    studioRoot,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readJsonLines(path: string): Promise<unknown[]> {
  if (!existsSync(path)) {
    return [];
  }

  const lines = (await readFile(path, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(-50).map((line) => JSON.parse(line) as unknown);
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PostPlus Studio</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #1f2933; }
    header { border-bottom: 1px solid #d6d8dc; background: #ffffff; padding: 20px 28px; }
    main { display: grid; gap: 16px; grid-template-columns: 280px minmax(0, 1fr); padding: 20px 28px 28px; }
    h1 { font-size: 22px; line-height: 1.2; margin: 0 0 6px; }
    h2 { font-size: 13px; letter-spacing: 0; line-height: 1.25; margin: 0 0 10px; text-transform: uppercase; color: #5b6472; }
    p { margin: 0; }
    .subtle { color: #627083; font-size: 13px; }
    .panel { background: #ffffff; border: 1px solid #d8dce2; border-radius: 8px; padding: 14px; min-width: 0; }
    .stack { display: grid; gap: 12px; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .row { align-items: center; display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #edf0f2; padding-top: 10px; margin-top: 10px; }
    .label { color: #5b6472; font-size: 12px; }
    .value { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
    .step { border: 1px solid #dfe3e8; border-radius: 6px; padding: 10px; background: #fbfbfa; }
    .step-title { font-size: 13px; font-weight: 700; }
    .status { color: #0f766e; font-size: 12px; margin-top: 4px; }
    pre { background: #111827; border-radius: 8px; color: #e5e7eb; font-size: 12px; line-height: 1.45; margin: 0; max-height: 420px; overflow: auto; padding: 12px; white-space: pre-wrap; }
    @media (max-width: 840px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 18px 16px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>PostPlus Studio</h1>
    <p class="subtle" id="studio-root">Loading workspace...</p>
  </header>
  <main>
    <section class="stack">
      <div class="panel">
        <h2>Project</h2>
        <div class="row"><span class="label">Name</span><span class="value" id="project-name">-</span></div>
        <div class="row"><span class="label">Status</span><span class="value" id="project-status">-</span></div>
      </div>
      <div class="panel">
        <h2>Pipeline</h2>
        <div id="pipeline-steps" class="stack"></div>
      </div>
    </section>
    <section class="stack">
      <div class="grid">
        <div class="panel"><h2>Assets</h2><p class="value" id="asset-count">-</p></div>
        <div class="panel"><h2>Activity</h2><p class="value" id="activity-count">-</p></div>
        <div class="panel"><h2>Provenance</h2><p class="value" id="provenance-count">-</p></div>
      </div>
      <div class="panel">
        <h2>Workspace JSON</h2>
        <pre id="snapshot">{}</pre>
      </div>
    </section>
  </main>
  <script>
    const text = (id, value) => { document.getElementById(id).textContent = value ?? '-'; };
    const render = async () => {
      const response = await fetch('/api/project');
      const data = await response.json();
      const project = data.project || {};
      const pipeline = data.pipeline || {};
      const manifest = data.manifest || {};
      text('studio-root', data.studioRoot || '');
      text('project-name', project.name || project.project_id || 'PostPlus Studio');
      text('project-status', project.status || 'active');
      text('asset-count', Array.isArray(manifest.assets) ? String(manifest.assets.length) : '0');
      text('activity-count', Array.isArray(data.activity) ? String(data.activity.length) : '0');
      text('provenance-count', Array.isArray(data.provenance) ? String(data.provenance.length) : '0');
      const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
      document.getElementById('pipeline-steps').innerHTML = steps.map((step) =>
        '<div class="step"><div class="step-title">' + escapeHtml(step.name || step.id || 'Step') + '</div><div class="status">' + escapeHtml(step.status || 'pending') + '</div></div>'
      ).join('') || '<p class="subtle">No pipeline steps yet.</p>';
      document.getElementById('snapshot').textContent = JSON.stringify(data, null, 2);
    };
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    render().catch((error) => {
      document.getElementById('snapshot').textContent = error.stack || error.message || String(error);
    });
  </script>
</body>
</html>`;
}

if (process.argv[1] && basename(process.argv[1])?.startsWith('studio-server')) {
  startStudioServer().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
