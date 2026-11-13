// Live database introspection. Each driver returns rows in a common shape which
// `buildSchema` turns into the shared Schema model.

import { Column, Dialect, FkAction, Relation, Schema, Table, UserType } from '../shared/model';

export type DbKind = 'postgres' | 'mssql' | 'mysql' | 'sqlite';

export interface ConnectionInfo {
  name: string;
  kind: DbKind;
  /** Connection string / URL, or a file path for SQLite. */
  connection: string;
}

export interface ColumnRow {
  schema: string;
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  identity?: boolean;
  comment?: string | null;
}

export interface ConstraintRow {
  schema: string;
  table: string;
  name?: string;
  kind: 'p' | 'u' | 'f';
  columns: string[];
  refSchema?: string;
  refTable?: string;
  refColumns?: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
}

export interface TableCommentRow {
  schema: string;
  table: string;
  comment: string | null;
}

export interface IntrospectionRows {
  columns: ColumnRow[];
  constraints: ConstraintRow[];
  tableComments?: TableCommentRow[];
  types?: UserType[];
}

export function buildSchema(dialect: Dialect, rows: IntrospectionRows): Schema {
  const tables = new Map<string, Table>();
  const key = (s: string, t: string) => `${s}.${t}`.toLowerCase();
  for (const r of rows.columns) {
    const k = key(r.schema, r.table);
    let t = tables.get(k);
    if (!t) {
      t = { id: `t:${k}`, schema: r.schema, name: r.table, columns: [] };
      tables.set(k, t);
    }
    const col: Column = {
      id: `${t.id}:${r.column.toLowerCase()}`,
      name: r.column,
      type: r.type,
      nullable: r.nullable,
      pk: false,
      unique: false,
      default: r.default ?? undefined,
      identity: r.identity || undefined,
      comment: r.comment ?? undefined,
    };
    t.columns.push(col);
  }
  for (const c of rows.tableComments ?? []) {
    const t = tables.get(key(c.schema, c.table));
    if (t && c.comment) t.comment = c.comment;
  }
  const colOf = (t: Table, name: string) => t.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const relations: Relation[] = [];
  for (const con of rows.constraints) {
    const t = tables.get(key(con.schema, con.table));
    if (!t) continue;
    const cols = con.columns.map((n) => colOf(t, n));
    if (cols.some((c) => !c)) continue;
    if (con.kind === 'p') {
      for (const c of cols) {
        c!.pk = true;
        c!.nullable = false;
      }
      if (con.name) t.pkName = con.name;
    } else if (con.kind === 'u') {
      if (cols.length === 1) {
        cols[0]!.unique = true;
        if (con.name) (t.uniqueNames ??= {})[cols[0]!.id] = con.name;
      } else (t.uniques ??= []).push({ name: con.name, columns: cols.map((c) => c!.id) });
    } else if (con.kind === 'f' && con.refTable) {
      const rt = tables.get(key(con.refSchema ?? con.schema, con.refTable));
      if (!rt) continue;
      const rcols = (con.refColumns ?? []).map((n) => colOf(rt, n));
      if (rcols.length !== cols.length || rcols.some((c) => !c)) continue;
      relations.push({
        id: `r:${t.id}>${cols.map((c) => c!.name.toLowerCase()).join(',')}${con.name ? '|' + con.name : ''}`,
        name: con.name,
        fromTable: t.id,
        fromColumns: cols.map((c) => c!.id),
        toTable: rt.id,
        toColumns: rcols.map((c) => c!.id),
        onDelete: con.onDelete,
        onUpdate: con.onUpdate,
      });
    }
  }
  return { dialect, tables: [...tables.values()], relations, ...(rows.types?.length ? { types: rows.types } : {}) };
}

export function normalizeAction(a: string | null | undefined): FkAction | undefined {
  if (!a) return undefined;
  const s = a.toUpperCase().replace(/_/g, ' ').trim();
  switch (s) {
    case 'A':
    case 'NO ACTION':
      return 'NO ACTION';
    case 'R':
    case 'RESTRICT':
      return 'RESTRICT';
    case 'C':
    case 'CASCADE':
      return 'CASCADE';
    case 'N':
    case 'SET NULL':
      return 'SET NULL';
    case 'D':
    case 'SET DEFAULT':
      return 'SET DEFAULT';
  }
  return undefined;
}

export async function introspect(info: ConnectionInfo): Promise<Schema> {
  switch (info.kind) {
    case 'postgres':
      return buildSchema('postgres', await (await import('./postgres')).introspectPostgres(info.connection));
    case 'mssql':
      return buildSchema('mssql', await (await import('./mssql')).introspectMssql(info.connection));
    case 'mysql':
      return buildSchema('mysql', await (await import('./mysql')).introspectMysql(info.connection));
    case 'sqlite':
      return buildSchema('sqlite', await (await import('./sqlite')).introspectSqlite(info.connection));
  }
}
