// A small, JSON-friendly language of schema edits. Used by the AI normalisation assistant
// (model output) and by the agent tools, and applied to the working schema as one undoable step.

import { Column, FkAction, Relation, Schema, Table, newId } from './model';

export interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  primary_key?: boolean;
  unique?: boolean;
  default?: string;
}

export type SchemaOp =
  | { op: 'add_table'; table: string; columns: ColumnSpec[]; comment?: string }
  | { op: 'drop_table'; table: string }
  | { op: 'rename_table'; table: string; new_name: string }
  | { op: 'add_column'; table: string; column: ColumnSpec }
  | { op: 'drop_column'; table: string; column: string }
  | { op: 'rename_column'; table: string; column: string; new_name: string }
  | {
      op: 'alter_column';
      table: string;
      column: string;
      type?: string;
      nullable?: boolean;
      unique?: boolean;
      default?: string | null;
    }
  | { op: 'set_primary_key'; table: string; columns: string[] }
  | {
      op: 'add_foreign_key';
      table: string;
      columns: string[];
      ref_table: string;
      ref_columns: string[];
      on_delete?: FkAction;
      on_update?: FkAction;
    }
  | { op: 'drop_foreign_key'; table: string; columns: string[] };

export const OP_KINDS = [
  'add_table',
  'drop_table',
  'rename_table',
  'add_column',
  'drop_column',
  'rename_column',
  'alter_column',
  'set_primary_key',
  'add_foreign_key',
  'drop_foreign_key',
] as const;

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

