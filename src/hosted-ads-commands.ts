import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  type AuthedCloudRequestAuth,
  type AuthedCloudRequestInput,
  sendAuthedCloudRequest,
} from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';
import type { HostedRequestContext } from './hosted-domain-commands.js';

const HOSTED_ADS_QUERY_TIMEOUT_MS = 45_000;
const HOSTED_ADS_MAX_SELECTED_BINDINGS = 10;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

type HostedAdsProvider = 'google' | 'meta_ads';
type HostedAdsScope =
  | { type: 'all_linked' }
  | { type: 'current' }
  | { bindingIds: string[]; type: 'selected' };

type ParsedHostedAdsPerformanceCommand = {
  body: {
    parameters: Record<string, string>;
    queryId:
      | 'google_ads.campaign.performance_daily.v1'
      | 'meta_ads.insights.account_daily.v1';
    scope: HostedAdsScope;
  };
  pathName: string;
};

export type HostedAdsCommandDependencies = {
  resolveAuth(options?: {
    forceRefresh?: boolean;
  }): Promise<AuthedCloudRequestAuth>;
  sendRequest(input: AuthedCloudRequestInput): Promise<Response>;
  writeJson(value: unknown): void;
};

const DEFAULT_DEPENDENCIES: HostedAdsCommandDependencies = {
  resolveAuth: resolveFreshRemoteAuth,
  sendRequest: sendAuthedCloudRequest,
  writeJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
};

export class HostedAdsRequestError extends Error {
  constructor(
    readonly failure: {
      code: string;
      message: string;
      retryable: boolean;
      status: number;
    },
  ) {
    super(
      `${failure.message} (code=${failure.code}, status=${failure.status}, retryable=${String(failure.retryable)})`,
    );
    this.name = 'HostedAdsRequestError';
  }
}

export async function runHostedAdsCommand(
  args: string[],
  context?: HostedRequestContext,
  dependencyOverrides: Partial<HostedAdsCommandDependencies> = {},
): Promise<number | unknown> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || isHelp(subcommand)) {
    printHostedAdsHelp();
    return 0;
  }
  if (subcommand !== 'performance') {
    throw new Error(`Unknown ads command: ${subcommand}.`);
  }

  const command = parsePerformanceCommand(rest);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const protectedTokens = new Set<string>();
  const resolveAuth: HostedAdsCommandDependencies['resolveAuth'] = async (
    options,
  ) => {
    const auth = await dependencies.resolveAuth(options);
    protectedTokens.add(auth.cliSessionToken);
    return auth;
  };
  const requestInput: Omit<AuthedCloudRequestInput, 'auth'> = {
    body: command.body,
    method: 'POST',
    pathName: command.pathName,
    timeoutMs: HOSTED_ADS_QUERY_TIMEOUT_MS,
  };
  const response = context
    ? await dependencies.sendRequest({
        ...requestInput,
        auth: context.auth,
        skillsReleaseId: context.skillsReleaseId ?? null,
      })
    : await dependencies.sendRequest({
        ...requestInput,
        auth: await resolveAuth(),
        retryOn401: () => resolveAuth({ forceRefresh: true }),
      });
  const payload = await readJsonResponse(response);

  assertNoSessionToken(payload, protectedTokens, context?.auth.cliSessionToken);
  if (!response.ok) {
    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) throw new Error(compatibilityError);
    const failure = normalizeHostedAdsFailure(payload);
    if (!failure) {
      throw new Error(
        `PostPlus hosted Ads request failed (status=${response.status}).`,
      );
    }
    if (context) throw new HostedAdsRequestError(failure);
    dependencies.writeJson(payload);
    return 1;
  }

  if (context) return payload;
  dependencies.writeJson(payload);
  return 0;
}

function parsePerformanceCommand(
  args: string[],
): ParsedHostedAdsPerformanceCommand {
  const flags = parseStrictFlags(args);
  if (!flags.json) {
    throw new Error('ads performance requires --json.');
  }
  const provider = requireProvider(flags.values.get('provider'));
  const scope = requireScope(flags.values.get('scope'), flags.bindingIds);
  const dateFrom = flags.values.get('date-from');
  const dateTo = flags.values.get('date-to');

  if (provider === 'google') {
    if (!dateFrom || !dateTo || !isGoogleDateRange(dateFrom, dateTo)) {
      throw new Error(
        'Google Ads performance requires --date-from and --date-to as an inclusive 1–31 day YYYY-MM-DD range.',
      );
    }
    return {
      body: {
        parameters: { dateFrom, dateTo },
        queryId: 'google_ads.campaign.performance_daily.v1',
        scope,
      },
      pathName: '/api/postplus-cli/hosted/ads/google/query-batch',
    };
  }

  if (dateFrom !== undefined || dateTo !== undefined) {
    throw new Error(
      'Meta Ads performance v1 is fixed to yesterday; omit --date-from and --date-to.',
    );
  }
  return {
    body: {
      parameters: {},
      queryId: 'meta_ads.insights.account_daily.v1',
      scope,
    },
    pathName: '/api/postplus-cli/hosted/ads/meta_ads/query-batch',
  };
}

