import readline from 'node:readline/promises';

import { readLocalConfig, updateLocalConfig } from './local-state.js';

const PRODUCT_ERROR_CODE = 'postplus_cli_quote_confirmation_required';

export const QUOTE_AUTO_CONFIRM_CEILING_EXCEEDED_CODE =
  'postplus_cli_quote_auto_confirm_ceiling_exceeded';

export const QUOTE_AUTO_CONFIRM_UNDER_ENV =
  'POSTPLUS_QUOTE_AUTO_CONFIRM_UNDER_MILLICREDITS';

/**
 * Thrown when a bounded auto-confirm ceiling is configured but the challenge
 * cost exceeds it. Carries the original challenge so an orchestrator or human
 * can confirm explicitly instead of the CLI hanging on a readline prompt.
 */
export class QuoteAutoConfirmCeilingExceededError extends Error {
  readonly code = QUOTE_AUTO_CONFIRM_CEILING_EXCEEDED_CODE;
  readonly challenge: LargeCreditQuoteConfirmationChallenge;
  readonly ceilingMillicredits: number;
  readonly costMillicredits: number;

  constructor(input: {
    challenge: LargeCreditQuoteConfirmationChallenge;
    ceilingMillicredits: number;
    costMillicredits: number;
  }) {
    super(
      `Quote cost ${input.costMillicredits} millicredits exceeds the ` +
        `auto-confirm ceiling of ${input.ceilingMillicredits} millicredits. ` +
        'Confirm explicitly or raise --auto-confirm-under / ' +
        `${QUOTE_AUTO_CONFIRM_UNDER_ENV}.`,
    );
    this.name = 'QuoteAutoConfirmCeilingExceededError';
    this.challenge = input.challenge;
    this.ceilingMillicredits = input.ceilingMillicredits;
    this.costMillicredits = input.costMillicredits;
  }
}

/**
 * Thrown when no auto-confirm ceiling is configured and stdin is not a TTY, so
 * the interactive readline prompt would hang. Fails fast with an actionable
 * message instead.
 */
export class QuoteConfirmationNonInteractiveError extends Error {
  readonly code = 'postplus_cli_quote_confirmation_non_interactive';
  readonly challenge: LargeCreditQuoteConfirmationChallenge;

  constructor(challenge: LargeCreditQuoteConfirmationChallenge) {
    super(
      'Quote confirmation required but stdin is not a TTY and no auto-confirm ' +
        'ceiling is configured. Pass --auto-confirm-under <millicredits>, set ' +
        `${QUOTE_AUTO_CONFIRM_UNDER_ENV}, or run interactively.`,
    );
    this.name = 'QuoteConfirmationNonInteractiveError';
    this.challenge = challenge;
  }
}

export type LargeCreditQuoteConfirmationChallenge = {
  action: string;
  accountId: string;
  billingUnit?: string;
  drivers?: Array<{
    key?: string;
    label: string;
    value: unknown;
  }>;
  estimatedCredits?: number;
  estimatedMillicredits: number;
  estimatedOnly?: boolean;
  featureLabel: string;
  operationId: string;
  requiredTierCredits?: number;
  requiredTierMillicredits: number;
  reservedCredits?: number;
  reservedMillicredits: number;
  serviceLabel: string;
  token: string;
};

export type LargeCreditQuoteConfirmationReport = {
  schemaVersion: 1;
  token: string;
};

type ConfirmationDependencies = {
  confirm: (challenge: LargeCreditQuoteConfirmationChallenge) => Promise<void>;
  /**
   * Bounded auto-confirm ceiling in millicredits. When set, challenges whose
   * cost is at or below the ceiling are confirmed without a readline prompt;
   * challenges above it throw {@link QuoteAutoConfirmCeilingExceededError}.
   */
  ceilingMillicredits?: number | null;
  /** Whether stdin is a TTY. Defaults to `process.stdin.isTTY`. */
  isTty?: () => boolean;
  /** Clock for the auto-confirm notice timestamp. Defaults to `Date`. */
  now?: () => Date;
  /** Sink for the one-line auto-confirm notice. Defaults to stderr. */
  logNotice?: (line: string) => void;
};

