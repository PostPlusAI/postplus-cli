import { randomUUID } from 'node:crypto';

import { marketingChannelActions } from './generated/marketing-channel-manifest.generated.js';
import {
  pollHostedRunUntilSettled,
  postHostedJson,
} from './hosted-command-runtime.js';

export function parseChannelRun(args: string[]) {
  const [action, ...rest] = args;
  const spec = marketingChannelActions.find((entry) => entry.action === action);
  if (!spec) throw new Error('Unknown action. Run postplus channels actions.');
  const flags = new Map<string, string>();
  let wait = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json') continue;
    if (key === '--wait') {
      wait = true;
      continue;
    }
    if (
      !key.startsWith('--') ||
      !rest[i + 1] ||
      rest[i + 1]!.startsWith('--') ||
      flags.has(key)
    )
      throw new Error(`Invalid channel flag: ${key}`);
    flags.set(key, rest[++i]!);
  }
  const take = (name: string) => {
    const value = flags.get(name);
    flags.delete(name);
    return value;
  };
  const connectionId = take('--connection');
  if (!connectionId) throw new Error('--connection is required.');
  const operationId = take('--operation-id') ?? randomUUID();
  const arrayValue = (value: string, flag: string) => {
    if (value === '[]') return [];
    const values = value.split(',');
    if (values.some((entry) => !entry))
      throw new Error(`${flag} contains an empty item.`);
    return values;
  };
  const target: Record<string, unknown> = { kind: spec.targetKind };
  for (const field of spec.targetFields) {
    if (field.name === 'kind') continue;
    const flag =
      field.name === 'id'
        ? '--target'
        : '--target-' +
          field.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const value = take(flag);
    if (value === undefined) {
      if (field.required) throw new Error(`${flag} is required.`);
      continue;
    }
    target[field.name] =
      field.type === 'array' ? arrayValue(value, flag) : value;
  }
  const parameters: Record<string, unknown> = {};
  for (const field of spec.parameters) {
    const flag =
      '--' +
      field.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const value = take(flag);
    if (value === undefined) {
      if (field.required) throw new Error(`${flag} is required.`);
      continue;
    }
    parameters[field.name] =
      field.type === 'number'
        ? Number(value)
        : field.type === 'array'
          ? arrayValue(value, flag)
          : value;
    if (field.type === 'number' && !Number.isFinite(parameters[field.name]))
      throw new Error(`${flag} must be numeric.`);
  }
  if (flags.size)
    throw new Error(
      `Unexpected channel flags: ${[...flags.keys()].join(', ')}`,
    );
  return {
    wait,
    request: {
      capability: 'marketing-channels',
      operation: 'execute',
      action,
      connectionId,
      operationId,
      target,
      parameters,
    },
  };
}

export async function runChannelExecution(args: string[]): Promise<number> {
  const [operation, ...rest] = args;
  if (operation === 'actions') {
    process.stdout.write(
      `${JSON.stringify(marketingChannelActions, null, 2)}\n`,
    );
    return 0;
  }
  const parsed = operation === 'run' ? parseChannelRun(rest) : null;
  const operationId = parsed?.request.operationId ?? rest[0];
  if (
    !operationId ||
    (!parsed &&
      (operation !== 'run-status' ||
        rest.some((value, index) => index > 0 && value !== '--json')))
  )
    throw new Error(
      'Use channels run <action> --connection <id> ... or channels run-status <operation-id>.',
    );
  const statusRequest = {
    capability: 'marketing-channels',
    operation: 'status',
    operationId,
  };
  // Print the identity before submit so a lost response can be queried without resending.
  if (parsed) process.stderr.write(`Channel operation: ${operationId}\n`);
  let result = await postHostedJson({
    skillName: null,
    pathName: '/api/postplus-cli/hosted/capability',
    body: parsed?.request ?? statusRequest,
  });
  if (parsed?.wait) {
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
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return channelRunExitCode(result);
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

export function channelRunExitCode(value: unknown): 0 | 1 | 2 {
  const resultStatus = readRun(value)?.execution?.resultStatus;
  if (resultStatus === 'failed') return 1;
  if (resultStatus === 'unknown') return 2;
  return 0;
}
