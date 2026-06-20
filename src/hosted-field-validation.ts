// Schema-driven early field validation (issue #475). Mirrors the Web boundary's
// assertModelledFieldValuesInRange: every enum / numeric-range field an endpoint
// advertises in the generated execution manifest — the same EnvelopeFieldSpec the
// Web validator reads — is checked here BEFORE the request is posted, so the agent
// gets an immediate field-level error (e.g. seedance resolution "999p") instead of
// waiting for the round-trip. The Web boundary stays the AUTHORITATIVE gate; this is
// only pre-submit feedback.
//
// Casing-faithfulness is the reason this cannot be a CLI-side island: the per-field
// canonicalization rule is read from the manifest `canonicalize` hint, the SAME
// single source the Web validator reads, so "720P" / "4K" pass and "english" /
// "999p" fail exactly as they do on the boundary. The two canonicalize functions
// below are stable 3-line algorithms; WHICH field uses WHICH is decided by the
// schema hint, never re-guessed here.

import type { ManifestField } from './hosted-manifest-index.js';

// k-tier normalization for image resolution ("4K" -> "4k"). Mirrors the Web
// canonicalizeImageResolution exactly.
function canonicalizeImageResolution(value: string): string {
  const trimmed = value.trim();
  const tier = trimmed.match(/^(\d+(?:\.\d+)?)\s*k$/iu);
  return tier ? `${tier[1]}k` : trimmed;
}

function canonicalizeLowercaseToken(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalizeModelledFieldValue(
  field: ManifestField,
  value: string,
): string {
  switch (field.canonicalize) {
    case 'image-resolution-tier':
      return canonicalizeImageResolution(value);
    case 'lowercase':
      return canonicalizeLowercaseToken(value);
    default:
      return value;
  }
}

function isIntegerInRange(min: number, max: number, value: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function formatReceivedValue(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : String(raw);
}

function assertModelledNumberFieldValue(
  endpointKey: string,
  field: ManifestField,
  raw: unknown,
): void {
  const enumValues =
    field.enumValues && field.enumValues.length > 0 ? field.enumValues : null;
  const constraint = enumValues
    ? `must be one of ${enumValues.join(', ')}`
    : `must be an integer from ${field.min} to ${field.max}`;

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(
      `${endpointKey} ${field.name} ${constraint}; received ${formatReceivedValue(raw)}.`,
    );
  }
  if (enumValues) {
    if (!enumValues.includes(String(raw))) {
      throw new Error(
        `${endpointKey} ${field.name} ${constraint}; received ${raw}.`,
      );
    }
    return;
  }
  if (field.min === undefined || field.max === undefined) {
    return;
  }
  if (!isIntegerInRange(field.min, field.max, raw)) {
    throw new Error(
      `${endpointKey} ${field.name} ${constraint}; received ${raw}.`,
    );
  }
}

// Validates every advertised enum / numeric-range field present in the input against
// the manifest contract. Skips runner-managed fields (no caller input), fields with
// neither an enum nor a range, and fields the input omits — exactly mirroring the Web
// boundary so a value the CLI accepts the boundary also accepts, and vice versa.
export function assertModelledFieldValuesInRange(
  endpointKey: string,
  fields: readonly ManifestField[],
  input: Record<string, unknown>,
): void {
  for (const field of fields) {
    if (field.class === 'runner-managed') {
      continue;
    }
    const enumValues =
      field.enumValues && field.enumValues.length > 0 ? field.enumValues : null;
    const hasRange = field.min !== undefined && field.max !== undefined;
    if (!enumValues && !hasRange) {
      continue;
    }
    if (!Object.hasOwn(input, field.name)) {
      continue;
    }

    if (field.type === 'number') {
      assertModelledNumberFieldValue(endpointKey, field, input[field.name]);
      continue;
    }

    const raw = input[field.name];
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const value = raw.trim();
    if (
      enumValues &&
      !enumValues.includes(canonicalizeModelledFieldValue(field, value))
    ) {
      throw new Error(
        `${endpointKey} ${field.name} must be one of ${enumValues.join(', ')}; received "${value}".`,
      );
    }
  }
}
