import { Client } from 'pg';
import { IntrospectionRows, normalizeAction } from './index';

const SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

const COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
       format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable,
       pg_get_expr(d.adbin, d.adrelid) AS default,
       (a.attidentity <> '') AS identity,
       a.attgenerated AS generated,
       col_description(c.oid, a.attnum) AS comment
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND NOT c.relispartition AND ${SYSTEM}
ORDER BY n.nspname, c.relname, a.attnum`;

const CONSTRAINTS_SQL = `
SELECT con.conname AS name, con.contype AS kind, n.nspname AS schema, c.relname AS table,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
       fn.nspname AS ref_schema, fc.relname AS ref_table,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns,
       con.confdeltype AS on_delete, con.confupdtype AS on_update
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype IN ('p', 'u', 'f') AND ${SYSTEM}`;

const TABLE_COMMENTS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND ${SYSTEM} AND obj_description(c.oid, 'pg_class') IS NOT NULL`;

const ENUMS_SQL = `
SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE ${SYSTEM}
GROUP BY n.nspname, t.typname`;

const DOMAINS_SQL = `
SELECT n.nspname AS schema, t.typname AS name, format_type(t.typbasetype, t.typtypmod) AS base,
       t.typnotnull AS notnull, t.typdefault AS def,
       (SELECT string_agg(pg_get_constraintdef(c.oid), ' ') FROM pg_constraint c WHERE c.contypid = t.oid) AS checks
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'd' AND ${SYSTEM}`;

export async function introspectPostgres(connectionString: string): Promise<IntrospectionRows> {
  // Read-only by construction: the session defaults to read-only transactions, everything runs in an
  // explicit READ ONLY transaction, and we verify the server agrees before reading the catalog.
  const client = new Client({ connectionString, connectionTimeoutMillis: 15000, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const ro = await client.query('SHOW transaction_read_only');
    if (ro.rows[0]?.transaction_read_only !== 'on') throw new Error('Could not open a read-only transaction; refusing to continue.');
    const cols = await client.query(COLUMNS_SQL);
    const cons = await client.query(CONSTRAINTS_SQL);
    const comments = await client.query(TABLE_COMMENTS_SQL);
    const enums = await client.query(ENUMS_SQL);
    const domains = await client.query(DOMAINS_SQL);
    await client.query('ROLLBACK');
    return {
      types: [
        ...enums.rows.map((r) => ({ schema: r.schema, name: r.name, kind: 'enum' as const, values: r.values ?? [] })),
        ...domains.rows.map((r) => ({
          schema: r.schema,
          name: r.name,
          kind: 'domain' as const,
          definition: [`AS ${r.base}`, r.def ? `DEFAULT ${r.def}` : '', r.notnull ? 'NOT NULL' : '', r.checks ?? ''].filter(Boolean).join(' '),
        })),
      ],
      columns: cols.rows.map((r) => ({
        schema: r.schema,
        table: r.table,
        column: r.column,
        type: shortPgType(r.type),
        nullable: r.nullable,
        default:
          r.generated === 's' || r.generated === 'v'
            ? `GENERATED ALWAYS AS (${r.default}) ${r.generated === 'v' ? 'VIRTUAL' : 'STORED'}`
            : r.default,
        identity: r.identity,
        comment: r.comment,
      })),
      constraints: cons.rows.map((r) => ({
        schema: r.schema,
        table: r.table,
        name: r.name,
        kind: r.kind,
        columns: r.columns ?? [],
        refSchema: r.ref_schema ?? undefined,
        refTable: r.ref_table ?? undefined,
        refColumns: r.ref_columns ?? [],
        onDelete: normalizeAction(r.on_delete),
        onUpdate: normalizeAction(r.on_update),
      })),
      tableComments: comments.rows,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** format_type() spells types out in full; show the short names people write. */
export function shortPgType(t: string): string {
  return t
    .replace(/^timestamp(\(\d+\))? with time zone/, 'timestamptz$1')
    .replace(/^timestamp(\(\d+\))? without time zone/, 'timestamp$1')
    .replace(/^time(\(\d+\))? with time zone/, 'timetz$1')
    .replace(/^time(\(\d+\))? without time zone/, 'time$1')
    .replace(/^character varying/, 'varchar')
    .replace(/^character(?=\(|$|\[)/, 'char')
    .replace(/^bit varying/, 'varbit')
    .replace(/^double precision/, 'float8');
}
