import * as sql from 'mssql';
import { ConstraintRow, IntrospectionRows, normalizeAction } from './index';

const COLUMNS_SQL = `
SELECT s.name AS [schema], t.name AS [table], c.name AS [column], ty.name AS type_name,
       c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
       dc.definition AS default_def, CAST(ep.value AS nvarchar(4000)) AS comment, c.column_id
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id`;

const KEYS_SQL = `
SELECT s.name AS [schema], t.name AS [table], i.name AS name,
       CASE WHEN i.is_primary_key = 1 THEN 'p' ELSE 'u' END AS kind,
       c.name AS [column], ic.key_ordinal
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE (i.is_primary_key = 1 OR i.is_unique = 1) AND i.has_filter = 0 AND t.is_ms_shipped = 0
ORDER BY s.name, t.name, i.name, ic.key_ordinal`;

const FKS_SQL = `
SELECT fk.name AS name, s.name AS [schema], t.name AS [table], c.name AS [column],
       rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
       fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
       fkc.constraint_column_id
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables t ON t.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY fk.name, fkc.constraint_column_id`;

const TABLE_COMMENTS_SQL = `
SELECT s.name AS [schema], t.name AS [table], CAST(ep.value AS nvarchar(4000)) AS comment
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'`;

function formatType(r: { type_name: string; max_length: number; precision: number; scale: number }): string {
  const n = r.type_name.toLowerCase();
  switch (n) {
    case 'nvarchar':
    case 'nchar':
      return `${n}(${r.max_length === -1 ? 'max' : r.max_length / 2})`;
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${n}(${r.max_length === -1 ? 'max' : r.max_length})`;
    case 'decimal':
    case 'numeric':
      return `${n}(${r.precision},${r.scale})`;
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return r.scale === 7 ? n : `${n}(${r.scale})`;
    default:
      return n;
  }
}

/** Accepts an ADO-style connection string or a mssql://user:pass@host:port/db?encrypt=true URL. */
function toConfig(conn: string): string | sql.config {
  if (!/^mssql:\/\/|^sqlserver:\/\//i.test(conn)) return conn;
  const u = new URL(conn.replace(/^sqlserver:/i, 'mssql:'));
  const q = u.searchParams;
  return {
    server: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || undefined,
    options: {
      encrypt: q.get('encrypt') !== 'false',
      trustServerCertificate: q.get('trustServerCertificate') === 'true',
    },
  };
}

export async function introspectMssql(connection: string): Promise<IntrospectionRows> {
  const pool = await new sql.ConnectionPool(toConfig(connection) as sql.config).connect();
  // Read-only by construction: all catalog reads run in one transaction that is always rolled back.
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    const cols = (await new sql.Request(tx).query(COLUMNS_SQL)).recordset;
    const keys = (await new sql.Request(tx).query(KEYS_SQL)).recordset;
    const fks = (await new sql.Request(tx).query(FKS_SQL)).recordset;
    const comments = (await new sql.Request(tx).query(TABLE_COMMENTS_SQL)).recordset;
    await tx.rollback();

    const constraints = new Map<string, ConstraintRow>();
    for (const k of keys) {
      const id = `k|${k.schema}|${k.table}|${k.name}`;
      let c = constraints.get(id);
      if (!c) constraints.set(id, (c = { schema: k.schema, table: k.table, name: k.name, kind: k.kind, columns: [] }));
      c.columns.push(k.column);
    }
    for (const f of fks) {
      const id = `f|${f.schema}|${f.table}|${f.name}`;
      let c = constraints.get(id);
      if (!c)
        constraints.set(
          id,
          (c = {
            schema: f.schema,
            table: f.table,
            name: f.name,
            kind: 'f',
            columns: [],
            refSchema: f.ref_schema,
            refTable: f.ref_table,
            refColumns: [],
            onDelete: normalizeAction(f.on_delete),
            onUpdate: normalizeAction(f.on_update),
          }),
        );
      c.columns.push(f.column);
      c.refColumns!.push(f.ref_column);
    }
    return {
      columns: cols.map((r) => ({
        schema: r.schema,
        table: r.table,
        column: r.column,
        type: formatType(r),
        nullable: !!r.is_nullable,
        default: r.default_def,
        identity: !!r.is_identity,
        comment: r.comment,
      })),
      constraints: [...constraints.values()],
      tableComments: comments,
    };
  } finally {
    await pool.close().catch(() => undefined);
  }
}
