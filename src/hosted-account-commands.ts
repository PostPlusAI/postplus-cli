import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { readPostPlusCompatibilityError } from './client-compatibility.js';
import { clearUpdateCheckCache } from './update-check.js';

// Read-only PostPlus Cloud account diagnostics driven by the CLI session:
//   postplus balance [--json]
//   postplus runs list [--status <s>] [--since <iso>] [--limit <n>] [--json]
//   postplus runs show <run-id> [--json]
// Every command here is a GET against a hosted read projection — it never
// reserves credit, never writes the ledger, and never mutates a run. It is the
// execution-before budget signal (balance) and the execution-after visibility
// (runs list/show) that let an agent stop guessing about spend and lost handles.

// These reads GATE spend decisions (an agent checks balance/runs right before
// a 120s hosted spend POST), so they must not be flakier than the spend they
// guard: with the 15s authed-request default, a slow-but-working network made
// the budget signal fail before the spend it was protecting (2026-07-13
// timeout audit). 30s keeps the fast-fail character of a read while doubling
// the headroom; the spend ceiling stays 120s.
const ACCOUNT_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 30_000;

// Shared GET envelope for the bin path: resolve fresh session auth from disk,
// issue a single 401-refresh retry, and surface a compatibility or product error
// verbatim instead of collapsing it to a generic message.
async function getAuthedJson(pathName: string): Promise<unknown> {
  const response = await sendAuthedCloudRequest({
    auth: await resolveFreshRemoteAuth(),
    method: 'GET',
    pathName,
    retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
    timeoutMs: ACCOUNT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const compatibilityError = readPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      await clearUpdateCheckCache();
      throw compatibilityError;
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
  reservedCredits: number;
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
    reservedCredits: readNumber(record.reservedCredits) ?? 0,
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
    `Reserved (in-flight): ${report.reservedCredits} credits`,
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
  finalizedCredits: number | null;
  reservedCredits: number | null;
  billingPending?: boolean;
  estimatedOnly?: boolean;
  hasError: boolean;
  stage?: string | null;
  progress?: Partial<
    Record<'bytes' | 'totalBytes' | 'elapsedMs' | 'attempt', number>
  >;
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

// Full single-run product projection. Provider identity, task ids, URLs,
// request dimensions and raw settlement evidence stay server-side.
export type HostedRunDetail = HostedRunSummary & {
  operationId: string;
  outputs: unknown;
  error: unknown;
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
    outputs: record.outputs ?? null,
    error: record.error ?? null,
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
    finalizedCredits:
      record.billingPending === true
        ? null
        : readNumber(record.finalizedCredits),
    reservedCredits:
      record.billingPending === true
        ? null
        : readNumber(record.reservedCredits),
    ...(typeof record.billingPending === 'boolean'
      ? { billingPending: record.billingPending }
      : {}),
    ...(Object.hasOwn(record, 'stage')
      ? { stage: readString(record.stage) }
      : {}),
    ...(record.progress &&
    typeof record.progress === 'object' &&
    !Array.isArray(record.progress)
      ? {
          progress: Object.fromEntries(
            ['bytes', 'totalBytes', 'elapsedMs', 'attempt'].flatMap((key) => {
              const value = (record.progress as Record<string, unknown>)[key];
              return typeof value === 'number' &&
                Number.isFinite(value) &&
                value >= 0
                ? [[key, value]]
                : [];
            }),
          ),
        }
      : {}),
    hasError: record.hasError === true,
    ...(record.estimatedOnly === true ? { estimatedOnly: true } : {}),
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
    const cost = run.billingPending
      ? 'billing pending verification'
      : run.status === 'completed' || (run.finalizedCredits ?? 0) > 0
        ? `${run.finalizedCredits ?? 'unknown'} credits${run.estimatedOnly ? ' (estimated settlement)' : ''}`
        : `~${run.reservedCredits ?? 'unknown'} credits reserved`;
    lines.push(
      `- ${run.id}  [${run.status}]  ${run.capability}${run.target ? ` ${run.target}` : ''}  ${cost}${formatRunProgress(run) ? `  ${formatRunProgress(run)}` : ''}  ${run.updatedAt}`,
    );
  }
  lines.push('');
  lines.push('Resume any run: postplus runs show <run-id>');
  return lines.join('\n');
}

function formatRunProgress(run: HostedRunSummary): string {
  return [
    run.stage ? `stage=${run.stage}` : '',
    ...Object.entries(run.progress ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    ),
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatHostedRunDetailReport(report: HostedRunDetail): string {
  const settled =
    report.status === 'completed' || (report.finalizedCredits ?? 0) > 0;
  return [
    `PostPlus run ${report.id}`,
    '',
    `Status: ${report.status}`,
    formatRunProgress(report),
    `Capability: ${report.capability}${report.target ? ` ${report.target}` : ''}`,
    report.billingPending
      ? 'Billing: pending verification; do not submit another analysis.'
      : settled
        ? `Finalized: ${report.finalizedCredits ?? 'unknown'} PostPlus credits${report.estimatedOnly ? ' (estimated settlement; actual usage unconfirmed)' : ''}`
        : `Reserved: ${report.reservedCredits ?? 'unknown'} PostPlus credits`,
    `Created: ${report.createdAt}`,
    `Updated: ${report.updatedAt}`,
    report.hasError ? 'Error: see error field (postplus runs show --json)' : '',
    '',
    report.status === 'completed' || report.status === 'failed'
      ? 'This run is terminal.'
      : `Still running. Refresh: postplus runs show ${report.id}`,
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
