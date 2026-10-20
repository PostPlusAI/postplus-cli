// GENERATED from apps/web/lib/ad-library/filter-contract.ts. Do not edit.
export type LibraryFilters = {
  collection?: 'a16z';
  query?: string;
  brand?: string;
  category?: string;
  subcategory?: string;
  'visual-format'?: string;
  'media-type'?: 'video' | 'image';
  'product-type'?: 'software' | 'hardware';
  status?: 'active' | 'inactive' | 'unknown';
  limit: number;
  offset: number;
};

type StringFilter = {
  type: 'string';
  maxLength: number;
  enum?: readonly string[];
};
type IntegerFilter = {
  type: 'integer';
  minimum: number;
  maximum: number;
  default: number;
};
const text = { type: 'string', maxLength: 200 } as const;

/** One source for public HTTP parsing, MCP schema, and generated CLI validation. */
export const libraryFilterDefinitions = {
  collection: { ...text, enum: ['a16z'] },
  query: text,
  brand: text,
  category: text,
  subcategory: text,
  'visual-format': text,
  'media-type': { ...text, enum: ['video', 'image'] },
  'product-type': { ...text, enum: ['software', 'hardware'] },
  status: { ...text, enum: ['active', 'inactive', 'unknown'] },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 24 },
  offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
} satisfies Record<string, StringFilter | IntegerFilter>;

export const librarySearchInputSchema = {
  type: 'object',
  properties: libraryFilterDefinitions,
  additionalProperties: false,
} as const;

export function parseLibraryFilters(params: URLSearchParams): LibraryFilters {
  for (const key of params.keys()) {
    if (!Object.hasOwn(libraryFilterDefinitions, key))
      throw new Error(`Unknown filter: ${key}`);
    if (params.getAll(key).length > 1)
      throw new Error(`Repeated filter: ${key}`);
  }
  const output: Record<string, string | number> = {};
  for (const [key, definition] of Object.entries(libraryFilterDefinitions)) {
    if (definition.type === 'integer') {
      const raw = params.get(key);
      if (raw !== null && !/^\d+$/.test(raw)) throw new Error(`Invalid ${key}`);
      const value = raw === null ? definition.default : Number(raw);
      if (
        !Number.isSafeInteger(value) ||
        value < definition.minimum ||
        value > definition.maximum
      )
        throw new Error(`Invalid ${key}`);
      output[key] = value;
    } else {
      const value = params.get(key)?.trim();
      if (!value) continue;
      if (
        value.length > definition.maxLength ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error(`Invalid filter: ${key}`);
      if ('enum' in definition && !definition.enum.includes(value))
        throw new Error(`Invalid ${key}`);
      output[key] = value;
    }
  }
  return output as LibraryFilters;
}

/** JSON transport only: business normalization remains in parseLibraryFilters. */
export function parseLibraryFilterInput(input: unknown): LibraryFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Filters must be an object');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    const definition = (
      libraryFilterDefinitions as Record<string, StringFilter | IntegerFilter>
    )[key];
    if (!Object.hasOwn(libraryFilterDefinitions, key))
      throw new Error(`Unknown filter: ${key}`);
    if (
      (definition!.type === 'integer' && typeof value !== 'number') ||
      (definition!.type === 'string' && typeof value !== 'string')
    )
      throw new Error(`Invalid filter type: ${key}`);
    params.set(key, String(value));
  }
  return parseLibraryFilters(params);
}
