import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';

// Read-only PostPlus Cloud account diagnostics driven by the CLI session:
//   postplus balance [--json]
//   postplus runs list [--status <s>] [--since <iso>] [--limit <n>] [--json]
//   postplus runs show <run-id> [--json]
// Every command here is a GET against a hosted read projection — it never
// reserves credit, never writes the ledger, and never mutates a run. It is the
// execution-before budget signal (balance) and the execution-after visibility
// (runs list/show) that let an agent stop guessing about spend and lost handles.

// Shared GET envelope for the bin path: resolve fresh session auth from disk,
// issue a single 401-refresh retry, and surface a compatibility or product error
// verbatim instead of collapsing it to a generic message.
async function getAuthedJson(pathName: string): Promise<unknown> {
  const response = await sendAuthedCloudRequest({
    auth: await resolveFreshRemoteAuth(),
    method: 'GET',
    pathName,
    retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      throw new Error(compatibilityError);
    }
    throw new Error(readErrorMessage(payload));
  }

  return payload;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('PostPlus Cloud returned invalid JSON.');
  }
}

function readErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim();
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
  }
  return 'PostPlus Cloud request failed.';
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

export type HostedBalanceReport = {
  accountId: string;
  accountType: 'personal' | 'team' | null;
  accountName: string | null;
  availableCredits: number;
  availableMillicredits: number;
  reservedMillicredits: number;
  subscriptionStatus: string | null;
};

export async function fetchHostedBalance(): Promise<HostedBalanceReport> {
  const payload = await getAuthedJson('/api/postplus-cli/hosted/balance');
  return normalizeBalanceReport(payload);
}

function normalizeBalanceReport(payload: unknown): HostedBalanceReport {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PostPlus Cloud returned an invalid balance response.');
  }
  const record = payload as Record<string, unknown>;
  return {
    accountId: readString(record.accountId) ?? '',
    accountType: readAccountType(record.accountType),
    accountName: readString(record.accountName),
    availableCredits: readNumber(record.availableCredits) ?? 0,
    availableMillicredits: readNumber(record.availableMillicredits) ?? 0,
    reservedMillicredits: readNumber(record.reservedMillicredits) ?? 0,
    subscriptionStatus: readString(record.subscriptionStatus),
  };
}

export function formatHostedBalanceReport(report: HostedBalanceReport): string {
  const accountLabel = report.accountName
    ? `${report.accountName}${report.accountType ? ` (${report.accountType})` : ''}`
    : (report.accountType ?? report.accountId);

  return [
    'PostPlus balance',
    '',
    `Account: ${accountLabel}`,
    `Available credits: ${report.availableCredits}`,
    `Reserved (in-flight): ${report.reservedMillicredits} millicredits`,
    `Subscription: ${report.subscriptionStatus ?? 'none'}`,
  ].join('\n');
}

