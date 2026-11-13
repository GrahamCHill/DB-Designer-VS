// Proves exported SQL is valid before it is saved: model rules for every dialect, then execution
// (PostgreSQL via PGlite, SQLite via sql.js) or a structural re-read (SQL Server, MySQL).

import type { SqlJsStatic } from 'sql.js';
import { Schema } from '../shared/model';
import { generateFullSql } from '../shared/pgExport';
import { EXPORT_DIALECTS, ExportDialect } from '../shared/sqlExport';
import { structuralCheck, validateForExport } from '../shared/validate';
import { pg18Features, verifyPostgres } from './postgres';

export interface Verification {
  dialect: ExportDialect;
  ok: boolean;
  /** One line describing what was proven. */
  summary: string;
  errors: string[];
  warnings: string[];
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs: () => Promise<SqlJsStatic> = require('sql.js/dist/sql-asm.js');

async function verifySqlite(sql: string): Promise<{ ok: boolean; engine: string; error?: string }> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    const version = String(db.exec('SELECT sqlite_version()')[0].values[0][0]);
    const engine = `SQLite ${version} (in-process)`;
    try {
      db.exec(sql);
      db.exec('PRAGMA foreign_key_check;'); // raises "foreign key mismatch" for FKs to non-key columns
      const integrity = String(db.exec('PRAGMA integrity_check;')[0].values[0][0]);
      if (integrity !== 'ok') return { ok: false, engine, error: `integrity_check: ${integrity}` };
      return { ok: true, engine };
    } catch (e) {
      return { ok: false, engine, error: (e as Error).message };
    }
  } finally {
    db.close();
  }
}

export interface VerifyInput {
  schema: Schema;
  baseline?: Schema;
  target: ExportDialect;
  mode: 'full' | 'diff';
  sql: string;
  schemas?: string[];
  /** Folder holding the PGlite runtime (pglite.wasm, pglite.data, initdb.wasm, extension tarballs). */
  pgliteDir: string;
}

export async function verifyExport(input: VerifyInput): Promise<Verification> {
  const { schema, target, mode, sql, schemas } = input;
  const label = EXPORT_DIALECTS.find((d) => d.id === target)!.label;
  const issues = validateForExport(schema, mode === 'diff' ? 'postgres' : target, mode === 'diff' ? undefined : schemas);
  const errors = issues.filter((i) => i.level === 'error').map((i) => `${i.where}: ${i.message}`);
  const warnings = issues.filter((i) => i.level === 'warning').map((i) => `${i.where}: ${i.message}`);
  let summary: string;

  if (target === 'postgres') {
    const r = await verifyPostgres(sql, input.pgliteDir, mode === 'diff' && input.baseline ? generateFullSql(input.baseline) : undefined);
    if (r.skipped) {
      summary = `Not executed: ${r.skipped}. Model rules checked.`;
      warnings.push(summary);
    } else if (r.ok) {
      const pg18 = pg18Features(sql);
      summary = `Executed successfully in ${r.engine}${mode === 'diff' ? ' on top of the starting schema' : ''}.${pg18.length ? ` PostgreSQL 18 features emulated: ${pg18.join(', ')}.` : ''}`;
    } else {
      summary = `${r.engine} rejected the SQL.`;
      errors.unshift(`${r.error}${r.statement ? `\n    in: ${r.statement.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    }
  } else if (target === 'sqlite') {
    const r = await verifySqlite(sql);
    if (r.ok) summary = `Executed successfully in ${r.engine}; foreign keys and integrity checked.`;
    else {
      summary = `${r.engine} rejected the SQL.`;
      errors.unshift(r.error ?? 'unknown error');
    }
  } else {
    const problems = structuralCheck(schema, sql, target, schemas);
    errors.push(...problems);
    summary = problems.length
      ? `The generated ${label} SQL does not match the diagram.`
      : `Re-read and matched the diagram (tables, columns, keys, foreign keys); ${label} limits applied. Not executed: no ${label} engine runs inside VS Code.`;
  }
  return { dialect: target, ok: errors.length === 0, summary, errors, warnings };
}

/** Header lines recording the validation result in the exported file. */
export function validationHeader(v: Verification): string {
  return [`-- Validation: ${v.ok ? 'passed' : 'FAILED'}. ${v.summary}`, ...v.warnings.slice(0, 20).map((w) => `--   note: ${w}`)].join('\n');
}