function parseStrictFlags(args: string[]) {
  const allowedValues = new Set([
    'binding-id',
    'date-from',
    'date-to',
    'provider',
    'scope',
  ]);
  const values = new Map<string, string>();
  const bindingIds: string[] = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      if (json) throw new Error('Duplicate option: --json.');
      json = true;
      continue;
    }
    if (!argument?.startsWith('--')) {
      throw new Error(`Unexpected ads argument: ${argument ?? ''}.`);
    }
    const key = argument.slice(2);
    if (!allowedValues.has(key)) {
      throw new Error(`Unknown option for ads performance: --${key}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    if (key === 'binding-id') {
      bindingIds.push(value);
    } else {
      if (values.has(key)) throw new Error(`Duplicate option: --${key}.`);
      values.set(key, value);
    }
    index += 1;
  }

  return { bindingIds, json, values };
}

function requireProvider(value: string | undefined): HostedAdsProvider {
  if (value !== 'google' && value !== 'meta_ads') {
    throw new Error('ads performance requires --provider google|meta_ads.');
  }
  return value;
}

function requireScope(
  value: string | undefined,
  bindingIds: string[],
): HostedAdsScope {
  if (value === 'current' || value === 'all-linked') {
    if (bindingIds.length > 0) {
      throw new Error('--binding-id is accepted only with --scope selected.');
    }
    return { type: value === 'current' ? 'current' : 'all_linked' };
  }
  if (value !== 'selected') {
    throw new Error(
      'ads performance requires --scope current|selected|all-linked.',
    );
  }
  if (
    bindingIds.length < 1 ||
    bindingIds.length > HOSTED_ADS_MAX_SELECTED_BINDINGS ||
    new Set(bindingIds).size !== bindingIds.length ||
    bindingIds.some((bindingId) => !CANONICAL_UUID_PATTERN.test(bindingId))
  ) {
    throw new Error(
      'Selected scope requires 1–10 distinct canonical --binding-id UUID values.',
    );
  }
  return { bindingIds, type: 'selected' };
}

function isGoogleDateRange(dateFrom: string, dateTo: string) {
  const from = calendarOrdinal(dateFrom);
  const to = calendarOrdinal(dateTo);
  return (
    from !== null && to !== null && to - from + 1 >= 1 && to - from + 1 <= 31
  );
}

function calendarOrdinal(value: string) {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > (days[month - 1] ?? 0)) return null;
  const previousYear = year - 1;
  let ordinal =
    previousYear * 365 +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    day;
  for (let index = 0; index < month - 1; index += 1) {
    ordinal += days[index] ?? 0;
  }
  return ordinal;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('PostPlus Cloud returned invalid JSON.');
  }
}

function normalizeHostedAdsFailure(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.error)) return null;
  const error = payload.error;
  if (
    payload.ok !== false ||
    payload.namespace !== 'ads' ||
    payload.schemaVersion !== 1 ||
    typeof payload.requestId !== 'string' ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string' ||
    typeof error.retryable !== 'boolean' ||
    typeof error.status !== 'number' ||
    !Number.isInteger(error.status)
  ) {
    return null;
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    status: error.status,
  };
}

function assertNoSessionToken(
  payload: unknown,
  protectedTokens: ReadonlySet<string>,
  contextToken?: string,
) {
  const serialized = JSON.stringify(payload);
  const tokens = new Set(protectedTokens);
  if (contextToken) tokens.add(contextToken);
  for (const token of tokens) {
    if (token && serialized.includes(token)) {
      throw new Error('PostPlus Cloud returned an unsafe Ads response.');
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHelp(value: string) {
  return value === 'help' || value === '--help' || value === '-h';
}

function printHostedAdsHelp() {
  process.stdout.write(
    `PostPlus CLI — read-only Ads performance\n\nUsage:\n  postplus ads performance --provider google --scope current|selected|all-linked --date-from YYYY-MM-DD --date-to YYYY-MM-DD [--binding-id UUID ...] --json\n  postplus ads performance --provider meta_ads --scope current|selected|all-linked [--binding-id UUID ...] --json\n\nSelected scope accepts 1–10 distinct --binding-id values. Meta Ads v1 reads yesterday. Results remain partitioned by account; never total money across currencies.\n`,
  );
}
