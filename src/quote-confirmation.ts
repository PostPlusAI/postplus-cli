import readline from 'node:readline/promises';

import { readLocalConfig, updateLocalConfig } from './local-state.js';

const PRODUCT_ERROR_CODE = 'postplus_cli_quote_confirmation_required';

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
};

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
    await dependencies.confirm(challenge);
    await writeAcknowledgedTierMillicredits(challenge);
  }

  return {
    schemaVersion: 1,
    token: challenge.token,
  };
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
