// Pre-export checks: problems in the diagram that would make generated SQL invalid (or silently
// different) in the target engine. Errors block a clean export; warnings are informational.

import { Schema, Table } from './model';
import { ExportDialect, canonicalType, engineOf, PgKind } from './sqlExport';
import { pgSchemaName } from './pgExport';
import { parseSql } from './sqlParser';

export interface Issue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

const NAME_LIMIT: Record<ExportDialect, number> = { postgres: 63, mssql: 128, mssql2025: 128, mysql: 64, sqlite: Infinity };
const DIALECT_LABEL: Record<ExportDialect, string> = {
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  mssql2025: 'SQL Server 2025',
  mysql: 'MySQL',
  sqlite: 'SQLite',
};

/** Type families that may reference each other in a foreign key. */
function family(k: PgKind): string {
  if (['smallint', 'integer', 'bigint'].includes(k)) return 'int';
  if (['numeric', 'real', 'double', 'money'].includes(k)) return 'num';
  if (['text', 'varchar', 'char', 'enum', 'inet', 'other'].includes(k)) return 'text';
  if (['timestamp', 'timestamptz'].includes(k)) return 'ts';
  if (['time', 'timetz'].includes(k)) return 'time';
  return k;
}

/** Final table name in the target (MySQL/SQLite flatten schemas, prefixing only on clashes). */
export function targetTableName(t: Table, all: Table[], target: ExportDialect, schema: Schema): string {
  if (target === 'postgres' || engineOf(target) === 'mssql') return `${pgSchemaName(t.schema, schema.dialect)}.${t.name}`;
  const clash = all.filter((x) => x.name.toLowerCase() === t.name.toLowerCase()).length > 1;
  const s = pgSchemaName(t.schema, schema.dialect);
  return clash && s !== 'public' ? `${s}_${t.name}` : t.name;
}

export function validateForExport(schema: Schema, target: ExportDialect, schemas?: string[]): Issue[] {
  const issues: Issue[] = [];
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => issues.push({ level: 'warning', where, message });
  const include = schemas ? new Set(schemas) : undefined;
  const tables = schema.tables.filter((t) => !include || include.has(t.schema));
  const ids = new Set(tables.map((t) => t.id));
  const limit = NAME_LIMIT[target];
  const db = DIALECT_LABEL[target];

  // Table names (after the target's schema handling)
  const seen = new Map<string, Table>();
  for (const t of tables) {
    const tn = `${t.schema ? t.schema + '.' : ''}${t.name}`;
    if (!t.name.trim()) err(tn || '(unnamed table)', 'Table has no name.');
    const final = targetTableName(t, tables, target, schema).toLowerCase();
    const dup = seen.get(final);
    if (dup) err(tn, `Two tables would both be named "${final}" in ${db} (also ${dup.schema ? dup.schema + '.' : ''}${dup.name}).`);
    seen.set(final, t);
    if ([...t.name].length > limit) err(tn, `Table name is ${t.name.length} characters; ${db} allows ${limit}.`);
    if (!t.columns.length) err(tn, 'Table has no columns.');
    if (!t.columns.some((c) => c.pk)) warn(tn, 'Table has no primary key.');

    const cols = new Map<string, string>();
    for (const c of t.columns) {
      const where = `${tn}.${c.name || '(unnamed)'}`;
      if (!c.name.trim()) err(where, 'Column has no name.');
      const key = c.name.toLowerCase();
      if (cols.has(key)) err(where, `Duplicate column name "${c.name}".`);
      cols.set(key, c.name);
      if ([...c.name].length > limit) err(where, `Column name is ${c.name.length} characters; ${db} allows ${limit}.`);
      if (!c.type.trim()) err(where, 'Column has no type.');
      else if (target !== 'postgres' && canonicalType(c, schema).kind === 'other')
        warn(where, `Type "${c.type}" has no known ${db} equivalent and will be stored as text.`);
      if (c.default && /[;]/.test(c.default) && !/^'.*'$/s.test(c.default.trim())) err(where, `Default "${c.default}" contains a ";", which would end the statement.`);
    }
  }

  // Foreign keys
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  for (const r of schema.relations) {
    if (!ids.has(r.fromTable) && !ids.has(r.toTable)) continue;
    const from = byId.get(r.fromTable);
    const to = byId.get(r.toTable);
    const where = `${from?.name ?? '?'} → ${to?.name ?? '?'}`;
    if (!from || !to) {
      err(where, 'Foreign key points to a table that no longer exists.');
      continue;
    }
    if (ids.has(r.fromTable) !== ids.has(r.toTable)) {
      warn(where, 'Foreign key crosses into a schema that is not being exported; it will be left out.');
      continue;
    }
    if (r.fromColumns.length !== r.toColumns.length || !r.fromColumns.length) {
      err(where, 'Foreign key has a different number of columns on each side.');
      continue;
    }
    const fc = r.fromColumns.map((id) => from.columns.find((c) => c.id === id));
    const tc = r.toColumns.map((id) => to.columns.find((c) => c.id === id));
    if (fc.some((c) => !c) || tc.some((c) => !c)) {
      err(where, 'Foreign key refers to a column that no longer exists.');
      continue;
    }
    // Referenced columns must be exactly a primary key or a unique constraint.
    const refIds = new Set(r.toColumns);
    const pk = to.columns.filter((c) => c.pk).map((c) => c.id);
    const isPk = pk.length === refIds.size && pk.every((id) => refIds.has(id));
    const isUnique =
      (refIds.size === 1 && tc[0]!.unique) ||
      (to.uniques ?? []).some((u) => u.columns.length === refIds.size && u.columns.every((id) => refIds.has(id)));
    if (!isPk && !isUnique && target !== 'sqlite')
      err(where, `Referenced column(s) ${tc.map((c) => c!.name).join(', ')} are not a primary key or unique; ${db} rejects this foreign key.`);
    else if (!isPk && !isUnique) warn(where, 'Referenced column(s) are not a key; SQLite reports a "foreign key mismatch" on insert.');
    fc.forEach((c, i) => {
      const a = family(canonicalType(c!, schema).kind);
      const b = family(canonicalType(tc[i]!, schema).kind);
      if (a !== b) err(`${from.name}.${c!.name}`, `Type ${c!.type} cannot reference ${to.name}.${tc[i]!.name} (${tc[i]!.type}).`);
    });
  }

  // PostgreSQL: primary-key and unique constraint names become index names, unique per schema.
  if (target === 'postgres') {
    const idx = new Map<string, string>();
    const claim = (schemaName: string, name: string | undefined, owner: string) => {
      if (!name) return;
      const k = `${schemaName}.${name}`.toLowerCase();
      const prev = idx.get(k);
      if (prev && prev !== owner) err(owner, `Constraint/index name "${name}" is also used by ${prev}; PostgreSQL needs it unique within the schema.`);
      idx.set(k, owner);
    };
    for (const t of tables) {
      claim(t.schema, t.pkName, `${t.name} (primary key)`);
      for (const [cid, n] of Object.entries(t.uniqueNames ?? {})) claim(t.schema, n, `${t.name}.${t.columns.find((c) => c.id === cid)?.name}`);
      for (const n of Object.values(t.uniqueIndexes ?? {})) claim(t.schema, n, `${t.name} (unique index ${n})`);
    }
  }
  return issues;
}

