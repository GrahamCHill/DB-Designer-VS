// Schema export to other SQL dialects. The diagram's canonical form is PostgreSQL: every column type is
// first normalised to its PostgreSQL equivalent, then mapped to the closest type in the target.
// Anything without a faithful equivalent is converted to the nearest safe form and noted in a comment.

import { Column, Relation, Schema, Table, UserType } from './model';
import { generateFullSql, pgSchemaName, toPostgresDefault, toPostgresType } from './pgExport';

export type ExportDialect = 'postgres' | 'mssql' | 'mysql' | 'sqlite';

export const EXPORT_DIALECTS: { id: ExportDialect; label: string; ext: string }[] = [
  { id: 'postgres', label: 'PostgreSQL', ext: 'pg' },
  { id: 'mssql', label: 'SQL Server', ext: 'mssql' },
  { id: 'mysql', label: 'MySQL / MariaDB', ext: 'mysql' },
  { id: 'sqlite', label: 'SQLite', ext: 'sqlite' },
];

export interface ExportOptions {
  /** Only export tables in these schemas. */
  schemas?: string[];
  sourceLabel?: string;
}

export function generateSchemaSql(schema: Schema, target: ExportDialect, opts: ExportOptions = {}): string {
  switch (target) {
    case 'postgres':
      return generateFullSql(schema, opts);
    case 'mssql':
      return new MssqlWriter(schema, opts).write();
    case 'mysql':
      return new MysqlWriter(schema, opts).write();
    case 'sqlite':
      return new SqliteWriter(schema, opts).write();
  }
}

// ---------------------------------------------------------------------------
// Canonical (PostgreSQL) column type
// ---------------------------------------------------------------------------

export type PgKind =
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'real'
  | 'double'
  | 'money'
  | 'boolean'
  | 'text'
  | 'varchar'
  | 'char'
  | 'uuid'
  | 'date'
  | 'time'
  | 'timetz'
  | 'timestamp'
  | 'timestamptz'
  | 'interval'
  | 'json'
  | 'bytea'
  | 'inet'
  | 'xml'
  | 'tsvector'
  | 'enum'
  | 'other';

export interface PgType {
  kind: PgKind;
  length?: number;
  precision?: number;
  scale?: number;
  array: boolean;
  /** serial / bigserial / smallserial */
  serial: boolean;
  enumValues?: string[];
  /** Original canonical text, for comments. */
  text: string;
}

const KIND_ALIASES: [RegExp, PgKind][] = [
  [/^(smallint|int2|smallserial|serial2)$/, 'smallint'],
  [/^(integer|int|int4|serial|serial4|mediumint)$/, 'integer'],
  [/^(bigint|int8|bigserial|serial8)$/, 'bigint'],
  [/^(numeric|decimal)$/, 'numeric'],
  [/^(real|float4)$/, 'real'],
  [/^(double precision|float8|float|double)$/, 'double'],
  [/^money$/, 'money'],
  [/^(boolean|bool)$/, 'boolean'],
  [/^(text|citext|name|string|clob)$/, 'text'],
  [/^(character varying|varchar|nvarchar)$/, 'varchar'],
  [/^(character|char|bpchar|nchar)$/, 'char'],
  [/^uuid$/, 'uuid'],
  [/^date$/, 'date'],
  [/^(time|time without time zone)$/, 'time'],
  [/^(timetz|time with time zone)$/, 'timetz'],
  [/^(timestamp|timestamp without time zone|datetime)$/, 'timestamp'],
  [/^(timestamptz|timestamp with time zone)$/, 'timestamptz'],
  [/^interval$/, 'interval'],
  [/^(json|jsonb)$/, 'json'],
  [/^(bytea|blob)$/, 'bytea'],
  [/^(inet|cidr|macaddr|macaddr8)$/, 'inet'],
  [/^xml$/, 'xml'],
  [/^(tsvector|tsquery)$/, 'tsvector'],
];

function findUserType(types: UserType[] | undefined, typeText: string): UserType | undefined {
  if (!types?.length) return undefined;
  const t = typeText.replace(/"/g, '').replace(/\[\]$/, '').toLowerCase();
  return types.find((u) => u.name.toLowerCase() === t || `${u.schema}.${u.name}`.toLowerCase() === t);
}

export function canonicalType(col: Column, schema: Schema, depth = 0): PgType {
  let text = toPostgresType(col.type, schema.dialect).trim().toLowerCase();
  const array = /\[\]\s*$/.test(text) || /\barray$/.test(text);
  text = text.replace(/\s*\[\]\s*$/, '').replace(/\s+array$/, '');
  const user = findUserType(schema.types, text);
  if (user?.kind === 'enum') return { kind: 'enum', array, serial: false, enumValues: user.values ?? [], text };
  if (user?.kind === 'domain' && depth < 3) {
    const base = /^\s*as\s+(.+?)(\s+(default|not|null|check|constraint|collate)\b.*)?$/i.exec(user.definition ?? '')?.[1] ?? 'text';
    return { ...canonicalType({ ...col, type: base }, { ...schema, dialect: 'postgres' }, depth + 1), array };
  }
  // "timestamp(3) with time zone" -> base "timestamp with time zone", args "(3)"
  const m = /^([a-z_ ]+?)\s*(?:\(([^)]*)\))?\s*(with(?:out)? time zone)?$/.exec(text);
  const baseRaw = m ? `${m[1].trim()}${m[3] ? ' ' + m[3] : ''}` : text;
  const args = (m?.[2] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  const kind = KIND_ALIASES.find(([re]) => re.test(baseRaw))?.[1] ?? 'other';
  const serial = /serial/.test(baseRaw);
  const out: PgType = { kind, array, serial, text };
  if (kind === 'varchar' || kind === 'char') out.length = args[0];
  if (kind === 'numeric') {
    out.precision = args[0];
    out.scale = args[1];
  }
  if (kind === 'timestamp' || kind === 'timestamptz' || kind === 'time' || kind === 'timetz') out.precision = args[0];
  return out;
}

// ---------------------------------------------------------------------------
// Canonical default expression
// ---------------------------------------------------------------------------

export type DefaultValue =
  | { kind: 'now' }
  | { kind: 'today' }
  | { kind: 'uuid' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'null' }
  | { kind: 'emptyArray' }
  | { kind: 'sequence' }
  | { kind: 'unsupported'; expr: string };

function stripCasts(expr: string): string {
  let e = expr.trim();
  for (let i = 0; i < 5; i++) {
    const next = e
      .replace(/^\((.*)\)$/s, '$1')
      .replace(/::\s*"?[a-z_][\w ."]*(\(\d+(,\s*\d+)?\))?(\[\])?\s*$/i, '')
      .trim();
    if (next === e) break;
    e = next;
  }
  return e;
}