function splitName(name: string): { schema?: string; name: string } {
  const parts = name.replace(/"/g, '').split('.');
  return parts.length >= 2 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { name: parts[0] };
}

export function findTable(s: Schema, ref: string): Table | undefined {
  const { schema, name } = splitName(ref);
  const nm = name.toLowerCase();
  if (schema !== undefined) return s.tables.find((t) => t.name.toLowerCase() === nm && t.schema.toLowerCase() === schema.toLowerCase());
  const hits = s.tables.filter((t) => t.name.toLowerCase() === nm);
  if (hits.length <= 1) return hits[0];
  return hits.find((t) => ['public', 'dbo', ''].includes(t.schema)) ?? hits[0];
}

function findCol(t: Table, name: string): Column | undefined {
  const nm = name.replace(/"/g, '').toLowerCase();
  return t.columns.find((c) => c.name.toLowerCase() === nm);
}

function makeColumn(spec: ColumnSpec): Column {
  const pk = !!spec.primary_key;
  return {
    id: newId('c'),
    name: spec.name,
    type: spec.type || 'text',
    nullable: pk ? false : spec.nullable !== false,
    pk,
    unique: !!spec.unique,
    default: spec.default ?? undefined,
    identity: /^(big|small)?serial$/i.test(spec.type) || undefined,
  };
}

/** Human-readable one-liner for an operation. */
export function describeOp(op: SchemaOp): string {
  switch (op.op) {
    case 'add_table':
      return `Create table ${op.table} (${op.columns.map((c) => `${c.name} ${c.type}${c.primary_key ? ' PK' : ''}`).join(', ')})`;
    case 'drop_table':
      return `Drop table ${op.table}`;
    case 'rename_table':
      return `Rename table ${op.table} → ${op.new_name}`;
    case 'add_column':
      return `Add column ${op.table}.${op.column.name} ${op.column.type}${op.column.nullable === false ? ' NOT NULL' : ''}`;
    case 'drop_column':
      return `Drop column ${op.table}.${op.column}`;
    case 'rename_column':
      return `Rename column ${op.table}.${op.column} → ${op.new_name}`;
    case 'alter_column': {
      const bits = [
        op.type ? `type ${op.type}` : '',
        op.nullable === true ? 'nullable' : op.nullable === false ? 'NOT NULL' : '',
        op.unique === true ? 'unique' : op.unique === false ? 'not unique' : '',
        op.default === null ? 'drop default' : op.default ? `default ${op.default}` : '',
      ].filter(Boolean);
      return `Alter ${op.table}.${op.column}: ${bits.join(', ') || 'no change'}`;
    }
    case 'set_primary_key':
      return `Primary key of ${op.table} → (${op.columns.join(', ')})`;
    case 'add_foreign_key':
      return `FK ${op.table}(${op.columns.join(', ')}) → ${op.ref_table}(${op.ref_columns.join(', ')})${op.on_delete ? ` ON DELETE ${op.on_delete}` : ''}${op.on_update ? ` ON UPDATE ${op.on_update}` : ''}`;
    case 'drop_foreign_key':
      return `Drop FK on ${op.table}(${op.columns.join(', ')})`;
  }
}

/** Apply operations in order to `s` (mutated in place). Returns one message per op that could not be applied. */
export function applyOps(s: Schema, ops: SchemaOp[], defaultSchema = 'public'): string[] {
  const errors: string[] = [];
  const need = (ref: string, i: number): Table | undefined => {
    const t = findTable(s, ref);
    if (!t) errors.push(`#${i + 1}: table "${ref}" not found`);
    return t;
  };
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case 'add_table': {
          if (findTable(s, op.table)) {
            errors.push(`#${i + 1}: table "${op.table}" already exists`);
            return;
          }
          const { schema, name } = splitName(op.table);
          const t: Table = {
            id: newId('t'),
            schema: schema ?? defaultSchema,
            name,
            columns: (op.columns ?? []).map(makeColumn),
            comment: op.comment || undefined,
          };
          s.tables.push(t);
          return;
        }
        case 'drop_table': {
          const t = need(op.table, i);
          if (!t) return;
          s.tables = s.tables.filter((x) => x !== t);
          s.relations = s.relations.filter((r) => r.fromTable !== t.id && r.toTable !== t.id);
          return;
        }
        case 'rename_table': {
          const t = need(op.table, i);
          if (t) t.name = splitName(op.new_name).name;
          return;
        }
        case 'add_column': {
          const t = need(op.table, i);
          if (!t) return;
          if (findCol(t, op.column.name)) {
            errors.push(`#${i + 1}: column ${t.name}.${op.column.name} already exists`);
            return;
          }
          const c = makeColumn(op.column);
          if (c.pk) for (const x of t.columns) x.pk = false;
          t.columns.push(c);
          return;
        }
        case 'drop_column': {
          const t = need(op.table, i);
          const c = t && findCol(t, op.column);
          if (!t) return;
          if (!c) {
            errors.push(`#${i + 1}: column ${t.name}.${op.column} not found`);
            return;
          }
          t.columns = t.columns.filter((x) => x !== c);
          s.relations = s.relations.filter((r) => !r.fromColumns.includes(c.id) && !r.toColumns.includes(c.id));
          return;
        }
        case 'rename_column': {
          const t = need(op.table, i);
          const c = t && findCol(t, op.column);
          if (t && !c) errors.push(`#${i + 1}: column ${t.name}.${op.column} not found`);
          if (c) c.name = op.new_name;
          return;
        }
        case 'alter_column': {
          const t = need(op.table, i);
          const c = t && findCol(t, op.column);
          if (t && !c) errors.push(`#${i + 1}: column ${t.name}.${op.column} not found`);
          if (!c) return;
          if (op.type) c.type = op.type;
          if (op.nullable !== undefined && op.nullable !== null) c.nullable = c.pk ? false : op.nullable;
          if (op.unique !== undefined && op.unique !== null) c.unique = op.unique;
          if (op.default === null) c.default = undefined;
          else if (op.default) c.default = op.default;
          return;
        }
        case 'set_primary_key': {
          const t = need(op.table, i);
          if (!t) return;
          const cols = op.columns.map((n) => findCol(t, n));
          if (cols.some((c) => !c)) {
            errors.push(`#${i + 1}: unknown column in primary key of ${t.name}`);
            return;
          }
          for (const c of t.columns) c.pk = false;
          for (const c of cols) {
            c!.pk = true;
            c!.nullable = false;
          }
          t.pkName = undefined;
          return;
        }
        case 'add_foreign_key': {
          const t = need(op.table, i);
          const rt = need(op.ref_table, i);
          if (!t || !rt) return;
          const from = op.columns.map((n) => findCol(t, n));
          const refCols = op.ref_columns?.length ? op.ref_columns : rt.columns.filter((c) => c.pk).map((c) => c.name);
          const to = refCols.map((n) => findCol(rt, n));
          if (from.some((c) => !c) || to.some((c) => !c) || from.length !== to.length || !from.length) {
            errors.push(`#${i + 1}: FK ${t.name}(${op.columns.join(', ')}) → ${rt.name}(${refCols.join(', ')}) has unknown or mismatched columns`);
            return;
          }
          // Referenced columns must be a key; make a single referenced column unique if it isn't.
          if (to.length === 1 && !to[0]!.pk && !to[0]!.unique) to[0]!.unique = true;
          s.relations = s.relations.filter(
            (r) => !(r.fromTable === t.id && r.fromColumns.length === from.length && r.fromColumns.every((id, k) => id === from[k]!.id)),
          );
          const rel: Relation = {
            id: newId('r'),
            fromTable: t.id,
            fromColumns: from.map((c) => c!.id),
            toTable: rt.id,
            toColumns: to.map((c) => c!.id),
            onDelete: op.on_delete && FK_ACTIONS.includes(op.on_delete) && op.on_delete !== 'NO ACTION' ? op.on_delete : undefined,
            onUpdate: op.on_update && FK_ACTIONS.includes(op.on_update) && op.on_update !== 'NO ACTION' ? op.on_update : undefined,
          };
          s.relations.push(rel);
          return;
        }
        case 'drop_foreign_key': {
          const t = need(op.table, i);
          if (!t) return;
          const ids = op.columns.map((n) => findCol(t, n)?.id);
          const before = s.relations.length;
          s.relations = s.relations.filter(
            (r) => !(r.fromTable === t.id && r.fromColumns.length === ids.length && r.fromColumns.every((id, k) => id === ids[k])),
          );
          if (s.relations.length === before) errors.push(`#${i + 1}: no FK on ${t.name}(${op.columns.join(', ')})`);
          return;
        }
        default:
          errors.push(`#${i + 1}: unknown operation ${(op as { op: string }).op}`);
      }
    } catch (e) {
      errors.push(`#${i + 1}: ${(e as Error).message}`);
    }
  });
  return errors;
}

