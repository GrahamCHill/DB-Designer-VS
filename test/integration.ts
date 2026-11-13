// Integration check against a real PostgreSQL (not part of `npm test`).
// Usage: node dist-test/integration.js <pg-url-base> <db-with-migrations-applied> <sql-folder> [<scratch-db>]
//   1. parser(sql-folder) vs. introspection(db)
//   2. full export → applied to <scratch-db> → introspection matches (1)
//   3. edits → change-only migration → applied to <scratch-db> → introspection matches the edited model
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { parseSql } from '../src/shared/sqlParser';
import { generateDiffSql, generateFullSql } from '../src/shared/pgExport';
import { Schema, cloneSchema } from '../src/shared/model';
import { buildSchema } from '../src/introspect/index';
import { introspectPostgres } from '../src/introspect/postgres';

const [, , base, db, folder, scratch] = process.argv;

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  serial: 'integer',
  serial4: 'integer',
  int8: 'bigint',
  bigserial: 'bigint',
  serial8: 'bigint',
  int2: 'smallint',
  smallserial: 'smallint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  varchar: 'character varying',
  char: 'character',
};
function normType(t: string): string {
  let s = t.toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')').trim();
  if (!/ with(out)? time zone/.test(s)) s = s.replace(/^(\w+)/, (w) => TYPE_ALIASES[w] ?? w);
  s = s.replace(/^(timestamp|time)\((\d+)\) with time zone/, '$1($2) with time zone');
  s = s.replace(/^timestamp with time zone\((\d+)\)/, 'timestamp($1) with time zone');
  s = s.replace(/^character varying\((\d+)\)\[\]/, 'character varying($1)[]');
  return s;
}

function summary(s: Schema) {
  const byId = new Map(s.tables.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const t of s.tables) {
    const k = `${t.schema}.${t.name}`.toLowerCase();
    out.set(`T ${k}`, t.columns.map((c) => `${c.name.toLowerCase()} ${normType(c.type)} ${c.nullable && !c.pk ? 'null' : 'notnull'}${c.pk ? ' pk' : ''}`).join(' | '));
  }
  for (const t of s.types ?? []) out.set(`Y ${t.schema}.${t.name}`.toLowerCase(), t.kind === 'enum' ? (t.values ?? []).join(',') : 'domain');
  for (const r of s.relations) {
    const f = byId.get(r.fromTable)!;
    const t = byId.get(r.toTable)!;
    const fc = r.fromColumns.map((id) => f.columns.find((c) => c.id === id)!.name);
    const tc = r.toColumns.map((id) => t.columns.find((c) => c.id === id)!.name);
    out.set(`F ${f.schema}.${f.name}(${fc})`.toLowerCase(), `${t.schema}.${t.name}(${tc}) del=${r.onDelete ?? 'NO ACTION'} upd=${r.onUpdate ?? 'NO ACTION'}`.toLowerCase());
  }
  return out;
}

function compare(label: string, a: Schema, b: Schema, aName: string, bName: string): number {
  const sa = summary(a);
  const sb = summary(b);
  let diffs = 0;
  for (const [k, v] of sa) {
    const w = sb.get(k);
    if (w === undefined) {
      console.log(`  [${label}] only in ${aName}: ${k}`);
      diffs++;
    } else if (w !== v) {
      const ca = v.split(' | ');
      const cb = w.split(' | ');
      const onlyA = ca.filter((x) => !cb.includes(x));
      const onlyB = cb.filter((x) => !ca.includes(x));
      console.log(`  [${label}] differs ${k}\n      ${aName}: ${onlyA.join(' | ') || '(order only)'}\n      ${bName}: ${onlyB.join(' | ') || '(order only)'}`);
      diffs++;
    }
  }
  for (const k of sb.keys()) {
    if (!sa.has(k)) {
      console.log(`  [${label}] only in ${bName}: ${k}`);
      diffs++;
    }
  }
  console.log(`${diffs === 0 ? 'PASS' : 'FAIL'} ${label}: ${sa.size} items compared, ${diffs} difference(s)`);
  return diffs;
}

async function exec(url: string, sql: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function main() {
  const files = fs
    .readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(folder, f), 'utf8') }));
  const parsed = parseSql(files).schema;
  const live = buildSchema('postgres', await introspectPostgres(`${base}/${db}`));
  console.log(`parser: ${parsed.tables.length} tables / ${parsed.relations.length} FKs; live: ${live.tables.length} tables / ${live.relations.length} FKs`);
  let failures = compare('parser vs live DB', parsed, live, 'parser', 'live');

  if (scratch) {
    const url = `${base}/${scratch}`;
    await exec(url, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const s of new Set(parsed.tables.map((t) => t.schema))) if (s !== 'public') await exec(url, `DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    const full = generateFullSql(parsed);
    fs.writeFileSync(path.join(__dirname, `${scratch}.full.sql`), full);
    await exec(url, full);
    const rt = buildSchema('postgres', await introspectPostgres(url));
    failures += compare('live DB vs export re-applied', live, rt, 'live', 'export');

    // Edit the parsed model like a user would in the diagram, then apply the migration.
    const edited = cloneSchema(parsed);
    const t0 = edited.tables[0];
    t0.columns.push({ id: 'it_new', name: 'erd_added', type: 'text', nullable: true, pk: false, unique: true, default: "'x'" });
    const renamed = edited.tables.find((t) => t.columns.some((c) => !c.pk && edited.relations.every((r) => !r.fromColumns.includes(c.id))));
    const rc = renamed!.columns.find((c) => !c.pk && !edited.relations.some((r) => r.fromColumns.includes(c.id) || r.toColumns.includes(c.id)))!;
    rc.name = rc.name + '_renamed';
    rc.nullable = true;
    edited.tables.push({
      id: 'it_tbl',
      schema: t0.schema,
      name: 'erd_new_table',
      columns: [
        { id: 'it_c1', name: 'id', type: 'bigint', nullable: false, pk: true, unique: false, identity: true },
        { id: 'it_c2', name: 'parent_id', type: t0.columns.find((c) => c.pk)!.type, nullable: false, pk: false, unique: false },
      ],
    });
    edited.relations.push({ id: 'it_r', fromTable: 'it_tbl', fromColumns: ['it_c2'], toTable: t0.id, toColumns: [t0.columns.find((c) => c.pk)!.id], onDelete: 'CASCADE' });
    const dropped = edited.relations.shift()!;
    void dropped;
    const mig = generateDiffSql(parsed, edited);
    fs.writeFileSync(path.join(__dirname, `${scratch}.migration.sql`), mig);
    await exec(url, mig);
    const after = buildSchema('postgres', await introspectPostgres(url));
    failures += compare('edited model vs migration applied', edited, after, 'edited', 'db');
  }
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