export function canonicalDefault(col: Column, schema: Schema): DefaultValue | undefined {
  const raw = toPostgresDefault(col.default, col, schema.dialect);
  if (!raw || /^GENERATED\s/i.test(raw)) return undefined;
  const e = stripCasts(raw).replace(/^([-+])\s+(?=\d)/, '$1');
  if (/^nextval\s*\(/i.test(e)) return { kind: 'sequence' };
  if (/^(now\s*\(\s*\)|current_timestamp(\s*\(\s*\d*\s*\))?|localtimestamp|transaction_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|clock_timestamp\s*\(\s*\)|timezone\s*\(\s*'utc'\s*,\s*now\s*\(\s*\)\s*\))$/i.test(e))
    return { kind: 'now' };
  if (/^(current_date|\('now'\)::date)$/i.test(e)) return { kind: 'today' };
  if (/^(gen_random_uuid|uuid_generate_v4|uuid_generate_v1|newid)\s*\(\s*\)$/i.test(e)) return { kind: 'uuid' };
  if (/^true$/i.test(e)) return { kind: 'bool', value: true };
  if (/^false$/i.test(e)) return { kind: 'bool', value: false };
  if (/^null$/i.test(e)) return { kind: 'null' };
  if (/^[-+]?\d+(\.\d+)?$/.test(e)) return { kind: 'number', value: e };
  if (/^(array\s*\[\s*\]|'\{\}')$/i.test(e) && canonicalType(col, schema).array) return { kind: 'emptyArray' };
  const str = /^[EN]?'((?:[^']|'')*)'$/s.exec(e);
  if (str) return { kind: 'string', value: str[1].replace(/''/g, "'") };
  return { kind: 'unsupported', expr: raw };
}

// ---------------------------------------------------------------------------
// Shared writer machinery
// ---------------------------------------------------------------------------

interface ColPlan {
  col: Column;
  name: string;
  type: string;
  nullable: boolean;
  identity: boolean;
  default?: string;
  check?: string;
  comment?: string;
  notes: string[];
}

interface TablePlan {
  table: Table;
  /** Fully qualified, quoted name. */
  qname: string;
  cols: ColPlan[];
}

abstract class Writer {
  protected tables: Table[];
  protected byId: Map<string, Table>;
  protected relations: Relation[];
  /** Column ids that take part in a key, unique constraint or foreign key (need bounded types). */
  protected keyCols = new Set<string>();
  protected notes: string[] = [];
  private usedNames = new Set<string>();

  constructor(
    protected schema: Schema,
    protected opts: ExportOptions,
  ) {
    const include = opts.schemas ? new Set(opts.schemas) : undefined;
    this.tables = schema.tables.filter((t) => !include || include.has(t.schema));
    const ids = new Set(this.tables.map((t) => t.id));
    this.byId = new Map(this.tables.map((t) => [t.id, t]));
    this.relations = schema.relations.filter((r) => ids.has(r.fromTable) && ids.has(r.toTable));
    for (const t of this.tables) {
      for (const c of t.columns) if (c.pk || c.unique) this.keyCols.add(c.id);
      for (const u of t.uniques ?? []) u.columns.forEach((id) => this.keyCols.add(id));
    }
    for (const r of this.relations) [...r.fromColumns, ...r.toColumns].forEach((id) => this.keyCols.add(id));
  }

  protected abstract dialectName: string;
  protected abstract q(name: string): string;
  protected abstract maxNameLength: number;

  /** Constraint names must be unique per schema/database in SQL Server and MySQL. */
  protected uniqueName(base: string): string {
    let n = base.slice(0, this.maxNameLength);
    let i = 2;
    while (this.usedNames.has(n.toLowerCase())) {
      const suffix = `_${i++}`;
      n = base.slice(0, this.maxNameLength - suffix.length) + suffix;
    }
    this.usedNames.add(n.toLowerCase());
    return n;
  }

  protected colName(t: Table, id: string): string {
    return t.columns.find((c) => c.id === id)?.name ?? '?';
  }

  protected header(): string[] {
    const lines = [
      `-- ${this.dialectName} schema`,
      `-- Generated by DB Designer on ${new Date().toISOString()}`,
    ];
    if (this.opts.sourceLabel) lines.push(`-- Source: ${this.opts.sourceLabel}`);
    lines.push(`-- Converted from the PostgreSQL model with the closest ${this.dialectName} types.`, '');
    return lines;
  }

  /** Make FK columns use exactly the referenced column's type (SQL Server requires identical types). */
  protected alignFkTypes(plans: Map<string, TablePlan>) {
    const colPlan = (tableId: string, colId: string) => plans.get(tableId)?.cols.find((c) => c.col.id === colId);
    for (const r of this.relations) {
      r.fromColumns.forEach((fc, i) => {
        const child = colPlan(r.fromTable, fc);
        const parent = colPlan(r.toTable, r.toColumns[i]);
        if (child && parent && child.type !== parent.type) child.type = parent.type;
      });
    }
  }

  /**
   * SQL Server and MySQL reject SET NULL when a referencing column is NOT NULL, and SQL Server rejects
   * SET DEFAULT when a NOT NULL referencing column has no default. (PostgreSQL only fails at delete time.)
   */
  protected actionAllowed(r: Relation, action: string | undefined, plans: Map<string, TablePlan>): boolean {
    if (action !== 'SET NULL' && action !== 'SET DEFAULT') return true;
    const cols = plans.get(r.fromTable)?.cols.filter((c) => r.fromColumns.includes(c.col.id)) ?? [];
    if (action === 'SET NULL') return cols.every((c) => c.nullable);
    return cols.every((c) => c.nullable || c.default !== undefined);
  }