export async function runBalanceCommand(args: string[]): Promise<number> {
  const json = assertOnlyJsonFlag(args, 'balance');
  const report = await fetchHostedBalance();

  if (json) {
    writeJson(report);
  } else {
    process.stdout.write(`${formatHostedBalanceReport(report)}\n`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// runs list / runs show
// ---------------------------------------------------------------------------

export type HostedRunSummary = {
  id: string;
  capability: string;
  status: string;
  target: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedMillicredits: number;
  reservedMillicredits: number;
  providerStatus: string | null;
  hasError: boolean;
};

export type HostedRunsListReport = {
  runs: HostedRunSummary[];
  count: number;
  filters: {
    status: string | null;
    since: string | null;
    limit: number;
  };
};

// Full single-run projection with settled actual cost — the reconciliation
// WaveSpeed's history/show cannot do (its records carry no per-run cost).
export type HostedRunDetail = HostedRunSummary & {
  operationId: string;
  providerFamily: string | null;
  providerModelPath: string | null;
  providerTaskId: string | null;
  providerUrls: unknown;
  outputs: unknown;
  error: unknown;
  requestDimensions: unknown;
  completedAt: string | null;
  failedAt: string | null;
  expiresAt: string | null;
};

export type RunsListOptions = {
  status: string | null;
  since: string | null;
  limit: number | null;
  json: boolean;
};

export function parseRunsListOptions(args: string[]): RunsListOptions {
  const options: RunsListOptions = {
    status: null,
    since: null,
    limit: null,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--status') {
      options.status = requireOptionValue(args, index, 'status');
      index += 1;
      continue;
    }

    if (arg === '--since') {
      options.since = requireOptionValue(args, index, 'since');
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      const raw = requireOptionValue(args, index, 'limit');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--limit must be a positive integer.');
      }
      options.limit = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option for runs list: ${arg}`);
  }

  return options;
}

export function buildRunsListPath(options: RunsListOptions): string {
  const query = new URLSearchParams();
  if (options.status) {
    query.set('status', options.status);
  }
  if (options.since) {
    query.set('since', options.since);
  }
  if (options.limit !== null) {
    query.set('limit', String(options.limit));
  }
  const suffix = query.toString();
  return suffix
    ? `/api/postplus-cli/hosted/runs?${suffix}`
    : '/api/postplus-cli/hosted/runs';
}

export async function fetchHostedRunsList(
  options: RunsListOptions,
): Promise<HostedRunsListReport> {
  const payload = await getAuthedJson(buildRunsListPath(options));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PostPlus Cloud returned an invalid runs list response.');
  }
  const record = payload as Record<string, unknown>;
  const runs = Array.isArray(record.runs)
    ? record.runs.map(normalizeRunSummary)
    : [];
  return {
    runs,
    count: readNumber(record.count) ?? runs.length,
    filters: {
      status: options.status,
      since: options.since,
      limit: options.limit ?? runs.length,
    },
  };
}

export async function fetchHostedRunDetail(
  runId: string,
): Promise<HostedRunDetail> {
  const payload = await getAuthedJson(
    `/api/postplus-cli/hosted/runs/${encodeURIComponent(runId)}`,
  );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PostPlus Cloud returned an invalid run detail response.');
  }
  const record = payload as Record<string, unknown>;
  const summary = normalizeRunSummary(record);
  return {
    ...summary,
    operationId: readString(record.operationId) ?? '',
    providerFamily: readString(record.providerFamily),
    providerModelPath: readString(record.providerModelPath),
    providerTaskId: readString(record.providerTaskId),
    providerUrls: record.providerUrls ?? null,
    outputs: record.outputs ?? null,
    error: record.error ?? null,
    requestDimensions: record.requestDimensions ?? null,
    completedAt: readString(record.completedAt),
    failedAt: readString(record.failedAt),
    expiresAt: readString(record.expiresAt),
  };
}

function normalizeRunSummary(value: unknown): HostedRunSummary {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    id: readString(record.id) ?? '',
    capability: readString(record.capability) ?? '',
    status: readString(record.status) ?? '',
    target: readString(record.target),
    createdAt: readString(record.createdAt) ?? '',
    updatedAt: readString(record.updatedAt) ?? '',
    finalizedMillicredits: readNumber(record.finalizedMillicredits) ?? 0,
    reservedMillicredits: readNumber(record.reservedMillicredits) ?? 0,
    providerStatus: readString(record.providerStatus),
    hasError: record.hasError === true,
  };
}

export function formatHostedRunsListReport(
  report: HostedRunsListReport,
): string {
  const lines = ['PostPlus runs', ''];
  const filterParts = [
    report.filters.status ? `status=${report.filters.status}` : null,
    report.filters.since ? `since=${report.filters.since}` : null,
    `limit=${report.filters.limit}`,
  ].filter((part): part is string => part !== null);
  lines.push(`Filters: ${filterParts.join(' ')}`);
  lines.push('');

  if (report.runs.length === 0) {
    lines.push('No runs found. Submit a media or research run first.');
    return lines.join('\n');
  }

  for (const run of report.runs) {
    const cost =
      run.status === 'completed' || run.finalizedMillicredits > 0
        ? `${run.finalizedMillicredits}mc`
        : `~${run.reservedMillicredits}mc reserved`;
    lines.push(
      `- ${run.id}  [${run.status}]  ${run.capability}${run.target ? ` ${run.target}` : ''}  ${cost}  ${run.updatedAt}`,
    );
  }
  lines.push('');
  lines.push('Resume any run: postplus runs show <run-id>');
  return lines.join('\n');
}

export function formatHostedRunDetailReport(report: HostedRunDetail): string {
  const settled =
    report.status === 'completed' || report.finalizedMillicredits > 0;
  return [
    `PostPlus run ${report.id}`,
    '',
    `Status: ${report.status}${report.providerStatus ? ` (provider: ${report.providerStatus})` : ''}`,
    `Capability: ${report.capability}${report.target ? ` ${report.target}` : ''}`,
    `Provider: ${report.providerFamily ?? 'unknown'}${report.providerModelPath ? ` ${report.providerModelPath}` : ''}`,
    settled
      ? `Settled cost: ${report.finalizedMillicredits} millicredits (actual)`
      : `Reserved: ${report.reservedMillicredits} millicredits (not yet settled)`,
    `Created: ${report.createdAt}`,
    `Updated: ${report.updatedAt}`,
    report.hasError ? 'Error: see error field (postplus runs show --json)' : '',
    '',
    report.status === 'completed' || report.status === 'failed'
      ? 'This run is terminal.'
      : `Still running. Resume: postplus media poll --handle ${report.providerTaskId ?? report.id}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export async function runRunsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === 'list') {
    const options = parseRunsListOptions(rest);
    const report = await fetchHostedRunsList(options);
    if (options.json) {
      writeJson(report);
    } else {
      process.stdout.write(`${formatHostedRunsListReport(report)}\n`);
    }
    return 0;
  }

  if (subcommand === 'show') {
    const [runId, ...showRest] = rest;
    if (!runId || runId.startsWith('--')) {
      throw new Error('runs show requires a run id: postplus runs show <id>.');
    }
    const json = assertOnlyJsonFlag(showRest, 'runs show');
    const report = await fetchHostedRunDetail(runId);
    if (json) {
      writeJson(report);
    } else {
      process.stdout.write(`${formatHostedRunDetailReport(report)}\n`);
    }
    return 0;
  }

  printRunsHelp();
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

function printRunsHelp(): void {
  process.stdout.write(`PostPlus CLI - runs commands

Usage:
  postplus runs list [--status <status>] [--since <iso-8601>] [--limit <n>] [--json]
  postplus runs show <run-id> [--json]

Runs are read-only hosted run history for the selected account. list defaults to
the most recent runs; show returns the full record including settled actual cost.
`);
}

function assertOnlyJsonFlag(args: string[], command: string): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown option for ${command}: ${arg}`);
  }
  return json;
}

function requireOptionValue(
  args: string[],
  index: number,
  key: string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}.`);
  }
  return value;
}

function isHelp(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readAccountType(value: unknown): 'personal' | 'team' | null {
  return value === 'personal' || value === 'team' ? value : null;
}