function resolveChallengeCostMillicredits(
  challenge: LargeCreditQuoteConfirmationChallenge,
): number {
  return typeof challenge.estimatedMillicredits === 'number'
    ? challenge.estimatedMillicredits
    : challenge.requiredTierMillicredits;
}

export function readLargeCreditQuoteConfirmationChallenge(
  value: unknown,
): LargeCreditQuoteConfirmationChallenge | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const challenge =
    record.productErrorCode === PRODUCT_ERROR_CODE
      ? record.quoteConfirmation
      : record.quoteConfirmation && typeof record.quoteConfirmation === 'object'
        ? record.quoteConfirmation
        : value;

  if (!challenge || typeof challenge !== 'object') {
    return null;
  }

  const parsed = challenge as Record<string, unknown>;

  if (
    typeof parsed.accountId !== 'string' ||
    typeof parsed.action !== 'string' ||
    typeof parsed.estimatedMillicredits !== 'number' ||
    typeof parsed.featureLabel !== 'string' ||
    typeof parsed.operationId !== 'string' ||
    typeof parsed.requiredTierMillicredits !== 'number' ||
    typeof parsed.reservedMillicredits !== 'number' ||
    typeof parsed.serviceLabel !== 'string' ||
    typeof parsed.token !== 'string'
  ) {
    return null;
  }

  return {
    accountId: parsed.accountId,
    action: parsed.action,
    billingUnit:
      typeof parsed.billingUnit === 'string' ? parsed.billingUnit : undefined,
    drivers: parseDrivers(parsed.drivers),
    estimatedCredits:
      typeof parsed.estimatedCredits === 'number'
        ? parsed.estimatedCredits
        : undefined,
    estimatedMillicredits: parsed.estimatedMillicredits,
    estimatedOnly: parsed.estimatedOnly === true,
    featureLabel: parsed.featureLabel,
    operationId: parsed.operationId,
    requiredTierCredits:
      typeof parsed.requiredTierCredits === 'number'
        ? parsed.requiredTierCredits
        : undefined,
    requiredTierMillicredits: parsed.requiredTierMillicredits,
    reservedCredits:
      typeof parsed.reservedCredits === 'number'
        ? parsed.reservedCredits
        : undefined,
    reservedMillicredits: parsed.reservedMillicredits,
    serviceLabel: parsed.serviceLabel,
    token: parsed.token,
  };
}

export async function resolveLargeCreditQuoteConfirmation(
  challenge: LargeCreditQuoteConfirmationChallenge,
  dependencies: ConfirmationDependencies = {
    confirm: confirmLargeCreditQuote,
  },
): Promise<LargeCreditQuoteConfirmationReport> {
  const acknowledgedTierMillicredits =
    await readAcknowledgedTierMillicredits(challenge);

  if (acknowledgedTierMillicredits < challenge.requiredTierMillicredits) {
    await runQuoteConfirmation(challenge, dependencies);
    await writeAcknowledgedTierMillicredits(challenge);
  }

  return {
    schemaVersion: 1,
    token: challenge.token,
  };
}

async function runQuoteConfirmation(
  challenge: LargeCreditQuoteConfirmationChallenge,
  dependencies: ConfirmationDependencies,
): Promise<void> {
  const ceiling = dependencies.ceilingMillicredits;

  if (typeof ceiling === 'number' && Number.isFinite(ceiling)) {
    const cost = resolveChallengeCostMillicredits(challenge);

    if (cost > ceiling) {
      throw new QuoteAutoConfirmCeilingExceededError({
        challenge,
        ceilingMillicredits: ceiling,
        costMillicredits: cost,
      });
    }

    const log = dependencies.logNotice ?? defaultLogNotice;
    const now = (dependencies.now ?? (() => new Date()))();
    log(
      JSON.stringify({
        event: 'quote_auto_confirm',
        timestamp: now.toISOString(),
        accountId: challenge.accountId,
        operationId: challenge.operationId,
        costMillicredits: cost,
        ceilingMillicredits: ceiling,
        requiredTierMillicredits: challenge.requiredTierMillicredits,
      }),
    );
    return;
  }

  const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
  if (!isTty()) {
    throw new QuoteConfirmationNonInteractiveError(challenge);
  }

  await dependencies.confirm(challenge);
}

