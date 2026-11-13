import * as fs from 'fs';
import type { SqlJsStatic, Database } from 'sql.js';
import { ConstraintRow, IntrospectionRows, normalizeAction } from './index';

// The asm.js build of sql.js is pure JavaScript, so it bundles without shipping a .wasm file.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs: (cfg?: object) => Promise<SqlJsStatic> = require('sql.js/dist/sql-asm.js');

function all(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function introspectSqlite(file: string): Promise<IntrospectionRows> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const tables = all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(
      (r) => String(r.name),
    );
    const columns: IntrospectionRows['columns'] = [];
    const constraints: ConstraintRow[] = [];
    for (const t of tables) {
      const sqlText = String(all(db, `SELECT sql FROM sqlite_master WHERE type='table' AND name='${t.replace(/'/g, "''")}'`)[0]?.sql ?? '');
      const autoinc = /AUTOINCREMENT/i.test(sqlText);
      const info = all(db, `PRAGMA table_info(${q(t)})`);
      const pkCols = info.filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
      for (const r of info) {
        const type = String(r.type || '');
        const isRowidAlias = pkCols.length === 1 && Number(r.pk) === 1 && /^integer$/i.test(type);
        columns.push({
          schema: '',
          table: t,
          column: String(r.name),
          type: type.toLowerCase(),
          nullable: !Number(r.notnull) && !Number(r.pk),
          default: r.dflt_value === null ? null : String(r.dflt_value),
          identity: isRowidAlias && autoinc,
        });
      }
      if (pkCols.length) constraints.push({ schema: '', table: t, kind: 'p', columns: pkCols.map((r) => String(r.name)) });

      for (const idx of all(db, `PRAGMA index_list(${q(t)})`)) {
        if (!Number(idx.unique) || idx.origin === 'pk' || Number(idx.partial)) continue;
        const cols = all(db, `PRAGMA index_info(${q(String(idx.name))})`)
          .sort((a, b) => Number(a.seqno) - Number(b.seqno))
          .map((r) => r.name);
        if (cols.some((c) => c === null)) continue;
        constraints.push({ schema: '', table: t, kind: 'u', name: idx.origin === 'c' ? String(idx.name) : undefined, columns: cols.map(String) });
      }

      const fkRows = all(db, `PRAGMA foreign_key_list(${q(t)})`);
      const byId = new Map<number, Record<string, unknown>[]>();
      for (const r of fkRows) {
        const id = Number(r.id);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push(r);
      }
      for (const rows of byId.values()) {
        rows.sort((a, b) => Number(a.seq) - Number(b.seq));
        const refTable = String(rows[0].table);
        let refColumns = rows.map((r) => (r.to === null ? null : String(r.to)));
        if (refColumns.some((c) => c === null)) {
          // FK without explicit columns references the parent's primary key
          const parentPk = all(db, `PRAGMA table_info(${q(refTable)})`)
            .filter((r) => Number(r.pk) > 0)
            .sort((a, b) => Number(a.pk) - Number(b.pk))
            .map((r) => String(r.name));
          refColumns = parentPk;
        }
        constraints.push({
          schema: '',
          table: t,
          kind: 'f',
          columns: rows.map((r) => String(r.from)),
          refSchema: '',
          refTable,
          refColumns: refColumns as string[],
          onDelete: normalizeAction(String(rows[0].on_delete)),
          onUpdate: normalizeAction(String(rows[0].on_update)),
        });
      }
    }
    return { columns, constraints };
  } finally {
    db.close();
  }
}