/** Key aliases models commonly use instead of the documented names. */
const KEY_ALIASES: Record<string, string> = {
  type: 'op',
  operation: 'op',
  action: 'op',
  kind: 'op',
  table_name: 'table',
  tablename: 'table',
  target_table: 'table',
  column_name: 'column',
  columnname: 'column',
  newname: 'new_name',
  rename_to: 'new_name',
  to: 'new_name',
  data_type: 'type_',
  datatype: 'type_',
  column_type: 'type_',
  references_table: 'ref_table',
  referenced_table: 'ref_table',
  reftable: 'ref_table',
  references: 'ref_table',
  references_columns: 'ref_columns',
  referenced_columns: 'ref_columns',
  refcolumns: 'ref_columns',
  referenced_column: 'ref_columns',
  ref_column: 'ref_columns',
  columns_def: 'column_defs',
  columndefs: 'column_defs',
  definitions: 'column_defs',
  ondelete: 'on_delete',
  onupdate: 'on_update',
  primarykey: 'primary_key',
  is_nullable: 'nullable',
  not_null: 'not_null',
};

/** Accept {"add_column": {...}} wrappers, camelCase / alias keys and "type" used for the op name. */
function normaliseKeys(raw: Record<string, unknown>): Record<string, unknown> {
  let o = raw;
  const keys = Object.keys(o);
  if (keys.length === 1 && (OP_KINDS as readonly string[]).includes(keys[0].toLowerCase()) && o[keys[0]] && typeof o[keys[0]] === 'object')
    o = { op: keys[0], ...(o[keys[0]] as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const snake = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const mapped = KEY_ALIASES[snake] ?? KEY_ALIASES[snake.replace(/_/g, '')] ?? snake;
    if (mapped === 'op' && !(OP_KINDS as readonly string[]).includes(String(v).toLowerCase().replace(/[\s-]+/g, '_'))) {
      // "type" that is a data type, not an operation name
      out.type = v;
      continue;
    }
    if (mapped === 'type_') out.type = v;
    else if (mapped === 'not_null') out.nullable = v === true ? false : v === false ? true : v;
    else if (!(mapped in out)) out[mapped] = v;
  }
  if (typeof out.ref_columns === 'string') out.ref_columns = [out.ref_columns];
  if (typeof out.columns === 'string') out.columns = [out.columns];
  return out;
}

/** Validate and normalise loosely-typed operations coming from a model or tool call. */
export function sanitizeOps(raw: unknown): { ops: SchemaOp[]; problems: string[] } {
  const ops: SchemaOp[] = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { ops, problems: ['operations must be an array'] };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  const colSpec = (v: unknown): ColumnSpec | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    const name = str(o.name);
    if (!name) return undefined;
    return {
      name,
      type: str(o.type) ?? 'text',
      nullable: bool(o.nullable),
      primary_key: bool(o.primary_key),
      unique: bool(o.unique),
      default: str(o.default),
    };
  };
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object') return problems.push(`#${i + 1}: not an object`);
    const o = normaliseKeys(r as Record<string, unknown>);
    const kind = str(o.op)?.toLowerCase().replace(/[\s-]+/g, '_');
    const table = str(o.table);
    if (!kind || !(OP_KINDS as readonly string[]).includes(kind)) return problems.push(`#${i + 1}: unknown op "${o.op}"`);
    if (!table) return problems.push(`#${i + 1}: missing table`);
    const column = str(o.column) ?? colSpec(o.column)?.name;
    switch (kind) {
      case 'add_table': {
        const cols = (Array.isArray(o.column_defs) ? o.column_defs : Array.isArray(o.columns) ? o.columns : [])
          .map(colSpec)
          .filter((x): x is ColumnSpec => !!x);
        if (!cols.length) return problems.push(`#${i + 1}: add_table needs column definitions`);
        return ops.push({ op: 'add_table', table, columns: cols, comment: str(o.comment) });
      }
      case 'drop_table':
        return ops.push({ op: 'drop_table', table });
      case 'rename_table': {
        const nn = str(o.new_name);
        return nn ? ops.push({ op: 'rename_table', table, new_name: nn }) : problems.push(`#${i + 1}: missing new_name`);
      }
      case 'add_column': {
        const spec =
          colSpec(o.column) ??
          colSpec(Array.isArray(o.column_defs) ? o.column_defs[0] : undefined) ??
          (column ? colSpec({ ...o, name: column }) : undefined);
        return spec ? ops.push({ op: 'add_column', table, column: spec }) : problems.push(`#${i + 1}: add_column needs a column definition`);
      }
      case 'drop_column':
        return column ? ops.push({ op: 'drop_column', table, column }) : problems.push(`#${i + 1}: missing column`);
      case 'rename_column': {
        const nn = str(o.new_name);
        return column && nn ? ops.push({ op: 'rename_column', table, column, new_name: nn }) : problems.push(`#${i + 1}: missing column/new_name`);
      }
      case 'alter_column':
        return column
          ? ops.push({
              op: 'alter_column',
              table,
              column,
              type: str(o.type),
              nullable: bool(o.nullable),
              unique: bool(o.unique),
              default: o.default === null ? null : str(o.default),
            })
          : problems.push(`#${i + 1}: missing column`);
      case 'set_primary_key': {
        const cols = strs(o.columns);
        return cols.length ? ops.push({ op: 'set_primary_key', table, columns: cols }) : problems.push(`#${i + 1}: missing columns`);
      }
      case 'add_foreign_key': {
        const cols = strs(o.columns).length ? strs(o.columns) : column ? [column] : [];
        const refTable = str(o.ref_table);
        const onDelete = str(o.on_delete)?.toUpperCase().replace(/_/g, ' ') as FkAction | undefined;
        const onUpdate = str(o.on_update)?.toUpperCase().replace(/_/g, ' ') as FkAction | undefined;
        return cols.length && refTable
          ? ops.push({
              op: 'add_foreign_key',
              table,
              columns: cols,
              ref_table: refTable,
              ref_columns: strs(o.ref_columns),
              on_delete: onDelete && FK_ACTIONS.includes(onDelete) ? onDelete : undefined,
              on_update: onUpdate && FK_ACTIONS.includes(onUpdate) ? onUpdate : undefined,
            })
          : problems.push(`#${i + 1}: add_foreign_key needs columns and ref_table`);
      }
      case 'drop_foreign_key': {
        const cols = strs(o.columns).length ? strs(o.columns) : column ? [column] : [];
        return cols.length ? ops.push({ op: 'drop_foreign_key', table, columns: cols }) : problems.push(`#${i + 1}: missing columns`);
      }
    }
  });
  return { ops, problems };
}