  /** Domain CHECK constraints are not converted; say so. */
  protected domainNote(c: Column): string | undefined {
    const u = findUserType(this.schema.types, toPostgresType(c.type, this.schema.dialect).trim().toLowerCase());
    if (u?.kind === 'domain' && /\bcheck\b/i.test(u.definition ?? ''))
      return `${c.name}: CHECK from domain ${u.name} (${u.definition}) not converted`;
    return undefined;
  }

  protected commentLines(notes: string[]): string[] {
    return notes.length ? ['-- Conversion notes:', ...notes.map((n) => `--   ${n}`), ''] : [];
  }
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

class MssqlWriter extends Writer {
  protected dialectName = 'SQL Server';
  protected maxNameLength = 128;
  protected q(n: string) {
    return `[${n.replace(/]/g, ']]')}]`;
  }
  private schemaName(t: Table) {
    const s = pgSchemaName(t.schema, this.schema.dialect);
    return s === 'public' ? 'dbo' : s;
  }
  private str(s: string) {
    return `N${sqlString(s)}`;
  }

  private mapType(c: Column, pt: PgType, notes: string[]): { type: string; check?: string } {
    const key = this.keyCols.has(c.id);
    const text = (len?: number) => {
      if (key) return `nvarchar(${len && len <= 450 ? len : 450})`; // nvarchar(max) can't be a key
      return len && len <= 4000 ? `nvarchar(${len})` : 'nvarchar(max)';
    };
    if (pt.array) {
      notes.push(`${c.name}: ${pt.text}[] stored as JSON text (nvarchar(max))`);
      return { type: key ? 'nvarchar(450)' : 'nvarchar(max)' };
    }
    switch (pt.kind) {
      case 'smallint':
        return { type: 'smallint' };
      case 'integer':
        return { type: 'int' };
      case 'bigint':
        return { type: 'bigint' };
      case 'numeric': {
        const p = Math.min(pt.precision ?? 38, 38);
        const s = Math.min(pt.scale ?? (pt.precision ? 0 : 10), p);
        if (!pt.precision) notes.push(`${c.name}: unbounded numeric mapped to decimal(38,10)`);
        return { type: `decimal(${p},${s})` };
      }
      case 'real':
        return { type: 'real' };
      case 'double':
        return { type: 'float' };
      case 'money':
        return { type: 'money' };
      case 'boolean':
        return { type: 'bit' };
      case 'text':
        return { type: text() };
      case 'varchar':
        return { type: text(pt.length) };
      case 'char':
        return { type: `nchar(${Math.min(pt.length ?? 1, 4000)})` };
      case 'uuid':
        return { type: 'uniqueidentifier' };
      case 'date':
        return { type: 'date' };
      case 'time':
      case 'timetz':
        if (pt.kind === 'timetz') notes.push(`${c.name}: time with time zone has no equivalent; mapped to time (zone dropped)`);
        return { type: pt.precision !== undefined ? `time(${Math.min(pt.precision, 7)})` : 'time' };
      case 'timestamp':
        return { type: pt.precision !== undefined ? `datetime2(${Math.min(pt.precision, 7)})` : 'datetime2' };
      case 'timestamptz':
        return { type: pt.precision !== undefined ? `datetimeoffset(${Math.min(pt.precision, 7)})` : 'datetimeoffset' };
      case 'interval':
        notes.push(`${c.name}: interval has no equivalent; stored as text (nvarchar(100))`);
        return { type: 'nvarchar(100)' };
      case 'json':
        return { type: key ? 'nvarchar(450)' : 'nvarchar(max)', check: `ISJSON(${this.q(c.name)}) = 1` };
      case 'bytea':
        return { type: key ? 'varbinary(900)' : 'varbinary(max)' };
      case 'inet':
        return { type: 'nvarchar(50)' };
      case 'xml':
        return { type: 'xml' };
      case 'tsvector':
        notes.push(`${c.name}: tsvector has no equivalent (use SQL Server full-text search); stored as nvarchar(max)`);
        return { type: key ? 'nvarchar(450)' : 'nvarchar(max)' };
      case 'enum': {
        const vals = pt.enumValues ?? [];
        const len = Math.max(1, ...vals.map((v) => v.length));
        return {
          type: `nvarchar(${Math.min(Math.max(len, 20), 450)})`,
          check: vals.length ? `${this.q(c.name)} IN (${vals.map((v) => this.str(v)).join(', ')})` : undefined,
        };
      }
      default:
        notes.push(`${c.name}: type "${pt.text}" has no direct equivalent; stored as nvarchar`);
        return { type: text() };
    }
  }

  private mapDefault(c: Column, pt: PgType, sqlType: string, notes: string[]): string | undefined {
    const d = canonicalDefault(c, this.schema);
    if (!d) return undefined;
    switch (d.kind) {
      case 'now':
        return sqlType.startsWith('datetimeoffset') ? 'SYSDATETIMEOFFSET()' : sqlType === 'date' ? 'CAST(SYSDATETIME() AS date)' : 'SYSDATETIME()';
      case 'today':
        return 'CAST(SYSDATETIME() AS date)';
      case 'uuid':
        return sqlType === 'uniqueidentifier' ? 'NEWID()' : 'CONVERT(nvarchar(36), NEWID())';
      case 'bool':
        return d.value ? '1' : '0';
      case 'number':
        return d.value;
      case 'string':
        return pt.kind === 'boolean' ? (/^(t|true|1|y|yes|on)$/i.test(d.value) ? '1' : '0') : this.str(d.value);
      case 'null':
        return undefined; // DEFAULT NULL is the implicit default
      case 'emptyArray':
        return this.str('[]');
      case 'sequence':
        return undefined;
      case 'unsupported':
        notes.push(`${c.name}: default ${d.expr} has no SQL Server equivalent and was left out`);
        return undefined;
    }
  }

