import * as mysql from 'mysql2/promise';
import { ConstraintRow, IntrospectionRows, normalizeAction } from './index';

export async function introspectMysql(connection: string): Promise<IntrospectionRows> {
  const conn = await mysql.createConnection(connection);
  try {
    const [dbRows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
    const db = dbRows[0]?.db;
    if (!db) throw new Error('No database selected. Include the database name in the URL, e.g. mysql://user:pass@host:3306/mydb');

    const [cols] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS type, c.IS_NULLABLE AS nullable,
              c.COLUMN_DEFAULT AS def, c.EXTRA AS extra, c.COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      [db],
    );
    const [keys] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
              k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS ref_tbl, k.REFERENCED_COLUMN_NAME AS ref_col,
              rc.DELETE_RULE AS on_delete, rc.UPDATE_RULE AS on_update
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE k
         ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
       ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db],
    );
    const [tcomments] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS tbl, TABLE_COMMENT AS comment FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_COMMENT <> ''`,
      [db],
    );

    const constraints = new Map<string, ConstraintRow>();
    for (const k of keys) {
      const id = `${k.tbl}|${k.name}|${k.type}`;
      let c = constraints.get(id);
      if (!c) {
        const kind = k.type === 'PRIMARY KEY' ? 'p' : k.type === 'UNIQUE' ? 'u' : 'f';
        c = {
          schema: '',
          table: k.tbl,
          name: k.type === 'PRIMARY KEY' ? undefined : k.name,
          kind,
          columns: [],
          refSchema: kind === 'f' ? '' : undefined,
          refTable: k.ref_tbl ?? undefined,
          refColumns: [],
          onDelete: normalizeAction(k.on_delete),
          onUpdate: normalizeAction(k.on_update),
        };
        constraints.set(id, c);
      }
      c.columns.push(k.col);
      if (k.ref_col) c.refColumns!.push(k.ref_col);
    }
    return {
      columns: cols.map((r) => ({
        schema: '',
        table: r.tbl,
        column: r.col,
        type: String(r.type),
        nullable: r.nullable === 'YES',
        default:
          r.def === null || r.def === undefined
            ? null
            : /^-?\d+(\.\d+)?$/.test(String(r.def)) || /DEFAULT_GENERATED/i.test(r.extra ?? '')
              ? String(r.def)
              : `'${String(r.def).replace(/'/g, "''")}'`,
        identity: /auto_increment/i.test(r.extra ?? ''),
        comment: r.comment || null,
      })),
      constraints: [...constraints.values()],
      tableComments: tcomments.map((r) => ({ schema: '', table: r.tbl, comment: r.comment })),
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}
