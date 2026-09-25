import { setTimeout as delay } from 'node:timers/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
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

export async function runChannelsCommand(args: string[]): Promise<number> {
  if (
    !args.length ||
    args.some((arg) => ['help', '--help', '-h'].includes(arg))
  ) {
    process.stdout.write(
      'postplus channels list|show <connection-id>|connect <channel>|wait <connection-id>|disconnect <connection-id> [--json]\npostplus channels tools list [--toolkit <id>] [--query <text>] [--offset <n>] [--limit <n>] | show <tool-slug> | run <tool-slug> --connection <id> --input-file <json-path> [--media-map-file <json-path>] [--target-id <id> --target-path <argument.path>] [--operation-id <id>] [--wait] | run --status <operation-id>\nTools shows the pinned Composio catalog and PostPlus gate; enabled does not prove your third-party permission, which is checked on execution. For exact external targets, provide an ID and the JSON argument path containing it. Media map JSON maps file argument paths to references from postplus media-file upload. Connections belong to you and can be reused across workspaces. Disconnect affects all your workspaces. Channel run exit 2 means result unknown: query the original operation with tools run --status; do not resubmit it.\n',
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
  const auth = await resolveFreshRemoteAuth();
  const response = await sendAuthedCloudRequest({
    auth,
    ...command,
    timeoutMs: 90_000,
    retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      'PostPlus returned invalid channel JSON. Check connection status before retrying.',
    );
  }
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'Channel request failed. Check its status before retrying.';
    throw new Error(message);
  }
  // JSON is also the lossless text representation until per-action renderers exist.
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}