  /** Give FK columns and referenced columns the same (shortest) nvarchar length; true if anything changed. */
  private shareFkLengths(plans: Map<string, TablePlan>): boolean {
    let changed = false;
    const plan = (t: string, c: string) => plans.get(t)?.cols.find((x) => x.col.id === c);
    for (const r of this.relations) {
      r.fromColumns.forEach((fc, i) => {
        const a = plan(r.fromTable, fc);
        const b = plan(r.toTable, r.toColumns[i]);
        const la = a && /^nvarchar\((\d+)\)$/.exec(a.type)?.[1];
        const lb = b && /^nvarchar\((\d+)\)$/.exec(b.type)?.[1];
        if (!a || !b || !la || !lb || la === lb) return;
        const n = Math.min(Number(la), Number(lb));
        for (const x of [a, b])
          if (x.type !== `nvarchar(${n})`) {
            x.notes.push(`${x.name}: shortened to nvarchar(${n}) to match the related key`);
            x.type = `nvarchar(${n})`;
            changed = true;
          }
      });
    }
    return changed;
  }

  /** Bytes a value of this SQL Server type can take in an index key. */
  private keyBytes(type: string): number {
    const m = /^(nvarchar|nchar)\((\d+)\)$/.exec(type);
    if (m) return Number(m[2]) * 2;
    const v = /^(varbinary|varchar|char)\((\d+)\)$/.exec(type);
    if (v) return Number(v[2]);
    return (
      { bit: 1, tinyint: 1, smallint: 2, int: 4, bigint: 8, real: 4, float: 8, money: 8, date: 3, time: 5, datetime2: 8, datetimeoffset: 10, uniqueidentifier: 16 } as Record<string, number>
    )[type.replace(/\(.*$/, '')] ?? 17;
  }

  /**
   * SQL Server index keys are limited to 900 bytes (clustered primary key) and 1700 bytes (unique
   * indexes). Share the budget between a key's text columns so long composite keys still fit.
   */
  private fitKeySizes(plans: Map<string, TablePlan>) {
    const limit = new Map<string, number>(); // column id -> max nvarchar length
    for (const { table: t, cols } of plans.values()) {
      const keys: { ids: string[]; budget: number }[] = [];
      const pk = t.columns.filter((c) => c.pk).map((c) => c.id);
      if (pk.length) keys.push({ ids: pk, budget: 900 });
      for (const c of t.columns) if (c.unique && !c.pk) keys.push({ ids: [c.id], budget: 1700 });
      for (const u of t.uniques ?? []) keys.push({ ids: u.columns, budget: 1700 });
      for (const k of keys) {
        const kc = cols.filter((c) => k.ids.includes(c.col.id));
        const text = kc.filter((c) => /^nvarchar\(\d+\)$/.test(c.type));
        if (!text.length) continue;
        const fixed = kc.filter((c) => !text.includes(c)).reduce((a, c) => a + this.keyBytes(c.type), 0);
        const per = Math.max(16, Math.floor((k.budget - fixed) / text.length / 2));
        for (const c of text) limit.set(c.col.id, Math.min(limit.get(c.col.id) ?? 450, per));
      }
    }
    for (const { table: t, cols } of plans.values()) {
      for (const c of cols) {
        const max = limit.get(c.col.id);
        const m = /^nvarchar\((\d+)\)$/.exec(c.type);
        if (max !== undefined && m && Number(m[1]) > max) {
          c.notes.push(`${c.name}: shortened to nvarchar(${max}) so its key fits SQL Server's index size limit`);
          c.type = `nvarchar(${max})`;
        }
      }
      void t;
    }
  }

  write(): string {
    const out = this.header();
    out.push('SET ANSI_NULLS ON;', 'SET QUOTED_IDENTIFIER ON;', 'GO', '');
    const schemas = [...new Set(this.tables.map((t) => this.schemaName(t)))].filter((s) => s !== 'dbo').sort();
    for (const s of schemas) out.push(`IF SCHEMA_ID(${this.str(s)}) IS NULL EXEC(${this.str(`CREATE SCHEMA ${this.q(s)}`)});`);
    if (schemas.length) out.push('GO', '');

    const plans = new Map<string, TablePlan>();
    for (const t of this.tables) {
      const cols: ColPlan[] = t.columns.map((c) => {
        const notes: string[] = [];
        const pt = canonicalType(c, this.schema);
        const dn = this.domainNote(c);
        if (dn) notes.push(dn);
        const { type, check } = this.mapType(c, pt, notes);
        const intType = ['smallint', 'int', 'bigint'].includes(type);
        const identity = intType && (!!c.identity || pt.serial);
        const def = identity ? undefined : this.mapDefault(c, pt, type, notes);
        if (/^GENERATED\s/i.test(c.default ?? '')) notes.push(`${c.name}: generated column expression not converted; created as a plain column`);
        return { col: c, name: c.name, type, nullable: c.nullable && !c.pk, identity, default: def, check, comment: c.comment, notes };
      });
      plans.set(t.id, { table: t, qname: `${this.q(this.schemaName(t))}.${this.q(t.name)}`, cols });
    }
    this.alignFkTypes(plans);
    // Shorten keys to fit index limits; FK columns and the keys they reference must keep identical
    // types, so linked columns share the shorter length. Repeat until nothing changes.
    for (let i = 0; i < 5; i++) {
      this.fitKeySizes(plans);
      if (!this.shareFkLengths(plans)) break;
    }

    const allNotes: string[] = [];
    const indexes: string[] = [];
    const comments: string[] = [];
    for (const { table: t, qname, cols } of plans.values()) {
      const lines = cols.map((c) => {
        const parts = [`    ${this.q(c.name)} ${c.type}`];
        if (c.identity) parts.push('IDENTITY(1,1)');
        parts.push(c.nullable ? 'NULL' : 'NOT NULL');
        if (c.default !== undefined)
          parts.push(`CONSTRAINT ${this.q(this.uniqueName(`DF_${t.name}_${c.name}`))} DEFAULT ${c.default}`);
        if (c.check) parts.push(`CONSTRAINT ${this.q(this.uniqueName(`CK_${t.name}_${c.name}`))} CHECK (${c.check})`);
        allNotes.push(...c.notes.map((n) => `${t.name}.${n}`));
        return parts.join(' ');
      });
      const pk = t.columns.filter((c) => c.pk);
      if (pk.length)
        lines.push(
          `    CONSTRAINT ${this.q(this.uniqueName(t.pkName && t.pkName.length ? t.pkName : `PK_${t.name}`))} PRIMARY KEY (${pk.map((c) => this.q(c.name)).join(', ')})`,
        );
      const referenced = new Set(this.relations.flatMap((r) => r.toColumns));
      for (const c of t.columns) {
        if (!c.unique || c.pk) continue;
        // SQL Server UNIQUE allows a single NULL; PostgreSQL allows many. A filtered index keeps the
        // PostgreSQL behaviour, unless an FK references the column (FKs need a real constraint).
        if (c.nullable && !referenced.has(c.id))
          indexes.push(
            `CREATE UNIQUE INDEX ${this.q(this.uniqueName(`UX_${t.name}_${c.name}`))} ON ${qname} (${this.q(c.name)}) WHERE ${this.q(c.name)} IS NOT NULL;`,
          );
        else lines.push(`    CONSTRAINT ${this.q(this.uniqueName(t.uniqueNames?.[c.id] ?? `UQ_${t.name}_${c.name}`))} UNIQUE (${this.q(c.name)})`);
      }
      for (const u of t.uniques ?? []) {
        const names = u.columns.map((id) => this.colName(t, id));
        if (names.includes('?')) continue;
        lines.push(`    CONSTRAINT ${this.q(this.uniqueName(u.name ?? `UQ_${t.name}_${names.join('_')}`))} UNIQUE (${names.map((n) => this.q(n)).join(', ')})`);
      }
      out.push(`CREATE TABLE ${qname} (`, lines.join(',\n'), ');', '');
      const level = (extra = '') =>
        `@level0type = N'SCHEMA', @level0name = ${this.str(this.schemaName(t))}, @level1type = N'TABLE', @level1name = ${this.str(t.name)}${extra}`;
      if (t.comment) comments.push(`EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${this.str(t.comment)}, ${level()};`);
      for (const c of cols)
        if (c.comment)
          comments.push(
            `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${this.str(c.comment)}, ${level(`, @level2type = N'COLUMN', @level2name = ${this.str(c.name)}`)};`,
          );
    }
    if (indexes.length) out.push('-- Unique columns that allow several NULLs (PostgreSQL semantics)', ...indexes, '');

    const fks = this.foreignKeys(plans, allNotes);
    if (fks.length) out.push('GO', '', '-- Foreign keys', ...fks, '');
    if (comments.length) out.push('GO', '', '-- Descriptions', ...comments, '');
    out.push('GO', '');
    return [...out, ...this.commentLines(allNotes)].join('\n');
  }

  /**
   * SQL Server rejects FKs whose ON DELETE/UPDATE actions could reach a table along two paths or
   * cycle back. Such actions are downgraded to NO ACTION, with a note.
   */
  private foreignKeys(plans: Map<string, TablePlan>, notes: string[]): string[] {
    const out: string[] = [];
    const graphs = { delete: new Map<string, Set<string>>(), update: new Map<string, Set<string>>() };
    const reach = (g: Map<string, Set<string>>, from: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const n = stack.pop()!;
        for (const m of g.get(n) ?? []) if (!seen.has(m)) (seen.add(m), stack.push(m));
      }
      return seen;
    };
    const conflicts = (g: Map<string, Set<string>>, parent: string, child: string): boolean => {
      if (parent === child) return true;
      // Any table that already cascades into `parent` (or parent itself) must not already reach `child`.
      const sources = [parent, ...[...g.keys()].filter((k) => reach(g, k).has(parent))];
      if (sources.some((s) => s === child || reach(g, s).has(child))) return true;
      return reach(g, child).has(parent); // cycle
    };
    for (const r of this.relations) {
      const from = this.byId.get(r.fromTable)!;
      const to = this.byId.get(r.toTable)!;
      const fc = r.fromColumns.map((id) => this.q(this.colName(from, id)));
      const tc = r.toColumns.map((id) => this.q(this.colName(to, id)));
      let onDelete = r.onDelete && r.onDelete !== 'NO ACTION' && r.onDelete !== 'RESTRICT' ? r.onDelete : undefined;
      let onUpdate = r.onUpdate && r.onUpdate !== 'NO ACTION' && r.onUpdate !== 'RESTRICT' ? r.onUpdate : undefined;
      for (const [what, act] of [['DELETE', onDelete], ['UPDATE', onUpdate]] as const) {
        if (act && !this.actionAllowed(r, act, plans)) {
          notes.push(`${from.name} → ${to.name}: ON ${what} ${act} removed (a referencing column is NOT NULL${act === 'SET DEFAULT' ? ' without a default' : ''})`);
          if (what === 'DELETE') onDelete = undefined;
          else onUpdate = undefined;
        }
      }
      if (onDelete && conflicts(graphs.delete, r.toTable, r.fromTable)) {
        notes.push(`${from.name} → ${to.name}: ON DELETE ${onDelete} removed (SQL Server forbids multiple or cyclic cascade paths); enforce it in application code or a trigger`);
        onDelete = undefined;
      }
      if (onUpdate && conflicts(graphs.update, r.toTable, r.fromTable)) {
        notes.push(`${from.name} → ${to.name}: ON UPDATE ${onUpdate} removed (multiple or cyclic cascade paths)`);
        onUpdate = undefined;
      }
      if (onDelete) (graphs.delete.get(r.toTable) ?? graphs.delete.set(r.toTable, new Set()).get(r.toTable)!).add(r.fromTable);
      if (onUpdate) (graphs.update.get(r.toTable) ?? graphs.update.set(r.toTable, new Set()).get(r.toTable)!).add(r.fromTable);
      const name = this.uniqueName(r.name ?? `FK_${from.name}_${r.fromColumns.map((id) => this.colName(from, id)).join('_')}`);
      out.push(
        `ALTER TABLE ${plans.get(from.id)!.qname} ADD CONSTRAINT ${this.q(name)} FOREIGN KEY (${fc.join(', ')}) REFERENCES ${plans.get(to.id)!.qname} (${tc.join(', ')})` +
          `${onDelete ? ` ON DELETE ${onDelete}` : ''}${onUpdate ? ` ON UPDATE ${onUpdate}` : ''};`,
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

class MysqlWriter extends Writer {
  protected dialectName = 'MySQL';
  protected maxNameLength = 64;
  protected q(n: string) {
    return `\`${n.replace(/`/g, '``')}\``;
  }
  private names = new Map<string, string>();
  /** MySQL schemas are separate databases; keep everything in the current one, prefixing the schema only on clashes. */
  private tableName(t: Table): string {
    const known = this.names.get(t.id);
    if (known) return known;
    const clash = this.tables.filter((x) => x.name.toLowerCase() === t.name.toLowerCase()).length > 1;
    const sc = pgSchemaName(t.schema, this.schema.dialect);
    const name = (clash && sc !== 'public' ? `${sc}_${t.name}` : t.name).slice(0, 64);
    this.names.set(t.id, name);
    return name;
  }

  private mapType(c: Column, pt: PgType, notes: string[]): string {
    const key = this.keyCols.has(c.id);
    if (pt.array) {
      notes.push(`${c.name}: ${pt.text}[] stored as JSON`);
      return key ? 'varchar(255)' : 'json';
    }
    switch (pt.kind) {
      case 'smallint':
        return 'smallint';
      case 'integer':
        return 'int';
      case 'bigint':
        return 'bigint';
      case 'numeric': {
        const p = Math.min(pt.precision ?? 65, 65);
        const s = Math.min(pt.scale ?? (pt.precision ? 0 : 30), 30, p);
        if (!pt.precision) notes.push(`${c.name}: unbounded numeric mapped to decimal(65,30)`);
        return `decimal(${p},${s})`;
      }
      case 'real':
        return 'float';
      case 'double':
        return 'double';
      case 'money':
        return 'decimal(19,4)';
      case 'boolean':
        return 'boolean'; // stored as tinyint(1); writing tinyint(1) itself triggers a deprecation warning
      case 'text':
        return key ? 'varchar(255)' : 'text';
      case 'varchar':
        if (key) return `varchar(${Math.min(pt.length ?? 255, 768)})`;
        return pt.length && pt.length <= 16383 ? `varchar(${pt.length})` : 'text';
      case 'char':
        return `char(${Math.min(pt.length ?? 1, 255)})`;
      case 'uuid':
        return 'char(36)';
      case 'date':
        return 'date';
      case 'time':
      case 'timetz':
        if (pt.kind === 'timetz') notes.push(`${c.name}: time with time zone mapped to time (zone dropped)`);
        return `time(${Math.min(pt.precision ?? 6, 6)})`;
      case 'timestamp':
        return `datetime(${Math.min(pt.precision ?? 6, 6)})`;
      case 'timestamptz':
        this.notes.push('timestamptz columns are mapped to datetime(6), which has no time zone: store values in UTC');
        return `datetime(${Math.min(pt.precision ?? 6, 6)})`;
      case 'interval':
        notes.push(`${c.name}: interval stored as varchar(100)`);
        return 'varchar(100)';
      case 'json':
        return key ? 'varchar(255)' : 'json';
      case 'bytea':
        return key ? 'varbinary(255)' : 'longblob';
      case 'inet':
        return 'varchar(45)';
      case 'xml':
        return key ? 'varchar(255)' : 'longtext';
      case 'tsvector':
        notes.push(`${c.name}: tsvector has no equivalent (use a FULLTEXT index); stored as text`);
        return key ? 'varchar(255)' : 'text';
      case 'enum':
        return pt.enumValues?.length ? `enum(${pt.enumValues.map(sqlString).join(', ')})` : 'varchar(255)';
      default:
        notes.push(`${c.name}: type "${pt.text}" has no direct equivalent; stored as text`);
        return key ? 'varchar(255)' : 'text';
    }
  }

  private mapDefault(c: Column, pt: PgType, type: string, notes: string[]): string | undefined {
    const d = canonicalDefault(c, this.schema);
    if (!d) return undefined;
    // TEXT/BLOB/JSON columns only accept expression defaults (MySQL 8.0.13+).
    const needsExpr = /^(text|longtext|json|longblob)$/.test(type);
    const lit = (v: string) => (needsExpr ? `(${v})` : v);
    switch (d.kind) {
      case 'now': {
        if (type === 'date') return '(CURRENT_DATE)';
        if (type.startsWith('time(')) return `(CURRENT_TIME(${/\((\d)\)/.exec(type)?.[1] ?? 0}))`;
        if (!type.startsWith('datetime')) {
          notes.push(`${c.name}: default now() only applies to date/time columns in MySQL; left out`);
          return undefined;
        }
        const p = /\((\d)\)/.exec(type)?.[1];
        return `CURRENT_TIMESTAMP${p ? `(${p})` : ''}`;
      }
      case 'today':
        return '(CURRENT_DATE)';
      case 'uuid':
        return '(UUID())';
      case 'bool':
        return d.value ? '1' : '0';
      case 'number':
        return lit(d.value);
      case 'string':
        return pt.kind === 'boolean' ? (/^(t|true|1|y|yes|on)$/i.test(d.value) ? '1' : '0') : lit(sqlString(d.value));
      case 'null':
        return undefined; // DEFAULT NULL is the implicit default
      case 'emptyArray':
        return `(${sqlString('[]')})`;
      case 'sequence':
        return undefined;
      case 'unsupported':
        notes.push(`${c.name}: default ${d.expr} has no MySQL equivalent and was left out`);
        return undefined;
    }
  }

  write(): string {
    const out = this.header();
    out.push('SET NAMES utf8mb4;', '');
    if (this.tables.some((t) => !['public', ''].includes(pgSchemaName(t.schema, this.schema.dialect))))
      out.push('-- All tables go into the current database (MySQL schemas are separate databases); the schema is prefixed only where names would clash.', '');
    const qn = (t: Table) => this.q(this.tableName(t));
    const plans = new Map<string, TablePlan>();
    for (const t of this.tables) {
      const cols: ColPlan[] = t.columns.map((c) => {
        const notes: string[] = [];
        const pt = canonicalType(c, this.schema);
        const dn = this.domainNote(c);
        if (dn) notes.push(dn);
        const type = this.mapType(c, pt, notes);
        const identity = /^(smallint|int|bigint)$/.test(type) && (!!c.identity || pt.serial);
        const def = identity ? undefined : this.mapDefault(c, pt, type, notes);
        if (/^GENERATED\s/i.test(c.default ?? '')) notes.push(`${c.name}: generated column expression not converted`);
        return { col: c, name: c.name, type, nullable: c.nullable && !c.pk, identity, default: def, comment: c.comment, notes };
      });
      plans.set(t.id, { table: t, qname: qn(t), cols });
    }
    this.alignFkTypes(plans);

    const allNotes: string[] = [];
    // InnoDB rows are limited to 65,535 bytes of varchar/char (utf8mb4 = 4 bytes per character):
    // move the widest non-key columns to TEXT until the table fits.
    for (const { table: t, cols } of plans.values()) {
      const width = (c: ColPlan) => {
        const m = /^(var)?char\((\d+)\)$/.exec(c.type);
        return m ? Number(m[2]) * 4 + 2 : 0;
      };
      let total = cols.reduce((a, c) => a + width(c), 0);
      while (total > 60000) {
        const widest = cols.filter((c) => !this.keyCols.has(c.col.id) && width(c) > 0).sort((a, b) => width(b) - width(a))[0];
        if (!widest) break;
        total -= width(widest);
        widest.notes.push(`${widest.name}: ${widest.type} changed to text to fit MySQL's 65,535-byte row limit`);
        widest.type = 'text';
        if (widest.default && !widest.default.startsWith('(')) widest.default = `(${widest.default})`;
      }
      void t;
    }
    for (const { table: t, qname, cols } of plans.values()) {
      const lines = cols.map((c) => {
        const parts = [`    ${this.q(c.name)} ${c.type}`, c.nullable ? 'NULL' : 'NOT NULL'];
        if (c.identity) parts.push('AUTO_INCREMENT');
        if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
        if (c.comment) parts.push(`COMMENT ${sqlString(c.comment.slice(0, 1024))}`);
        allNotes.push(...c.notes.map((n) => `${t.name}.${n}`));
        return parts.join(' ');
      });
      const pk = t.columns.filter((c) => c.pk);
      if (pk.length) lines.push(`    PRIMARY KEY (${pk.map((c) => this.q(c.name)).join(', ')})`);
      for (const c of t.columns) {
        const ident = cols.find((x) => x.col === c)!.identity;
        if ((c.unique || ident) && !c.pk) lines.push(`    UNIQUE KEY ${this.q(this.uniqueName(t.uniqueNames?.[c.id] ?? `uq_${t.name}_${c.name}`))} (${this.q(c.name)})`);
      }
      for (const u of t.uniques ?? []) {
        const names = u.columns.map((id) => this.colName(t, id));
        if (!names.includes('?')) lines.push(`    UNIQUE KEY ${this.q(this.uniqueName(u.name ?? `uq_${t.name}_${names.join('_')}`))} (${names.map((n) => this.q(n)).join(', ')})`);
      }
      const tcomment = t.comment ? ` COMMENT=${sqlString(t.comment.slice(0, 2048))}` : '';
      out.push(`CREATE TABLE ${qname} (`, lines.join(',\n'), `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4${tcomment};`, '');
    }

    const fks: string[] = [];
    for (const r of this.relations) {
      const from = this.byId.get(r.fromTable)!;
      const to = this.byId.get(r.toTable)!;
      const action = (a: string | undefined, what: string) => {
        if (!a || a === 'NO ACTION') return '';
        if (a === 'SET DEFAULT') {
          allNotes.push(`${from.name} → ${to.name}: ON ${what} SET DEFAULT is not supported by InnoDB; using NO ACTION`);
          return '';
        }
        if (!this.actionAllowed(r, a, plans)) {
          allNotes.push(`${from.name} → ${to.name}: ON ${what} ${a} removed (a referencing column is NOT NULL)`);
          return '';
        }
        return ` ON ${what} ${a}`;
      };
      const name = this.uniqueName(r.name ?? `fk_${from.name}_${r.fromColumns.map((id) => this.colName(from, id)).join('_')}`);
      fks.push(
        `ALTER TABLE ${plans.get(from.id)!.qname} ADD CONSTRAINT ${this.q(name)} FOREIGN KEY (${r.fromColumns.map((id) => this.q(this.colName(from, id))).join(', ')}) ` +
          `REFERENCES ${plans.get(to.id)!.qname} (${r.toColumns.map((id) => this.q(this.colName(to, id))).join(', ')})${action(r.onDelete, 'DELETE')}${action(r.onUpdate, 'UPDATE')};`,
      );
    }
    if (fks.length) out.push('-- Foreign keys', ...fks, '');
    return [...out, ...this.commentLines([...new Set(this.notes), ...allNotes])].join('\n');
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

class SqliteWriter extends Writer {
  protected dialectName = 'SQLite';
  protected maxNameLength = 1000;
  private names = new Map<string, string>();
  protected q(n: string) {
    return `"${n.replace(/"/g, '""')}"`;
  }

  /** SQLite has no schemas: keep table names, prefixing the schema only where names would collide. */
  private tableName(t: Table): string {
    const known = this.names.get(t.id);
    if (known) return known;
    const clash = this.tables.filter((x) => x.name.toLowerCase() === t.name.toLowerCase()).length > 1;
    const s = pgSchemaName(t.schema, this.schema.dialect);
    const name = clash && s !== 'public' ? `${s}_${t.name}` : t.name;
    this.names.set(t.id, name);
    return name;
  }

  private mapType(pt: PgType, c: Column, notes: string[]): { type: string; check?: string } {
    if (pt.array) return { type: 'TEXT', check: `json_valid(${this.q(c.name)})` };
    switch (pt.kind) {
      case 'smallint':
      case 'integer':
      case 'bigint':
        return { type: 'INTEGER' };
      case 'boolean':
        return { type: 'INTEGER', check: `${this.q(c.name)} IN (0, 1)` };
      case 'numeric':
      case 'money':
        return { type: pt.precision ? `NUMERIC(${pt.precision},${pt.scale ?? 0})` : 'NUMERIC' };
      case 'real':
      case 'double':
        return { type: 'REAL' };
      case 'bytea':
        return { type: 'BLOB' };
      case 'varchar':
        return { type: pt.length ? `VARCHAR(${pt.length})` : 'TEXT' };
      case 'char':
        return { type: `CHAR(${pt.length ?? 1})` };
      case 'date':
      case 'time':
      case 'timetz':
      case 'timestamp':
      case 'timestamptz':
        // SQLite stores dates as ISO-8601 text; keep the declared type so tools can still tell.
        return { type: { date: 'DATE', time: 'TIME', timetz: 'TIME', timestamp: 'DATETIME', timestamptz: 'DATETIME' }[pt.kind] };
      case 'json':
        return { type: 'TEXT', check: `${this.q(c.name)} IS NULL OR json_valid(${this.q(c.name)})` };
      case 'enum':
        return { type: 'TEXT', check: pt.enumValues?.length ? `${this.q(c.name)} IN (${pt.enumValues.map(sqlString).join(', ')})` : undefined };
      case 'tsvector':
        notes.push(`${c.name}: tsvector has no equivalent (use FTS5); stored as TEXT`);
        return { type: 'TEXT' };
      default:
        return { type: 'TEXT' };
    }
  }

  private mapDefault(c: Column, pt: PgType, notes: string[]): string | undefined {
    const d = canonicalDefault(c, this.schema);
    if (!d) return undefined;
    switch (d.kind) {
      case 'now':
        return pt.kind === 'date' ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP';
      case 'today':
        return 'CURRENT_DATE';
      case 'uuid':
        // RFC 4122 v4 layout from random bytes.
        return "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))";
      case 'bool':
        return d.value ? '1' : '0';
      case 'number':
        return d.value;
      case 'string':
        return pt.kind === 'boolean' ? (/^(t|true|1|y|yes|on)$/i.test(d.value) ? '1' : '0') : sqlString(d.value);
      case 'null':
        return undefined; // DEFAULT NULL is the implicit default
      case 'emptyArray':
        return sqlString('[]');
      case 'sequence':
        return undefined;
      case 'unsupported':
        notes.push(`${c.name}: default ${d.expr} has no SQLite equivalent and was left out`);
        return undefined;
    }
  }

  write(): string {
    const out = this.header();
    out.push('PRAGMA foreign_keys = ON;', '');
    const allNotes: string[] = [];
    const flattened = this.tables.some((t) => !['public', ''].includes(pgSchemaName(t.schema, this.schema.dialect)));
    if (flattened) out.push('-- SQLite has no schemas: tables keep their names (the schema is prefixed only where names would clash).', '');
    for (const t of this.tables) {
      const pk = t.columns.filter((c) => c.pk);
      const lines: string[] = [];
      for (const c of t.columns) {
        const notes: string[] = [];
        const pt = canonicalType(c, this.schema);
        const dn = this.domainNote(c);
        if (dn) notes.push(dn);
        const { type, check } = this.mapType(pt, c, notes);
        const parts = [`    ${this.q(c.name)} ${type}`];
        // Only "INTEGER PRIMARY KEY" aliases the rowid and can AUTOINCREMENT.
        const rowid = pk.length === 1 && c.pk && type === 'INTEGER';
        if (rowid) parts.push(c.identity || pt.serial ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY');
        if (!c.nullable || c.pk) parts.push('NOT NULL');
        const def = rowid && (c.identity || pt.serial) ? undefined : this.mapDefault(c, pt, notes);
        if (def !== undefined) parts.push(`DEFAULT ${/^[-+]?\d|^'|^NULL$|^CURRENT_/.test(def) ? def : def.startsWith('(') ? def : `(${def})`}`);
        if (check) parts.push(`CHECK (${check})`);
        if (/^GENERATED\s/i.test(c.default ?? '')) notes.push(`${c.name}: generated column expression not converted`);
        if (c.comment) lines.push(`    -- ${c.comment.replace(/\s+/g, ' ')}`);
        lines.push(parts.join(' ') + ',');
        allNotes.push(...notes.map((n) => `${t.name}.${n}`));
      }
      const constraints: string[] = [];
      if (pk.length && !(pk.length === 1 && canonicalType(pk[0], this.schema).kind.match(/^(smallint|integer|bigint)$/) && !canonicalType(pk[0], this.schema).array))
        constraints.push(`    PRIMARY KEY (${pk.map((c) => this.q(c.name)).join(', ')})`);
      for (const c of t.columns) if (c.unique && !c.pk) constraints.push(`    UNIQUE (${this.q(c.name)})`);
      for (const u of t.uniques ?? []) {
        const names = u.columns.map((id) => this.colName(t, id));
        if (!names.includes('?')) constraints.push(`    UNIQUE (${names.map((n) => this.q(n)).join(', ')})`);
      }
      for (const r of this.relations.filter((x) => x.fromTable === t.id)) {
        const to = this.byId.get(r.toTable)!;
        const act = (a: string | undefined, w: string) => (a && a !== 'NO ACTION' ? ` ON ${w} ${a}` : '');
        constraints.push(
          `    FOREIGN KEY (${r.fromColumns.map((id) => this.q(this.colName(t, id))).join(', ')}) REFERENCES ${this.q(this.tableName(to))} (${r.toColumns
            .map((id) => this.q(this.colName(to, id)))
            .join(', ')})${act(r.onDelete, 'DELETE')}${act(r.onUpdate, 'UPDATE')}`,
        );
      }
      // Drop the trailing comma of the last column when there are no table constraints.
      if (!constraints.length) {
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].trimStart().startsWith('--')) {
            lines[i] = lines[i].replace(/,$/, '');
            break;
          }
        }
      }
      if (t.comment) out.push(`-- ${t.comment.replace(/\s+/g, ' ')}`);
      out.push(`CREATE TABLE ${this.q(this.tableName(t))} (`, [...lines, constraints.join(',\n')].filter(Boolean).join('\n'), ');', '');
    }
    return [...out, ...this.commentLines(allNotes)].join('\n');
  }
}
