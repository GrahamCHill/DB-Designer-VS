import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseSql } from '../src/shared/sqlParser';
import { structuralCheck, validateForExport } from '../src/shared/validate';
import { EXPORT_DIALECTS, generateSchemaSql } from '../src/shared/sqlExport';
import { generateDiffSql, generateFullSql } from '../src/shared/pgExport';
import { cloneSchema } from '../src/shared/model';
import { verifyExport } from '../src/verify/index';

const PGLITE = path.resolve('node_modules/@electric-sql/pglite/dist');
const pg = (sql: string) => parseSql([{ name: 'x.sql', content: sql }], { dialect: 'postgres' }).schema;

const GOOD = pg(`
  CREATE TABLE app.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL);
  CREATE TABLE app.posts (id bigserial PRIMARY KEY, user_id uuid REFERENCES app.users(id) ON DELETE CASCADE, body text);
`);

test('model rules catch problems that would make SQL invalid', () => {
  const s = cloneSchema(GOOD);
  const users = s.tables[0];
  users.columns.push({ ...users.columns[1], id: 'dup' }); // duplicate column name
  s.tables.push({ id: 'empty', schema: 'app', name: 'empty', columns: [] });
  s.tables.push({ id: 'long', schema: 'app', name: 'x'.repeat(70), columns: [{ id: 'l1', name: 'id', type: 'int', nullable: false, pk: true, unique: false }] });
  const posts = s.tables[1];
  // FK to a non-key column and with an incompatible type
  posts.columns.push({ id: 'p9', name: 'author_body', type: 'integer', nullable: true, pk: false, unique: false });
  s.relations.push({ id: 'bad', fromTable: posts.id, fromColumns: ['p9'], toTable: posts.id, toColumns: [posts.columns.find((c) => c.name === 'body')!.id] });
  const issues = validateForExport(s, 'mysql').filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(issues.some((m) => /Duplicate column name "email"/.test(m)), 'duplicate column');
  assert.ok(issues.some((m) => /no columns/.test(m)), 'empty table');
  assert.ok(issues.some((m) => /MySQL allows 64/.test(m)), 'name length');
  assert.ok(issues.some((m) => /not a primary key or unique/.test(m)), 'FK to non-key');
  assert.ok(issues.some((m) => /cannot reference/.test(m)), 'FK type mismatch');
  assert.deepEqual(validateForExport(GOOD, 'postgres').filter((i) => i.level === 'error'), []);
});

test('flattening clash and PostgreSQL index-name clash are reported', () => {
  const s = pg(`CREATE TABLE app.users (id int PRIMARY KEY); CREATE TABLE public.app_users (id int PRIMARY KEY);
                CREATE TABLE public.users (id int CONSTRAINT pk PRIMARY KEY); CREATE TABLE public.other (id int CONSTRAINT pk PRIMARY KEY);`);
  assert.ok(validateForExport(s, 'sqlite').some((i) => i.level === 'error' && /would both be named "app_users"/.test(i.message)));
  assert.ok(validateForExport(s, 'postgres').some((i) => i.level === 'error' && /"pk" is also used/.test(i.message)));
});

test('PostgreSQL output is executed in PGlite; errors name the statement', async () => {
  const ok = await verifyExport({ schema: GOOD, target: 'postgres', mode: 'full', sql: generateFullSql(GOOD), pgliteDir: PGLITE });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.match(ok.summary, /Executed successfully in PostgreSQL/);
  const bad = generateFullSql(GOOD).replace('body text', 'body texxt');
  const r = await verifyExport({ schema: GOOD, target: 'postgres', mode: 'full', sql: bad, pgliteDir: PGLITE });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /type "texxt" does not exist/);
  // A migration is executed on top of the starting schema
  const edited = cloneSchema(GOOD);
  edited.tables[1].columns.push({ id: 'n1', name: 'title', type: 'varchar(200)', nullable: false, pk: false, unique: false, default: "''" });
  const mig = await verifyExport({ schema: edited, baseline: GOOD, target: 'postgres', mode: 'diff', sql: generateDiffSql(GOOD, edited), pgliteDir: PGLITE });
  assert.equal(mig.ok, true, mig.errors.join('\n'));
});

