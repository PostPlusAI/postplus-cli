import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { channelRunExitCode } from './channel-run-commands.js';
import {
  pollHostedRunUntilSettled,
  postHostedJson,
} from './hosted-command-runtime.js';

function flags(tokens: string[], booleanFlags: readonly string[] = []) {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i]!;
    if (key === '--json') continue;
    if (booleanFlags.includes(key)) {
      if (booleans.has(key))
        throw new Error(`Duplicate channel tool flag: ${key}`);
      booleans.add(key);
      continue;
    }
    const value = tokens[++i];
    if (
      !key.startsWith('--') ||
      !value ||
      value.startsWith('--') ||
      values.has(key)
    )
      throw new Error(`Invalid channel tool flag: ${key}`);
    values.set(key, value);
  }
  return { values, booleans };
}

export function parseChannelToolCommand(args: string[]) {
  const [operation, first, ...rest] = args;
  if (operation === 'list') {
    const { values } = flags(args.slice(1));
    if (
      [...values.keys()].some(
        (key) => !['--toolkit', '--query', '--offset', '--limit'].includes(key),
      )
    )
      throw new Error('Unknown channel tool search flag.');
    const query = new URLSearchParams();
    for (const [flag, value] of values) query.set(flag.slice(2), value);
    return {
      operation: 'list' as const,
      pathName: `/api/postplus-cli/channels/tools${query.size ? `?${query}` : ''}`,
    };
  }
  if (
    operation === 'show' &&
    first &&
    !first.startsWith('--') &&
    rest.every((part) => part === '--json')
  )
    return {
      operation: 'show' as const,
      pathName: `/api/postplus-cli/channels/tools?tool=${encodeURIComponent(first)}`,
    };
  if (operation === 'run' && first && !first.startsWith('--')) {
    const { values, booleans } = flags(rest, ['--wait']);
    if (
      [...values.keys()].some(
        (key) =>
          !['--connection', '--input-file', '--operation-id'].includes(key),
      )
    )
      throw new Error('Unknown channel tool run flag.');
    const connectionId = values.get('--connection');
    const inputFile = values.get('--input-file');
    if (!connectionId || !inputFile)
      throw new Error('Tool run requires --connection and --input-file.');
    return {
      operation: 'run' as const,
      tool: first,
      connectionId,
      inputFile,
      operationId: values.get('--operation-id') ?? randomUUID(),
      wait: booleans.has('--wait'),
    };
  }
  throw new Error(
    'Use channels tools list [--toolkit <id>] [--query <text>] [--offset <n>] [--limit <n>] | show <tool-slug> | run <tool-slug> --connection <id> --input-file <json-path> [--operation-id <id>] [--wait].',
  );
}

function readRun(
  value: unknown,
): { status?: string; execution?: { resultStatus?: string } } | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('output' in value) ||
    !value.output ||
    typeof value.output !== 'object'
  )
    return null;
  return value.output as {
    status?: string;
    execution?: { resultStatus?: string };
  };
}

export async function runChannelToolCommand(args: string[]): Promise<number> {
  const command = parseChannelToolCommand(args);
  if (command.operation !== 'run') {
    const response = await sendAuthedCloudRequest({
      auth: await resolveFreshRemoteAuth(),
      pathName: command.pathName,
      timeoutMs: 30_000,
      retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
    });
    const payload: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `Channel tool catalog request failed (${response.status}).`,
      );
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(await readFile(command.inputFile, 'utf8'));
  } catch {
    throw new Error('Tool input file must contain valid JSON.');
  }
  if (
    !argumentsValue ||
    typeof argumentsValue !== 'object' ||
    Array.isArray(argumentsValue)
  )
    throw new Error('Tool input must be a JSON object.');
  const statusRequest = {
    capability: 'marketing-channels',
    operation: 'status',
    operationId: command.operationId,
  };
  // The caller can inspect this ID if the submit response is lost.
  process.stderr.write(`Channel operation: ${command.operationId}\n`);
  let result = await postHostedJson({
    skillName: null,
    pathName: '/api/postplus-cli/hosted/capability',
    body: {
      capability: 'marketing-channels',
      operation: 'execute-tool',
      operationId: command.operationId,
      tool: command.tool,
      connectionId: command.connectionId,
      target: { kind: 'connection' },
      arguments: argumentsValue,
    },
  });
  if (command.wait)
    result = await pollHostedRunUntilSettled({
      pollIntervalMs: 1000,
      waitBudgetMs: 60_000,
      pollOnce: () =>
        postHostedJson({
          skillName: null,
          pathName: '/api/postplus-cli/hosted/capability',
          body: statusRequest,
        }),
      readStatus: (value) => readRun(value)?.status ?? null,
      stopWaiting: (value) =>
        readRun(value)?.execution?.resultStatus === 'unknown',
    });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return channelRunExitCode(result);
}
