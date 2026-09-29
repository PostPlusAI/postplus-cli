import { setTimeout as delay } from 'node:timers/promises';
import { isNetworkFailure, isTlsFailure } from './network-diagnostics.js';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { HostedProductRequestError, readHostedProductError } from './hosted-command-runtime.js';
import { runChannelToolCommand } from './channel-tool-commands.js';

export function parseChannelCommand(args: string[]) {
  const tokens = args.filter((arg) => arg !== '--json');
  const [operation, id, ...rest] = tokens;
  if (rest.length || tokens.some((arg) => arg.startsWith('--')))
    throw new Error('Unexpected channels arguments.');
  if (operation === 'list' && !id)
    return { method: 'GET' as const, pathName: '/api/postplus-cli/channels' };
  if (operation === 'show' && id)
    return {
      method: 'GET' as const,
      pathName: `/api/postplus-cli/channels?connectionId=${encodeURIComponent(id)}`,
    };
  if (operation === 'connect' && id)
    return {
      method: 'POST' as const,
      pathName: '/api/postplus-cli/channels',
      body: { operation: 'connect', channel: id },
    };
  if (operation === 'disconnect' && id)
    return {
      method: 'POST' as const,
      pathName: '/api/postplus-cli/channels',
      body: { operation: 'disconnect', connectionId: id },
    };
  throw new Error(
    'Use postplus channels list|show <id>|connect <channel>|disconnect <id> [--json].',
  );
}

export async function runChannelsCommand(args: string[], dependencies: {
  request?: (command: ReturnType<typeof parseChannelCommand>) => Promise<Response>;
  output?: (text: string) => void;
} = {}): Promise<number> {
  if (
    !args.length ||
    args.some((arg) => ['help', '--help', '-h'].includes(arg))
  ) {
    process.stdout.write(
      `Manage your personal channel connections and discover executable tools.

Connections:
  postplus channels list [--json]
  postplus channels show <connection-id> [--json]
  postplus channels connect <channel> [--json]
  postplus channels wait <connection-id> [--json]
  postplus channels disconnect <connection-id> [--json]

Tools:
  postplus channels tools list [--toolkit <id>] [--query <text>] [--offset <n>] [--limit <n>] [--json]
  postplus channels tools show <tool-slug> [--json]
  postplus channels tools run <tool-slug> --connection <id> --input-file <json-path> [--media-map-file <json-path>] [--target-id <id> --target-path <argument.path>] [--operation-id <id>] [--wait] [--json]
  postplus channels tools run --status <operation-id> [--json]

Start with channels list, select your connection, then tools list and tools show.
Tool availability does not prove your platform permissions; execution checks them.
Connecting and executing require eligible subscription access on your own PostPlus account.
You can also connect and manage accounts in Web Integrations. Complete browser authorization yourself;
use channels wait to confirm the connection is active before continuing the original task.
Connections can be reused across workspaces. Disconnect affects all your workspaces.
For exact external targets, provide the ID and the JSON argument path containing it.
Media map JSON maps file argument paths to references from postplus media-file upload.
Before a write, confirm the exact destination and change with the user.
Channel run exit 2 means result unknown: query the original operation with tools run --status;
do not resubmit it with a new operation ID.
`,
    );
    return 0;
  }
  if (args[0] === 'tools') return runChannelToolCommand(args.slice(1));
  if (['actions', 'run', 'run-status'].includes(args[0] ?? ''))
    throw new Error(
      'Legacy channel action commands have retired. Use channels tools list, show, run, or run --status <operation-id>.',
    );
  if (args[0] === 'wait') {
    const tokens = args.filter((arg) => arg !== '--json');
    if (tokens.length !== 2 || !/^[0-9a-fA-F-]{36}$/.test(tokens[1] ?? ''))
      throw new Error('Use postplus channels wait <connection-id> [--json].');
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const auth = await resolveFreshRemoteAuth();
      const response = await sendAuthedCloudRequest({
        auth,
        method: 'GET',
        pathName: `/api/postplus-cli/channels?connectionId=${encodeURIComponent(tokens[1]!)}`,
        timeoutMs: 15_000,
        retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
      });
      if (!response.ok)
        throw new Error(
          `Connection status request failed (${response.status}).`,
        );
      const payload: unknown = await response.json();
      const connection =
        payload && typeof payload === 'object' && 'connection' in payload
          ? payload.connection
          : null;
      const status =
        connection && typeof connection === 'object' && 'status' in connection
          ? connection.status
          : null;
      if (status === 'active') {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }
      if (status !== 'pending')
        throw new Error(`Connection cannot become active: ${String(status)}.`);
      await delay(2_000);
    }
    throw new Error(
      'Connection did not become active within ten minutes. Inspect it before reconnecting.',
    );
  }
  const command = parseChannelCommand(args);
  const output = dependencies.output ?? ((text: string) => process.stdout.write(text));
  const uncertain = (code = 'response_unavailable') => {
    output(`${JSON.stringify({
      execution: { resultStatus: 'unknown' },
      error: { stage: 'cli_connection_request', code, delivery: 'unconfirmed' },
      next: 'Run postplus channels list and inspect connection status before retrying this change.',
    }, null, 2)}\n`);
    return 2;
  };
  let response: Response;
  try {
    response = dependencies.request
      ? await dependencies.request(command)
      : await sendAuthedCloudRequest({
          auth: await resolveFreshRemoteAuth(),
          ...command,
          timeoutMs: 90_000,
          retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
        });
  } catch (error) {
    if (command.method === 'POST' && (isNetworkFailure(error) || isTlsFailure(error)))
      return uncertain(isTlsFailure(error) ? 'tls_error' : 'network_error');
    throw error;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (command.method === 'POST') return uncertain();
    throw new Error(
      'PostPlus returned invalid channel JSON. Check connection status before retrying.',
    );
  }
  if (!response.ok) {
    throw new HostedProductRequestError(readHostedProductError(payload), response.status);
  }
  // JSON is also the lossless text representation until per-action renderers exist.
  output(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}
