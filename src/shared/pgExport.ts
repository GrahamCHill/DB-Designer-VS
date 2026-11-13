// PostgreSQL DDL generation: full schema export and change-only migrations.

import { Column, Dialect, Relation, Schema, Table, UserType } from './model';

const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column ' +
    'concurrently constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from ' +
    'full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime ' +
    'localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning ' +
    'right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user ' +
    'using variadic verbose when where window with'
  ).split(' '),
);

export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function pgSchemaName(schema: string, dialect: Dialect): string {
  if (!schema) return 'public';
  if (dialect === 'mssql' && schema.toLowerCase() === 'dbo') return 'public';
  return schema;
}

function qualified(t: Table, dialect: Dialect): string {
  return `${quoteIdent(pgSchemaName(t.schema, dialect))}.${quoteIdent(t.name)}`;
}

// ---------------------------------------------------------------------------
// Type & default mapping from other dialects
// ---------------------------------------------------------------------------

/** "int(11) unsigned" -> base "int", args "(11)", suffix "unsigned"; "int unsigned" -> base "int", suffix "unsigned". */
function splitType(type: string): { base: string; args: string; suffix: string } {
  const m = /^\s*([^(\[]*[^(\[\s])\s*(\([^)]*\))?\s*(.*)$/.exec(type.trim());
  if (!m) return { base: type.trim().toLowerCase(), args: '', suffix: '' };
  const words = m[1].toLowerCase().split(/\s+/);
  const multi = ['double precision', 'character varying', 'bit varying'].find((w) => m[1].toLowerCase().startsWith(w));
  const base = multi ?? words[0];
  const extra = m[1].toLowerCase().slice(base.length).trim();
  return { base, args: (m[2] ?? '').replace(/\s+/g, ''), suffix: [extra, (m[3] ?? '').toLowerCase()].filter(Boolean).join(' ') };
}

export function toPostgresType(type: string, dialect: Dialect): string {
  const t = (type || 'text').trim();
  if (dialect === 'postgres' || dialect === 'generic') return t;
  const { base, args, suffix } = splitType(t);
  const argMax = /max/i.test(args);
  const isArray = suffix.includes('[]');
  const arr = isArray ? '[]' : '';
  switch (dialect) {
    case 'mssql':
      switch (base) {
        case 'nvarchar':
        case 'varchar':
          return argMax || !args ? 'text' : `varchar${args}`;
        case 'nchar':
        case 'char':
          return `char${args}`;
        case 'ntext':
        case 'text':
        case 'sql_variant':
        case 'hierarchyid':
        case 'geography':
        case 'geometry':
          return 'text';
        case 'int':
          return 'integer';
        case 'tinyint':
          return 'smallint';
        case 'bit':
          return 'boolean';
        case 'money':
          return 'numeric(19,4)';
        case 'smallmoney':
          return 'numeric(10,4)';
        case 'float':
          return 'double precision';
        case 'datetime':
        case 'datetime2':
        case 'smalldatetime':
          return 'timestamp';
        case 'datetimeoffset':
          return 'timestamptz';
        case 'uniqueidentifier':
          return 'uuid';
        case 'varbinary':
        case 'binary':
        case 'image':
        case 'rowversion':
        case 'timestamp':
          return 'bytea';
        case 'computed':
          return 'text';
        default:
          return `${base}${args}`;
      }
    case 'mysql':
      switch (base) {
        case 'tinyint':
          return args === '(1)' ? 'boolean' : 'smallint';
        case 'int':
        case 'integer':
        case 'mediumint':
          return suffix.includes('unsigned') && base === 'int' ? 'bigint' : 'integer';
        case 'bigint':
          return 'bigint';
        case 'smallint':
          return suffix.includes('unsigned') ? 'integer' : 'smallint';
        case 'tinytext':
        case 'mediumtext':
        case 'longtext':
        case 'text':
        case 'enum':
        case 'set':
          return 'text';
        case 'datetime':
          return 'timestamp';
        case 'year':
          return 'smallint';
        case 'double':
          return 'double precision';
        case 'float':
          return 'real';
        case 'tinyblob':
        case 'blob':
        case 'mediumblob':
        case 'longblob':
        case 'binary':
        case 'varbinary':
          return 'bytea';
        case 'json':
          return 'jsonb';
        case 'bool':
          return 'boolean';
        default:
          return `${base}${args}${arr}`;
      }
    case 'sqlite':
      switch (base) {
        case '':
          return 'text';
        case 'int':
          return 'integer';
        case 'real':
        case 'double':
          return 'double precision';
        case 'blob':
          return 'bytea';
        case 'datetime':
          return 'timestamp';
        default:
          return `${base}${args}${arr}`;
      }
  }
  return t;
}

function stripOuterParens(s: string): string {
  let out = s.trim();
  for (;;) {
    if (!(out.startsWith('(') && out.endsWith(')'))) return out;
    // only strip if the parens wrap the whole expression
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') depth--;
      if (depth === 0 && i < out.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) return out;
    out = out.slice(1, -1).trim();
  }
}

export function toPostgresDefault(def: string | undefined, col: Column, dialect: Dialect): string | undefined {
  if (def === undefined || def === '') return undefined;
  if (dialect === 'postgres' || dialect === 'generic') return def;
  let d = stripOuterParens(def);
  const pgType = toPostgresType(col.type, dialect);
  if (/^(getdate|sysdatetime|getutcdate|sysutcdatetime|sysdatetimeoffset)\s*\(\s*\)$/i.test(d)) return 'now()';
  if (/^(newid|newsequentialid)\s*\(\s*\)$/i.test(d)) return 'gen_random_uuid()';
  if (/^\(?\s*datetime\s*\(\s*'now'\s*\)\s*\)?$/i.test(d)) return 'now()';
  if (/^current_timestamp(\(\d*\))?$/i.test(d)) return 'CURRENT_TIMESTAMP';
  if (pgType === 'boolean') {
    if (/^(b?'?1'?|true)$/i.test(d)) return 'true';
    if (/^(b?'?0'?|false)$/i.test(d)) return 'false';
  }
  if (/^N'/.test(d)) d = d.slice(1);
  return d;
}

const INTEGER_TYPES = new Set(['integer', 'int', 'int4', 'bigint', 'int8', 'smallint', 'int2']);

function columnSql(col: Column, dialect: Dialect): string {
  const type = toPostgresType(col.type, dialect);
  const parts = [quoteIdent(col.name), type];
  const serial = /serial/i.test(type);
  if (col.identity && !serial && INTEGER_TYPES.has(type.toLowerCase())) parts.push('GENERATED BY DEFAULT AS IDENTITY');
  if (!col.nullable || col.pk) parts.push('NOT NULL');
  const def = toPostgresDefault(col.default, col, dialect);
  if (def) {
    if (/^GENERATED\s/i.test(def)) parts.push(def);
    else if (!(col.identity && /nextval\s*\(/i.test(def))) parts.push(`DEFAULT ${def}`);
  }
  return parts.join(' ');
}

function actionSql(r: Relation): string {
  let s = '';
  if (r.onDelete && r.onDelete !== 'NO ACTION') s += ` ON DELETE ${r.onDelete}`;
  if (r.onUpdate && r.onUpdate !== 'NO ACTION') s += ` ON UPDATE ${r.onUpdate}`;
  return s;
}

function colNames(t: Table, ids: string[]): string[] {
  return ids.map((id) => t.columns.find((c) => c.id === id)?.name ?? '?');
}

function defaultFkName(t: Table, cols: string[]): string {
  return `${t.name}_${cols.join('_')}_fkey`.slice(0, 63);
}

function fkSql(r: Relation, byId: Map<string, Table>, dialect: Dialect): string | undefined {
  const from = byId.get(r.fromTable);
  const to = byId.get(r.toTable);
  if (!from || !to) return undefined;
  const fc = colNames(from, r.fromColumns);
  const tc = colNames(to, r.toColumns);
  const name = r.name || defaultFkName(from, fc);
  return (
    `ALTER TABLE ${qualified(from, dialect)} ADD CONSTRAINT ${quoteIdent(name)} ` +
    `FOREIGN KEY (${fc.map(quoteIdent).join(', ')}) REFERENCES ${qualified(to, dialect)} (${tc.map(quoteIdent).join(', ')})${actionSql(r)};`
  );
}

function createTableSql(t: Table, dialect: Dialect): string[] {
  const lines = t.columns.map((c) => `    ${columnSql(c, dialect)}`);
  const pk = t.columns.filter((c) => c.pk);
  if (pk.length) {
    const nm = t.pkName ? `CONSTRAINT ${quoteIdent(t.pkName)} ` : '';
    lines.push(`    ${nm}PRIMARY KEY (${pk.map((c) => quoteIdent(c.name)).join(', ')})`);
  }
  for (const c of t.columns) {
    if (!c.unique || c.pk || t.uniqueIndexes?.[c.id]) continue;
    const nm = t.uniqueNames?.[c.id];
    lines.push(`    ${nm ? `CONSTRAINT ${quoteIdent(nm)} ` : ''}UNIQUE (${quoteIdent(c.name)})`);
  }
  for (const u of t.uniques ?? []) {
    const names = colNames(t, u.columns);
    if (names.includes('?')) continue;
    lines.push(`    ${u.name ? `CONSTRAINT ${quoteIdent(u.name)} ` : ''}UNIQUE (${names.map(quoteIdent).join(', ')})`);
  }
  const out = [`CREATE TABLE ${qualified(t, dialect)} (\n${lines.join(',\n')}\n);`];
  for (const c of t.columns) {
    const idx = t.uniqueIndexes?.[c.id];
    if (c.unique && !c.pk && idx) out.push(`CREATE UNIQUE INDEX ${quoteIdent(idx)} ON ${qualified(t, dialect)} (${quoteIdent(c.name)});`);
  }
  if (t.comment) out.push(`COMMENT ON TABLE ${qualified(t, dialect)} IS ${quoteLiteral(t.comment)};`);
  for (const c of t.columns)
    if (c.comment) out.push(`COMMENT ON COLUMN ${qualified(t, dialect)}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`);
  return out;
}

function extensionsFor(tables: Table[], dialect: Dialect): string[] {
  const all = tables.flatMap((t) => t.columns);
  const ext: string[] = [];
  if (all.some((c) => /uuid_generate_v\d/i.test(c.default ?? ''))) ext.push('"uuid-ossp"');
  if (all.some((c) => /\b(crypt|gen_salt|digest|hmac)\s*\(/i.test(c.default ?? ''))) ext.push('pgcrypto');
  if (all.some((c) => /^citext/i.test(toPostgresType(c.type, dialect)))) ext.push('citext');
  if (all.some((c) => /^vector\b/i.test(toPostgresType(c.type, dialect)))) ext.push('vector');
  return ext.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e};`);
}

function typeSql(t: UserType, dialect: Dialect): string {
  const name = `${quoteIdent(pgSchemaName(t.schema, dialect))}.${quoteIdent(t.name)}`;
  if (t.kind === 'enum') return `CREATE TYPE ${name} AS ENUM (${(t.values ?? []).map(quoteLiteral).join(', ')});`;
  return `CREATE DOMAIN ${name} ${t.definition ?? 'AS text'};`;
}

/** Types in the exported schemas plus any type a column of an exported table refers to. */
function typesFor(schema: Schema, tables: Table[], include?: Set<string>): UserType[] {
  const all = schema.types ?? [];
  if (!all.length) return [];
  const used = new Set(tables.flatMap((t) => t.columns.map((c) => c.type.toLowerCase().replace(/\[\]$/, '').replace(/"/g, ''))));
  return all.filter((t) => {
    if (!include || include.has(t.schema)) return true;
    return used.has(t.name.toLowerCase()) || used.has(`${t.schema}.${t.name}`.toLowerCase());
  });
}

function header(title: string): string[] {
  return [`-- ${title}`, `-- Generated by ERD Viewer on ${new Date().toISOString()}`, ''];
}

export interface FullExportOptions {
  /** Only export tables in these schemas (as shown in the diagram). */
  schemas?: string[];
  sourceLabel?: string;
}

export function generateFullSql(schema: Schema, opts: FullExportOptions = {}): string {
  const d = schema.dialect;
  const include = opts.schemas ? new Set(opts.schemas) : undefined;
  const tables = schema.tables.filter((t) => !include || include.has(t.schema));
  const ids = new Set(tables.map((t) => t.id));
  const byId = new Map(schema.tables.map((t) => [t.id, t]));
  const out = header('PostgreSQL schema');
  if (opts.sourceLabel) out.splice(1, 0, `-- Source: ${opts.sourceLabel}`);
  if (d !== 'postgres') out.push(`-- Converted from ${d}; review type mappings before running.`, '');

  const ext = extensionsFor(tables, d);
  if (ext.length) out.push(...ext, '');
  const types = typesFor(schema, tables, include);
  const schemas = [...new Set([...tables, ...types].map((t) => pgSchemaName(t.schema, d)))].filter((s) => s !== 'public').sort();
  if (schemas.length) out.push(...schemas.map((s) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`), '');
  if (types.length) out.push('-- Types', ...types.map((t) => typeSql(t, d)), '');

  for (const t of tables) out.push(...createTableSql(t, d), '');

  const fks = schema.relations
    .filter((r) => ids.has(r.fromTable) && ids.has(r.toTable))
    .map((r) => fkSql(r, byId, d))
    .filter((x): x is string => !!x);
  if (fks.length) out.push('-- Foreign keys', ...fks, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Change-only migration: baseline -> current, matched by stable ids
// ---------------------------------------------------------------------------

function sameRelation(a: Relation, b: Relation): boolean {
  return (
    a.fromTable === b.fromTable &&
    a.toTable === b.toTable &&
    a.fromColumns.join() === b.fromColumns.join() &&
    a.toColumns.join() === b.toColumns.join() &&
    (a.onDelete ?? 'NO ACTION') === (b.onDelete ?? 'NO ACTION') &&
    (a.onUpdate ?? 'NO ACTION') === (b.onUpdate ?? 'NO ACTION')
  );
}

export function generateDiffSql(baseline: Schema, current: Schema): string {
  const d = current.dialect;
  const bd = baseline.dialect;
  const baseById = new Map(baseline.tables.map((t) => [t.id, t]));
  const curById = new Map(current.tables.map((t) => [t.id, t]));

  const dropFks: string[] = [];
  const dropTables: string[] = [];
  const newTables: string[] = [];
  const alters: string[] = [];
  const addFks: string[] = [];
  const comments: string[] = [];

  // Foreign keys removed or changed
  const curRel = new Map(current.relations.map((r) => [r.id, r]));
  const baseRel = new Map(baseline.relations.map((r) => [r.id, r]));
  for (const r of baseline.relations) {
    const now = curRel.get(r.id);
    if (now && sameRelation(r, now)) continue;
    const from = baseById.get(r.fromTable);
    if (!from) continue;
    // If the child table itself is dropped, its FKs go with it.
    if (!curById.has(r.fromTable)) continue;
    const name = r.name || defaultFkName(from, colNames(from, r.fromColumns));
    // Use the table's current name: renames run before this statement would be wrong, so drop first using old name.
    dropFks.push(`ALTER TABLE ${qualified(from, bd)} DROP CONSTRAINT IF EXISTS ${quoteIdent(name)};`);
  }

  // Dropped tables
  for (const t of baseline.tables) if (!curById.has(t.id)) dropTables.push(`DROP TABLE IF EXISTS ${qualified(t, bd)};`);

  // New tables
  const newOnes = current.tables.filter((t) => !baseById.has(t.id));
  const neededSchemas = [...new Set(newOnes.map((t) => pgSchemaName(t.schema, d)))].filter(
    (s) => s !== 'public' && !baseline.tables.some((b) => pgSchemaName(b.schema, bd) === s),
  );
  for (const s of neededSchemas) newTables.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)};`);
  for (const t of newOnes) newTables.push(...createTableSql(t, d), '');

  // Altered tables
  for (const cur of current.tables) {
    const base = baseById.get(cur.id);
    if (!base) continue;
    const stmts: string[] = [];
    let name = qualified(base, bd);
    if (pgSchemaName(base.schema, bd) !== pgSchemaName(cur.schema, d)) {
      stmts.push(`ALTER TABLE ${name} SET SCHEMA ${quoteIdent(pgSchemaName(cur.schema, d))};`);
      name = `${quoteIdent(pgSchemaName(cur.schema, d))}.${quoteIdent(base.name)}`;
    }
    if (base.name !== cur.name) {
      stmts.push(`ALTER TABLE ${name} RENAME TO ${quoteIdent(cur.name)};`);
    }
    name = qualified(cur, d);

    const baseCols = new Map(base.columns.map((c) => [c.id, c]));
    const curCols = new Map(cur.columns.map((c) => [c.id, c]));

    // PK changes: drop old PK before column drops/changes
    const basePk = base.columns.filter((c) => c.pk).map((c) => c.id).join();
    const curPk = cur.columns.filter((c) => c.pk).map((c) => c.id).join();
    const pkChanged = basePk !== curPk;
    if (pkChanged && basePk) stmts.push(`ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS ${quoteIdent(base.pkName ?? `${base.name}_pkey`)};`);

    for (const bc of base.columns) {
      if (!curCols.has(bc.id)) stmts.push(`ALTER TABLE ${name} DROP COLUMN IF EXISTS ${quoteIdent(bc.name)};`);
    }
    for (const cc of cur.columns) {
      const bc = baseCols.get(cc.id);
      if (!bc) {
        stmts.push(`ALTER TABLE ${name} ADD COLUMN ${columnSql({ ...cc, pk: false }, d)};`);
        if (cc.unique && !cc.pk) stmts.push(`ALTER TABLE ${name} ADD CONSTRAINT ${quoteIdent(`${cur.name}_${cc.name}_key`.slice(0, 63))} UNIQUE (${quoteIdent(cc.name)});`);
        if (cc.comment) comments.push(`COMMENT ON COLUMN ${name}.${quoteIdent(cc.name)} IS ${quoteLiteral(cc.comment)};`);
        continue;
      }
      const col = quoteIdent(cc.name);
      if (bc.name !== cc.name) stmts.push(`ALTER TABLE ${name} RENAME COLUMN ${quoteIdent(bc.name)} TO ${col};`);
      const bt = toPostgresType(bc.type, bd);
      const ct = toPostgresType(cc.type, d);
      if (bt.toLowerCase() !== ct.toLowerCase()) stmts.push(`ALTER TABLE ${name} ALTER COLUMN ${col} TYPE ${ct} USING ${col}::${ct};`);
      const bNull = bc.nullable && !bc.pk;
      const cNull = cc.nullable && !cc.pk;
      if (bNull && !cNull) stmts.push(`ALTER TABLE ${name} ALTER COLUMN ${col} SET NOT NULL;`);
      if (!bNull && cNull) stmts.push(`ALTER TABLE ${name} ALTER COLUMN ${col} DROP NOT NULL;`);
      const bdf = toPostgresDefault(bc.default, bc, bd) ?? '';
      const cdf = toPostgresDefault(cc.default, cc, d) ?? '';
      if (bdf !== cdf && !/^GENERATED\s/i.test(cdf) && !/^GENERATED\s/i.test(bdf)) {
        stmts.push(cdf ? `ALTER TABLE ${name} ALTER COLUMN ${col} SET DEFAULT ${cdf};` : `ALTER TABLE ${name} ALTER COLUMN ${col} DROP DEFAULT;`);
      }
      if (!bc.identity && cc.identity && INTEGER_TYPES.has(ct.toLowerCase()))
        stmts.push(`ALTER TABLE ${name} ALTER COLUMN ${col} ADD GENERATED BY DEFAULT AS IDENTITY;`);
      if (bc.identity && !cc.identity && !/serial/i.test(bt)) stmts.push(`ALTER TABLE ${name} ALTER COLUMN ${col} DROP IDENTITY IF EXISTS;`);
      const bUnique = bc.unique && !bc.pk;
      const cUnique = cc.unique && !cc.pk;
      if (bUnique && !cUnique) {
        const idx = base.uniqueIndexes?.[bc.id];
        if (idx) stmts.push(`DROP INDEX IF EXISTS ${quoteIdent(pgSchemaName(cur.schema, d))}.${quoteIdent(idx)};`);
        else
          stmts.push(
            `ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS ${quoteIdent(base.uniqueNames?.[bc.id] ?? `${base.name}_${bc.name}_key`)};`,
          );
      }
      if (!bUnique && cUnique)
        stmts.push(`ALTER TABLE ${name} ADD CONSTRAINT ${quoteIdent(`${cur.name}_${cc.name}_key`.slice(0, 63))} UNIQUE (${col});`);
      if ((bc.comment ?? '') !== (cc.comment ?? ''))
        comments.push(`COMMENT ON COLUMN ${name}.${col} IS ${cc.comment ? quoteLiteral(cc.comment) : 'NULL'};`);
    }

    if (pkChanged && curPk) {
      const cols = cur.columns.filter((c) => c.pk).map((c) => quoteIdent(c.name));
      stmts.push(`ALTER TABLE ${name} ADD PRIMARY KEY (${cols.join(', ')});`);
    }
    if ((base.comment ?? '') !== (cur.comment ?? ''))
      comments.push(`COMMENT ON TABLE ${name} IS ${cur.comment ? quoteLiteral(cur.comment) : 'NULL'};`);

    if (stmts.length) alters.push(`-- ${cur.schema ? cur.schema + '.' : ''}${cur.name}`, ...stmts, '');
  }

  // Foreign keys added or changed
  for (const r of current.relations) {
    const was = baseRel.get(r.id);
    if (was && sameRelation(was, r)) continue;
    const sql = fkSql(r, curById, d);
    if (sql) addFks.push(sql);
  }

  const out = header('PostgreSQL migration (changes made in the ERD editor)');
  const body = [
    ...(dropFks.length ? ['-- Drop changed/removed foreign keys', ...dropFks, ''] : []),
    ...(dropTables.length ? ['-- Drop removed tables', ...dropTables, ''] : []),
    ...(newTables.length ? ['-- New tables', ...extensionsFor(newOnes, d), ...newTables] : []),
    ...(alters.length ? ['-- Altered tables', ...alters] : []),
    ...(addFks.length ? ['-- Add new/changed foreign keys', ...addFks, ''] : []),
    ...(comments.length ? ['-- Comments', ...comments, ''] : []),
  ];
  if (!body.length) return [...out, '-- No changes.', ''].join('\n');
  return [...out, 'BEGIN;', '', ...body, 'COMMIT;', ''].join('\n');
}
