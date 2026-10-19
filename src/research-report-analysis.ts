import { type ResearchItem, object } from './research-report-model.js';

export const RESEARCH_ANALYSIS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'PostPlus research report analysis',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'goal', 'criteria', 'items'],
  properties: {
    schemaVersion: { const: 1 },
    goal: { type: 'string', minLength: 1 },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'origin'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          origin: { enum: ['user', 'agent'] },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'decision', 'reason', 'analysisDepth', 'criteria'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description:
              'Stable ID printed by research report; must reference a supplied raw result.',
          },
          decision: { enum: ['include', 'exclude', 'review'] },
          reason: { type: 'string', minLength: 1 },
          analysisDepth: {
            enum: ['metadata', 'visual', 'comments'],
            description: 'Deepest inspection actually completed, not planned.',
          },
          topics: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
          evidenceIds: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'status', 'evidenceIds'],
              properties: {
                id: { type: 'string', minLength: 1 },
                status: { enum: ['met', 'not_met', 'unknown'] },
                evidenceIds: {
                  type: 'array',
                  items: { type: 'string', minLength: 1 },
                  uniqueItems: true,
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
export type ResearchAnalysis = {
  schemaVersion: 1;
  goal: string;
  criteria: { id: string; label: string; origin: 'user' | 'agent' }[];
  items: {
    id: string;
    decision: 'include' | 'exclude' | 'review';
    reason: string;
    analysisDepth: 'metadata' | 'visual' | 'comments';
    topics?: string[];
    evidenceIds?: string[];
    criteria: {
      id: string;
      status: 'met' | 'not_met' | 'unknown';
      evidenceIds: string[];
    }[];
  }[];
};
// The exported schema and runtime validation share the same rules.
function validateSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): void {
  if (schema.const !== undefined && value !== schema.const)
    throw new Error(`${path} must equal ${schema.const}.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error(`${path} must be one of ${schema.enum.join(', ')}.`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${path} must be an object.`);
    const row = object(value),
      properties = object(schema.properties);
    for (const required of (schema.required as string[]) || [])
      if (!(required in row))
        throw new Error(`${path}.${required} is required.`);
    for (const [key, entry] of Object.entries(row)) {
      if (!(key in properties))
        throw new Error(`Unknown analysis field: ${path}.${key}`);
      validateSchema(entry, object(properties[key]), `${path}.${key}`);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      throw new Error(`${path} contains duplicates.`);
    value.forEach((entry, i) =>
      validateSchema(entry, object(schema.items), `${path}[${i}]`),
    );
  }
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim()))
    throw new Error(`${path} must be a non-empty string.`);
}
export function validateResearchAnalysis(
  value: unknown,
  items: ResearchItem[],
): ResearchAnalysis {
  validateSchema(value, RESEARCH_ANALYSIS_SCHEMA, 'analysis');
  const analysis = value as ResearchAnalysis,
    itemIds = new Set(items.map((item) => item.id)),
    criteria = new Set<string>(),
    decisions = new Set<string>();
  for (const criterion of analysis.criteria) {
    if (criteria.has(criterion.id))
      throw new Error(`Duplicate criterion: ${criterion.id}`);
    criteria.add(criterion.id);
  }
  function evidence(ids: string[]) {
    for (const id of ids)
      if (!itemIds.has(id))
        throw new Error(`Analysis references missing evidence: ${id}`);
  }
  for (const decision of analysis.items) {
    evidence([decision.id, ...(decision.evidenceIds || [])]);
    if (decisions.has(decision.id))
      throw new Error(`Duplicate item analysis: ${decision.id}`);
    decisions.add(decision.id);
    if (decision.analysisDepth === 'comments') {
      const references = [
        decision.id,
        ...(decision.evidenceIds || []),
        ...decision.criteria.flatMap((criterion) => criterion.evidenceIds),
      ];
      if (
        !references.some((id) =>
          items.some((item) => item.id === id && item.kind === 'comment'),
        )
      )
        throw new Error(
          `Comment inspection requires referenced comment evidence: ${decision.id}`,
        );
    }
    const seen = new Set<string>();
    for (const criterion of decision.criteria) {
      if (!criteria.has(criterion.id))
        throw new Error(`Unknown criterion: ${criterion.id}`);
      if (seen.has(criterion.id))
        throw new Error(
          `Duplicate criterion judgement: ${decision.id}/${criterion.id}`,
        );
      seen.add(criterion.id);
      evidence(criterion.evidenceIds);
      if (criterion.status !== 'unknown' && !criterion.evidenceIds.length)
        throw new Error(
          `A ${criterion.status} judgement needs evidence: ${decision.id}/${criterion.id}`,
        );
    }
  }
  return analysis;
}