function defaultLogNotice(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function confirmLargeCreditQuote(
  challenge: LargeCreditQuoteConfirmationChallenge,
): Promise<void> {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await terminal.question(
      buildLargeCreditConfirmationPrompt(challenge),
    );

    if (answer.trim() !== 'CONFIRM') {
      throw new Error('Large credit charge was not confirmed.');
    }
  } finally {
    terminal.close();
  }
}

export function buildLargeCreditConfirmationPrompt(
  challenge: LargeCreditQuoteConfirmationChallenge,
): string {
  const lines = [
    '',
    'PostPlus large credit warning',
    `This request crosses the ${formatCredits(
      challenge.requiredTierMillicredits,
    )}-credit warning tier.`,
    `Estimated charge: ${formatCredits(
      challenge.estimatedMillicredits,
    )} credits${challenge.estimatedOnly ? ' (estimate)' : ''}.`,
    `Reserved before execution: ${formatCredits(
      challenge.reservedMillicredits,
    )} credits.`,
    `Capability: ${formatText(challenge.featureLabel)} / ${formatText(
      challenge.action,
    )}.`,
    `Service: ${formatText(challenge.serviceLabel)}.`,
  ];

  const drivers = Array.isArray(challenge.drivers)
    ? challenge.drivers.filter((driver) => {
        return (
          driver &&
          typeof driver === 'object' &&
          typeof driver.label === 'string' &&
          driver.value !== undefined &&
          driver.value !== null
        );
      })
    : [];

  if (drivers.length > 0) {
    lines.push('High-credit drivers:');
    for (const driver of drivers.slice(0, 8)) {
      lines.push(`- ${driver.label}: ${String(driver.value)}`);
    }
  }

  lines.push(
    'PostPlus will warn again only when a future request crosses a higher tier.',
    'Type CONFIRM to continue: ',
  );

  return lines.join('\n');
}

async function readAcknowledgedTierMillicredits(
  challenge: LargeCreditQuoteConfirmationChallenge,
): Promise<number> {
  const config = await readLocalConfig();
  const tier =
    config?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId?.[
      challenge.accountId
    ];

  return typeof tier === 'number' && Number.isSafeInteger(tier) && tier > 0
    ? tier
    : 0;
}

async function writeAcknowledgedTierMillicredits(
  challenge: LargeCreditQuoteConfirmationChallenge,
): Promise<void> {
  await updateLocalConfig((current) => {
    const config = current ?? {};
    const largeCreditConfirmation = config.largeCreditConfirmation ?? {};
    const currentTiers =
      largeCreditConfirmation.acknowledgedTierMillicreditsByAccountId ?? {};
    const previousTier = currentTiers[challenge.accountId];

    return {
      ...config,
      largeCreditConfirmation: {
        ...largeCreditConfirmation,
        acknowledgedTierMillicreditsByAccountId: {
          ...currentTiers,
          [challenge.accountId]: Math.max(
            typeof previousTier === 'number' &&
              Number.isSafeInteger(previousTier)
              ? previousTier
              : 0,
            challenge.requiredTierMillicredits,
          ),
        },
      },
    };
  });
}

function parseDrivers(value: unknown): LargeCreditQuoteConfirmationChallenge['drivers'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((driver): driver is Record<string, unknown> => {
      return Boolean(driver) && typeof driver === 'object';
    })
    .filter((driver) => typeof driver.label === 'string')
    .map((driver) => ({
      key: typeof driver.key === 'string' ? driver.key : undefined,
      label: driver.label as string,
      value: driver.value,
    }));
}

function formatText(value: string): string {
  return value.trim() ? value : 'unknown';
}

function formatCredits(millicredits: number): string {
  const credits = millicredits / 1_000;

  if (!Number.isFinite(credits)) {
    return 'unknown';
  }

  return Number.isInteger(credits)
    ? String(credits)
    : credits.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
