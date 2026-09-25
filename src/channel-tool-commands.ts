import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { PostPlusClientUpgradeRequiredError } from './client-compatibility.js';
import {
  HostedCompatibilityRequestError,
  HostedProductRequestError,
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
  if (operation === 'run' && first === '--status') {
    const operationId = rest[0];
    if (!operationId || rest.slice(1).some((part) => part !== '--json'))
      throw new Error('Use channels tools run --status <operation-id>.');
    return { operation: 'status' as const, operationId };
  }
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
          ![
            '--connection',
            '--input-file',
            '--media-map-file',
            '--operation-id',
            '--target-id',
            '--target-path',
          ].includes(key),
      )
    )
      throw new Error('Unknown channel tool run flag.');
    const connectionId = values.get('--connection');
    const inputFile = values.get('--input-file');
    if (!connectionId || !inputFile)
      throw new Error('Tool run requires --connection and --input-file.');
    if (
      Boolean(values.get('--target-id')) !==
      Boolean(values.get('--target-path'))
    )
      throw new Error(
        'Exact targets require both --target-id and --target-path.',
      );
    return {
      operation: 'run' as const,
      tool: first,
      connectionId,
      targetId: values.get('--target-id'),
      targetPath: values.get('--target-path'),
      inputFile,
      mediaMapFile: values.get('--media-map-file'),
      operationId: values.get('--operation-id') ?? randomUUID(),
      wait: booleans.has('--wait'),
    };
  }
  throw new Error(
    'Use channels tools list [--toolkit <id>] [--query <text>] [--offset <n>] [--limit <n>] | show <tool-slug> | run <tool-slug> --connection <id> --input-file <json-path> [--media-map-file <json-path>] [--target-id <id> --target-path <argument.path>] [--operation-id <id>] [--wait] | run --status <operation-id>.',
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

export function shouldPollChannelTool(wait: boolean, value: unknown) {
  return (
    wait &&
    !['succeeded', 'failed', 'unknown'].includes(
      readRun(value)?.execution?.resultStatus ?? '',
    )
  );
}

function channelToolExitCode(value: unknown): 0 | 1 | 2 {
  const status = readRun(value)?.execution?.resultStatus;
  if (status === 'failed') return 1;
  if (status === 'unknown') return 2;
  return 0;
}

export function lostChannelToolSubmission(operationId: string) {
  return {
    operationId,
    execution: { resultStatus: 'unknown' as const },
    next: `Query postplus channels tools run --status ${operationId}; never resubmit this write with a new operation ID.`,
  };
}

export function buildChannelToolRequest(
  command: Extract<
    ReturnType<typeof parseChannelToolCommand>,
    { operation: 'run' }
  >,
  argumentsValue: unknown,
  mediaReferences?: Record<string, string>,
) {
  if (
    !argumentsValue ||
    typeof argumentsValue !== 'object' ||
    Array.isArray(argumentsValue)
  )
    throw new Error('Tool input must be a JSON object.');
  return {
    capability: 'marketing-channels' as const,
    operation: 'execute-tool' as const,
    operationId: command.operationId,
    tool: command.tool,
    connectionId: command.connectionId,
    target: command.targetId
      ? {
          kind: 'external_id' as const,
          id: command.targetId,
          path: command.targetPath,
        }
      : { kind: 'connection' as const },
    arguments: argumentsValue,
    ...(mediaReferences ? { mediaReferences } : {}),
  };
}

export async function runChannelToolCommand(
  args: string[],
  dependencies: {
    readInput?: (path: string) => Promise<string>;
    submit?: typeof postHostedJson;
    output?: (text: string) => void;
    diagnostic?: (text: string) => void;
  } = {},
): Promise<number> {
  const command = parseChannelToolCommand(args);
  const submit = dependencies.submit ?? postHostedJson;
  const output =
    dependencies.output ?? ((value: string) => process.stdout.write(value));
  const diagnostic =
    dependencies.diagnostic ?? ((value: string) => process.stderr.write(value));
  if (command.operation === 'status') {
    const result = await submit({
      skillName: null,
      pathName: '/api/postplus-cli/hosted/capability',
      body: {
        capability: 'marketing-channels',
        operation: 'status',
        operationId: command.operationId,
      },
    });
    output(`${JSON.stringify(result, null, 2)}\n`);
    return channelToolExitCode(result);
  }
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
    output(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(
      await (dependencies.readInput
        ? dependencies.readInput(command.inputFile)
        : readFile(command.inputFile, 'utf8')),
    );
  } catch (error) {
    if (
      (error instanceof HostedProductRequestError &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500 &&
        error.httpStatus !== 408 &&
        error.httpStatus !== 429) ||
      error instanceof HostedCompatibilityRequestError ||
      error instanceof PostPlusClientUpgradeRequiredError
    )
      throw error;
    throw new Error('Tool input file must contain valid JSON.');
  }
  let mediaReferences: Record<string, string> | undefined;
  if (command.mediaMapFile) {
    let raw: unknown;
    try {
      raw = JSON.parse(
        await (dependencies.readInput
          ? dependencies.readInput(command.mediaMapFile)
          : readFile(command.mediaMapFile, 'utf8')),
      );
    } catch {
      throw new Error('Media map file must contain valid JSON.');
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.values(raw).some((value) => typeof value !== 'string')
    )
      throw new Error(
        'Media map must be a JSON object of argument paths to PostPlus file references.',
      );
    mediaReferences = raw as Record<string, string>;
  }
  const body = buildChannelToolRequest(
    command,
    argumentsValue,
    mediaReferences,
  );
  const statusRequest = {
    capability: 'marketing-channels',
    operation: 'status',
    operationId: command.operationId,
  };
  // The caller can inspect this ID if the submit response is lost.
  diagnostic(`Channel operation: ${command.operationId}\n`);
  if (command.targetId) diagnostic(`Target ID: ${command.targetId}\n`);
  let result: unknown;
  try {
    result = await submit({
      skillName: null,
      pathName: '/api/postplus-cli/hosted/capability',
      body,
    });
  } catch (error) {
    if (
      (error instanceof HostedProductRequestError &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500 &&
        error.httpStatus !== 408 &&
        error.httpStatus !== 429) ||
      error instanceof HostedCompatibilityRequestError ||
      error instanceof PostPlusClientUpgradeRequiredError
    )
      throw error;
    // The request may have reached hosted even if its response was lost. The
    // durable run can be inspected by ID, but this CLI must never resubmit it.
    output(
      `${JSON.stringify(lostChannelToolSubmission(command.operationId), null, 2)}\n`,
    );
    return 2;
  }
  // A successful read carries its data only in the first response. Polling a
  // completed run would replace that response with its metadata-only receipt.
  if (shouldPollChannelTool(command.wait, result))
    result = await pollHostedRunUntilSettled({
      pollIntervalMs: 1000,
      waitBudgetMs: 60_000,
      pollOnce: () =>
        submit({
          skillName: null,
          pathName: '/api/postplus-cli/hosted/capability',
          body: statusRequest,
        }),
      readStatus: (value) => readRun(value)?.status ?? null,
      stopWaiting: (value) =>
        readRun(value)?.execution?.resultStatus === 'unknown',
    });
  output(`${JSON.stringify(result, null, 2)}\n`);
  return channelToolExitCode(result);
}