/**
 * For dialects that can't be executed in-process: re-read the generated SQL with the parser and check
 * that it describes exactly the diagram (tables, columns, primary keys, foreign keys), and that every
 * statement is well-formed (balanced parentheses and quotes).
 */
export function structuralCheck(model: Schema, sql: string, target: ExportDialect, schemas?: string[]): string[] {
  const problems: string[] = [];
  // Balanced parentheses / quotes per statement (ignoring comments).
  const body = sql.replace(/--[^\n]*/g, '');
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) {
        if (body[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[' && engineOf(target) === 'mssql') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) {
      problems.push('Unbalanced ")" in the generated SQL.');
      break;
    }
  }
  if (quote) problems.push('Unterminated quoted string or identifier in the generated SQL.');
  if (depth > 0) problems.push('Unclosed "(" in the generated SQL.');

  const include = schemas ? new Set(schemas) : undefined;
  const tables = model.tables.filter((t) => !include || include.has(t.schema));
  const parsed = parseSql([{ name: 'export.sql', content: sql }], { dialect: engineOf(target) }).schema;
  const norm = (s: string) => s.toLowerCase();
  const pt = new Map(parsed.tables.map((t) => [norm(target === 'mysql' || target === 'sqlite' ? t.name : `${t.schema}.${t.name}`), t]));
  for (const t of tables) {
    const name = targetTableName(t, tables, target, model);
    const key = norm(engineOf(target) === 'mssql' ? name.replace(/^public\./i, 'dbo.') : name);
    const p = pt.get(key);
    if (!p) {
      problems.push(`Table ${name} is missing from the generated SQL.`);
      continue;
    }
    const want = t.columns.map((c) => norm(c.name)).join(',');
    const got = p.columns.map((c) => norm(c.name)).join(',');
    if (want !== got) problems.push(`Table ${name}: columns in the SQL (${got}) differ from the diagram (${want}).`);
    const wpk = t.columns.filter((c) => c.pk).map((c) => norm(c.name)).join(',');
    const gpk = p.columns.filter((c) => c.pk).map((c) => norm(c.name)).join(',');
    if (wpk !== gpk) problems.push(`Table ${name}: primary key (${gpk}) differs from the diagram (${wpk}).`);
  }
  const ids = new Set(tables.map((t) => t.id));
  const expectedFks = model.relations.filter((r) => ids.has(r.fromTable) && ids.has(r.toTable)).length;
  if (parsed.relations.length !== expectedFks) problems.push(`The SQL defines ${parsed.relations.length} foreign keys; the diagram has ${expectedFks}.`);
  return problems;
}
