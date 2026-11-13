// Executes generated PostgreSQL DDL inside PGlite (PostgreSQL compiled to WebAssembly) to prove it runs.
// The WASM/data files are loaded explicitly from `assetsDir` so this works from a bundled extension.

import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PGlite } from '@electric-sql/pglite';

export interface VerifyResult {
  ok: boolean;
  engine: string;
  error?: string;
  /** The statement that failed, when it could be identified. */
  statement?: string;
  skipped?: string;
}

/** Extensions bundled with the extension; any other CREATE EXTENSION can't be verified offline. */
const BUNDLED_EXTENSIONS: Record<string, { ns: string; file: string }> = {
  'uuid-ossp': { ns: 'uuid_ossp', file: 'uuid-ossp.tar.gz' },
  pgcrypto: { ns: 'pgcrypto', file: 'pgcrypto.tar.gz' },
  citext: { ns: 'citext', file: 'citext.tar.gz' },
};

let cached: { wasm: WebAssembly.Module; initdb: WebAssembly.Module; data: Buffer } | undefined;

async function load(assetsDir: string) {
  if (!cached) {
    const [wasm, initdb, data] = await Promise.all([
      fs.readFile(path.join(assetsDir, 'pglite.wasm')),
      fs.readFile(path.join(assetsDir, 'initdb.wasm')),
      fs.readFile(path.join(assetsDir, 'pglite.data')),
    ]);
    cached = { wasm: await WebAssembly.compile(wasm), initdb: await WebAssembly.compile(initdb), data };
  }
  return cached;
}

/**
 * Run `setup` (e.g. the baseline schema for a migration) and then `sql` in a fresh in-memory PostgreSQL.
 */
export async function verifyPostgres(sql: string, assetsDir: string, setup?: string): Promise<VerifyResult> {
  const engine = 'PostgreSQL 17 (PGlite, in-process)';
  const all = `${setup ?? ''}\n${sql}`;
  const wanted = [...all.matchAll(/CREATE EXTENSION IF NOT EXISTS\s+"?([\w-]+)"?/gi)].map((m) => m[1].toLowerCase());
  const missing = wanted.filter((e) => !BUNDLED_EXTENSIONS[e]);
  if (missing.length) return { ok: true, engine, skipped: `needs PostgreSQL extension(s) ${missing.join(', ')}, which can't be loaded offline` };
  const extensions: Record<string, URL> = {};
  for (const e of wanted) extensions[BUNDLED_EXTENSIONS[e].ns] = pathToFileURL(path.join(assetsDir, BUNDLED_EXTENSIONS[e].file));

  const { wasm, initdb, data } = await load(assetsDir);
  const db = await PGlite.create({
    pgliteWasmModule: wasm,
    initdbWasmModule: initdb,
    fsBundle: new Blob([new Uint8Array(data)]),
    extensions,
  });
  try {
    if (setup) {
      try {
        await db.exec(setup);
      } catch (e) {
        return { ok: false, engine, error: `the starting schema could not be created: ${(e as Error).message}` };
      }
    }
    // Statement by statement, so a failure can name the exact statement.
    for (const stmt of splitStatements(sql)) {
      try {
        await db.exec(stmt);
      } catch (e) {
        return { ok: false, engine, error: (e as Error).message, statement: stmt.trim().slice(0, 600) };
      }
    }
    return { ok: true, engine };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** Split on semicolons outside quotes, dollar quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end < 0 ? sql.length : end + dollar[0].length;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim() + ';');
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
