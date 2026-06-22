// GENERATED from apps/web/lib/server/postplus-cli/hosted-field-validation-core.ts.
// Do not edit by hand. Run `pnpm hosted-execution-manifest:sync` to regenerate.
// Verbatim projection so the canonicalize + enum/range field-validation algorithm stays
// byte-identical to the Web boundary (the CLI submodule cannot import apps/web TS).

// SSOT for the schema-driven canonicalize + enum/range field validation shared by
// the Web authoritative gate (hosted-capability-catalog.ts) and the CLI early
// validator (external/postplus-cli/src/hosted-field-validation.ts).
//
// Issue #475 made the per-field `canonicalize` HINT single-source (projected through
// the execution manifest). This module makes the ALGORITHM that reads it single-source
// too, so the casing-parity ("720P"/"4K" pass, "english"/"999p" fail) and the
// enum/range loop can never drift between the two surfaces. Previously both the three
// canonicalize functions and the validation loop were hand-copied on each side.
//
// The CLI submodule cannot import apps/web TS, so this file is projected VERBATIM into
// external/postplus-cli/src/generated/hosted-field-validation-core.generated.ts by
// scripts/operations/hosted-execution-manifest/generate.ts. Edit ONLY here; run
// `pnpm hosted-execution-manifest:sync` to regenerate, and the companion `:check`
// guard fails on drift. The module is intentionally self-contained (no imports) so the
// verbatim copy is valid CLI TypeScript; the per-surface error factory is injected so
// the Web gate keeps its typed invalid_request error while the CLI throws a plain Error.

// The subset of the Web EnvelopeFieldSpec / CLI ManifestField the algorithm reads.
// Both field types are structurally assignable to this at the call site.
export type CanonicalizableField = {
  name: string;
  class: 'intent' | 'default' | 'runner-managed';
  type: 'string' | 'number' | 'boolean' | 'media-url';
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  canonicalize?: 'lowercase' | 'image-resolution-tier';
};

// k-tier normalization for image resolution ("4K" -> "4k").
export function canonicalizeImageResolution(value: string): string {
  const trimmed = value.trim();
  const tier = trimmed.match(/^(\d+(?:\.\d+)?)\s*k$/iu);
  return tier ? `${tier[1]}k` : trimmed;
}

export function canonicalizeLowercaseToken(value: string): string {
  return value.trim().toLowerCase();
}

// Which canonicalization a field uses is decided by the schema `canonicalize` hint —
// the single source both surfaces read — never re-guessed from the field name.
export function canonicalizeModelledFieldValue(
  field: Pick<CanonicalizableField, 'canonicalize'>,
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

function formatReceivedValue(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : String(raw);
}

function assertModelledNumberFieldValue(
  endpointKey: string,
  field: CanonicalizableField,
  raw: unknown,
  createError: (message: string) => Error,
): void {
  const enumValues =
    field.enumValues && field.enumValues.length > 0 ? field.enumValues : null;
  const constraint = enumValues
    ? `must be one of ${enumValues.join(', ')}`
    : `must be an integer from ${field.min} to ${field.max}`;

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw createError(
      `${endpointKey} ${field.name} ${constraint}; received ${formatReceivedValue(raw)}.`,
    );
  }
  if (enumValues) {
    if (!enumValues.includes(String(raw))) {
      throw createError(
        `${endpointKey} ${field.name} ${constraint}; received ${raw}.`,
      );
    }
    return;
  }
  if (field.min === undefined || field.max === undefined) {
    return;
  }
  if (!(Number.isInteger(raw) && raw >= field.min && raw <= field.max)) {
    throw createError(
      `${endpointKey} ${field.name} ${constraint}; received ${raw}.`,
    );
  }
}

// Validates every advertised enum / numeric-range field present in the input against
// the field contract. Skips runner-managed fields (no caller input), fields with
// neither an enum nor a range, and fields the input omits. The string value is
// canonicalized with the schema hint before the enum membership check, so a mixed-case
// "720P"/"4K" still matches the lowercase registry enum while "english" still fails the
// Title-cased language enum. The error factory is injected: the Web boundary passes its
// typed invalid_request error, the CLI early validator passes a plain Error.
export function assertModelledFieldValuesInRange(
  endpointKey: string,
  fields: readonly CanonicalizableField[],
  input: Record<string, unknown>,
  createError: (message: string) => Error,
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
      assertModelledNumberFieldValue(
        endpointKey,
        field,
        input[field.name],
        createError,
      );
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
      throw createError(
        `${endpointKey} ${field.name} must be one of ${enumValues.join(', ')}; received "${value}".`,
      );
    }
  }
}
