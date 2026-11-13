// Read-only live modelling of an Azure PostgreSQL database with DB Designer's introspector.
// Usage: AZ_DB_URL=... node dist-test/live-azure.js <outDir> <db>=<repo sql folder> [...]
// The connection string is read from the environment and never printed.
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { buildSchema } from '../src/introspect/index';
import { introspectPostgres } from '../src/introspect/postgres';
import { parseSql } from '../src/shared/sqlParser';
import { Schema, tableKey } from '../src/shared/model';
import { buildStandaloneHtml } from '../src/standalone';

const base = process.env.AZ_DB_URL;
if (!base) throw new Error('AZ_DB_URL not set');
const [, , outDir, ...targets] = process.argv;

function urlFor(db: string): string {
  const u = new URL(base!);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Prove the session cannot write: inside the same read-only setup the introspector uses, a write must fail. */
async function proveReadOnly(db: string): Promise<string> {
  const c = new Client({ connectionString: urlFor(db), connectionTimeoutMillis: 20000, options: '-c default_transaction_read_only=on' });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const ro = (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    let rejected = '';
    try {
      await c.query('CREATE TEMP TABLE db_designer_write_probe (i int)'); // must be rejected
    } catch (e) {
      rejected = (e as Error).message;
    }
    await c.query('ROLLBACK').catch(() => undefined);
    const version = (await c.query('SHOW server_version')).rows[0].server_version;
    if (!rejected) throw new Error('A write was NOT rejected; aborting.');
    return `server ${version}; transaction_read_only=${ro}; write probe rejected: "${rejected}"`;
  } finally {
    await c.end();
  }
}

function sqlFolder(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function drift(live: Schema, repo: Schema) {
  const lk = new Map(live.tables.map((t) => [tableKey(t), t]));
  const rk = new Map(repo.tables.map((t) => [tableKey(t), t]));
  const onlyLive = [...lk.keys()].filter((k) => !rk.has(k));
  const onlyRepo = [...rk.keys()].filter((k) => !lk.has(k));
  const colDiffs: string[] = [];
  for (const [k, lt] of lk) {
    const rt = rk.get(k);
    if (!rt) continue;
    const lc = new Set(lt.columns.map((c) => c.name.toLowerCase()));
    const rc = new Set(rt.columns.map((c) => c.name.toLowerCase()));
    const extra = [...lc].filter((c) => !rc.has(c));
    const missing = [...rc].filter((c) => !lc.has(c));
    if (extra.length || missing.length) colDiffs.push(`${k}: ${extra.length ? `+${extra.join(',')}` : ''}${missing.length ? ` -${missing.join(',')}` : ''}`);
  }
  return { onlyLive, onlyRepo, colDiffs };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const js = fs.readFileSync('dist/webview.js', 'utf8');
  const css = fs.readFileSync('dist/webview.css', 'utf8');
  for (const t of targets) {
    const [db, repoDir] = t.split('=');
    console.log(`\n=== ${db}`);
    console.log(`read-only check: ${await proveReadOnly(db)}`);
    const t0 = Date.now();
    const live = buildSchema('postgres', await introspectPostgres(urlFor(db)));
    const schemas = [...new Set(live.tables.map((x) => x.schema))].sort();
    console.log(`modelled in ${Date.now() - t0} ms: ${live.tables.length} tables, ${live.relations.length} foreign keys, ${live.types?.length ?? 0} types; schemas: ${schemas.join(', ')}`);
    if (repoDir) {
      const repo = parseSql(sqlFolder(repoDir)).schema;
      const d = drift(live, repo);
      console.log(`vs repo migrations (${repo.tables.length} tables): ${d.onlyLive.length} only live, ${d.onlyRepo.length} only in repo, ${d.colDiffs.length} tables with column differences`);
      if (d.onlyLive.length) console.log(`  only live: ${d.onlyLive.slice(0, 12).join(', ')}${d.onlyLive.length > 12 ? ' …' : ''}`);
      if (d.onlyRepo.length) console.log(`  only in repo: ${d.onlyRepo.slice(0, 12).join(', ')}${d.onlyRepo.length > 12 ? ' …' : ''}`);
      for (const c of d.colDiffs.slice(0, 8)) console.log(`  ${c}`);
    }
    const file = { format: 'db-designer-vs' as const, version: 1 as const, title: `${db} (Azure dev, live)`, savedAt: new Date().toISOString(), source: `shd-psql-mpudoh-cmt-dev / ${db} (read-only introspection)`, schema: live, layout: {} };
    fs.writeFileSync(path.join(outDir, `${db}.erd.json`), JSON.stringify(file, null, 2));
    fs.writeFileSync(path.join(outDir, `${db}.erd.html`), buildStandaloneHtml(file, js, css));
    console.log(`saved ${db}.erd.json and ${db}.erd.html (schema only, no row data)`);
  }
})().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exitCode = 1;
});