/** JSON Schema for one operation (flat object, works with structured-output engines). */
export const OPERATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'table'],
  properties: {
    op: { type: 'string', enum: [...OP_KINDS] },
    table: { type: 'string', description: 'Target table, schema-qualified when not in the default schema (e.g. "app.users").' },
    column: { type: 'string', description: 'Column name for column-level operations.' },
    new_name: { type: 'string', description: 'For rename_table / rename_column.' },
    type: { type: 'string', description: 'Data type for add_column / alter_column.' },
    nullable: { type: 'boolean' },
    unique: { type: 'boolean' },
    primary_key: { type: 'boolean' },
    default: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' }, description: 'Column names for set_primary_key / add_foreign_key / drop_foreign_key.' },
    ref_table: { type: 'string' },
    ref_columns: { type: 'array', items: { type: 'string' } },
    on_delete: { type: 'string', enum: FK_ACTIONS },
    on_update: { type: 'string', enum: FK_ACTIONS },
    column_defs: {
      type: 'array',
      description: 'Column definitions for add_table (and add_column, one entry).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          nullable: { type: 'boolean' },
          primary_key: { type: 'boolean' },
          unique: { type: 'boolean' },
          default: { type: 'string' },
        },
      },
    },
    comment: { type: 'string' },
  },
} as const;