test('SQLite output is executed; SQL Server / MySQL output is structurally re-checked', async () => {
  for (const d of EXPORT_DIALECTS.filter((x) => x.id !== 'postgres')) {
    const sql = generateSchemaSql(GOOD, d.id);
    const v = await verifyExport({ schema: GOOD, target: d.id, mode: 'full', sql, pgliteDir: PGLITE });
    assert.equal(v.ok, true, `${d.id}: ${v.errors.join('\n')}`);
  }
  const ms = generateSchemaSql(GOOD, 'mssql');
  const broken = ms.replace(/CREATE TABLE \[app\]\.\[posts\][\s\S]*?\);\n/, '');
  assert.ok(structuralCheck(GOOD, broken, 'mssql').some((p) => /posts is missing/.test(p)));
  assert.ok(structuralCheck(GOOD, ms.replace('PRIMARY KEY ([id])', 'PRIMARY KEY ([id]'), 'mssql').some((p) => /Unclosed|Unbalanced/.test(p)));
  const sqliteBad = await verifyExport({ schema: GOOD, target: 'sqlite', mode: 'full', sql: generateSchemaSql(GOOD, 'sqlite').replace('CREATE TABLE "posts"', 'CREATE TABLE "posts" ("x" INTEGER,'), pgliteDir: PGLITE });
  assert.equal(sqliteBad.ok, false);
});

const SAMPLE = path.resolve(__dirname, '..', '../MPUDOH-ContractManagementTool/db');
test('sample: every dialect validates cleanly', { skip: !fs.existsSync(SAMPLE) && 'sample not present' }, async () => {
  const files = fs
    .readdirSync(SAMPLE)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(SAMPLE, f), 'utf8') }));
  const s = parseSql(files).schema;
  for (const d of EXPORT_DIALECTS) {
    const v = await verifyExport({ schema: s, target: d.id, mode: 'full', sql: generateSchemaSql(s, d.id), pgliteDir: PGLITE });
    assert.equal(v.ok, true, `${d.id}: ${v.errors.slice(0, 3).join('\n')}`);
  }
});

test('PostgreSQL 18 features (uuidv7, VIRTUAL generated columns) validate on PGlite 17 by emulation', async () => {
  const s = pg(`
    CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT uuidv7(), price numeric(10,2) NOT NULL,
      price_with_tax numeric(10,2) GENERATED ALWAYS AS (price * 1.15) VIRTUAL);
  `);
  const sql = generateFullSql(s);
  assert.match(sql, /DEFAULT uuidv7\(\)/);
  assert.match(sql, /GENERATED ALWAYS AS \(price \* 1\.15\) VIRTUAL/);
  const r = await verifyExport({ schema: s, target: 'postgres', mode: 'full', sql, pgliteDir: PGLITE });
  assert.ok(r.ok, r.errors.join('\n'));
  assert.match(r.summary, /PostgreSQL 18 features emulated: uuidv7\(\)\/uuidv4\(\), virtual generated columns/);
});

test('SQL Server 2025 target validates and is offered next to SQL Server', async () => {
  const s = pg(`CREATE TABLE public.docs (id int PRIMARY KEY, body jsonb NOT NULL DEFAULT '{}', emb vector(3));`);
  assert.ok(EXPORT_DIALECTS.some((d) => d.id === 'mssql2025'));
  const sql = generateSchemaSql(s, 'mssql2025');
  const r = await verifyExport({ schema: s, target: 'mssql2025', mode: 'full', sql, pgliteDir: PGLITE });
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepEqual(structuralCheck(s, sql, 'mssql2025'), []);
});
