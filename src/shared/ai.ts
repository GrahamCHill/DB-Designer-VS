// Prompt and response contract for the AI normalisation review. Provider-independent.

import { Schema } from './model';
import { generateFullSql } from './pgExport';
import { OPERATION_JSON_SCHEMA, SchemaOp, sanitizeOps } from './ops';

export type Severity = 'high' | 'medium' | 'low';

export interface AiSuggestion {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  tables: string[];
  explanation: string;
  operations: SchemaOp[];
  /** Operations the model returned that could not be understood. */
  problems?: string[];
}

export interface AiReview {
  summary: string;
  suggestions: AiSuggestion[];
  model?: string;
}

export const CATEGORIES = ['1NF', '2NF', '3NF', 'BCNF', 'redundancy', 'integrity', 'keys', 'naming', 'types', 'other'] as const;

/** JSON Schema of the model's answer (used for structured outputs where the provider supports it). */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on the overall state of the schema.' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'category', 'tables', 'explanation', 'operations'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: [...CATEGORIES] },
          tables: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
          operations: { type: 'array', items: OPERATION_JSON_SCHEMA },
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `You are a senior database architect reviewing a relational schema for normalisation and design quality.

Look for, in order of impact:
- Violations of 1NF (repeating groups such as phone1/phone2/phone3, comma-separated or array/JSON columns that hold lists of entities you could model as rows).
- Violations of 2NF/3NF/BCNF (columns that depend on part of a composite key, or on a non-key column; the same facts copied into several tables).
- Redundant or derived data that can drift out of sync, and missing foreign keys between columns that clearly reference another table.
- Missing or weak keys (no primary key, natural keys that should be unique, many-to-many relationships without a join table).
- Smaller issues: inconsistent naming and type choices, such as text columns used for dates or money.

Rules:
- Base every finding on the schema you were given. Do not invent columns or tables.
- Be pragmatic: denormalisation that is clearly deliberate (audit logs, caches, snapshots, raw payload JSON, search vectors) is fine. Mention it only if it is risky.
- Each suggestion must come with concrete operations that implement it, using the operation format below. Where data must be migrated (for example, moving a column into a new table), still give the structural operations, and say in the explanation what data migration is needed.
- Use existing table names exactly as given, schema-qualified (for example "app.users"). New tables go in the same schema as the table they are split from.
- When you add a foreign key, the referenced column must be a primary key or unique column.
- Order suggestions from most to least important. Return at most 12, each specific to this schema.

Operation format (one object per change, applied in order):
- add_table: table, column_defs [{name, type, nullable, primary_key, unique, default}]
- drop_table: table
- rename_table: table, new_name
- add_column: table, column_defs [one definition]
- drop_column: table, column
- rename_column: table, column, new_name
- alter_column: table, column, plus any of type / nullable / unique / default
- set_primary_key: table, columns
- add_foreign_key: table, columns, ref_table, ref_columns, on_delete (NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT)
- drop_foreign_key: table, columns

Respond with JSON only, matching this shape:
{"summary": string, "suggestions": [{"title": string, "severity": "high"|"medium"|"low", "category": ${CATEGORIES.map((c) => `"${c}"`).join('|')}, "tables": [string], "explanation": string, "operations": [operation]}]}`;

export interface ReviewRequest {
  schema: Schema;
  /** Only include these schemas (e.g. what is visible in the diagram). */
  schemas?: string[];
  /** Restrict to these tables (ids) and their direct neighbours. */
  tableIds?: string[];
  /** Free-text focus from the user. */
  focus?: string;
}

/** Build the user prompt: the schema as PostgreSQL DDL plus optional focus. */
export function buildUserPrompt(req: ReviewRequest): string {
  let schema = req.schema;
  if (req.tableIds?.length) {
    const keep = new Set(req.tableIds);
    for (const r of schema.relations) {
      if (keep.has(r.fromTable) || keep.has(r.toTable)) {
        keep.add(r.fromTable);
        keep.add(r.toTable);
      }
    }
    schema = { ...schema, tables: schema.tables.filter((t) => keep.has(t.id)) };
  }
  const ddl = generateFullSql(schema, { schemas: req.tableIds?.length ? undefined : req.schemas })
    .split('\n')
    .filter((l) => !l.startsWith('-- Generated by') && !l.startsWith('-- Source:'))
    .join('\n');
  const parts = [`Here is the schema (${schema.tables.length} tables) as PostgreSQL DDL:\n\n\`\`\`sql\n${ddl.trim()}\n\`\`\``];
  if (req.tableIds?.length) parts.push('Focus on the tables the user selected and their direct relationships.');
  if (req.focus?.trim()) parts.push(`The user asks you to focus on: ${req.focus.trim()}`);
  parts.push('Review it for normalisation and return the JSON described in your instructions.');
  return parts.join('\n\n');
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Validate a parsed reply into an AiReview. */
export function toReview(raw: unknown, model?: string): AiReview {
  if (!raw || typeof raw !== 'object') throw new Error('The model reply was not a JSON object.');
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.suggestions) ? o.suggestions : [];
  const suggestions: AiSuggestion[] = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, i) => {
      const { ops, problems } = sanitizeOps(x.operations ?? []);
      const sev = String(x.severity ?? 'medium').toLowerCase();
      return {
        id: `s${i + 1}`,
        title: String(x.title ?? `Suggestion ${i + 1}`),
        severity: (['high', 'medium', 'low'].includes(sev) ? sev : 'medium') as Severity,
        category: String(x.category ?? 'other'),
        tables: Array.isArray(x.tables) ? x.tables.map(String) : [],
        explanation: String(x.explanation ?? ''),
        operations: ops,
        problems: problems.length ? problems : undefined,
      };
    });
  return { summary: String(o.summary ?? ''), suggestions, model };
}
