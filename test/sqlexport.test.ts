import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';
import { parseSql } from '../src/shared/sqlParser';
import { EXPORT_DIALECTS, canonicalDefault, canonicalType, generateSchemaSql } from '../src/shared/sqlExport';
import { Schema } from '../src/shared/model';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs: () => Promise<SqlJsStatic> = require('sql.js/dist/sql-asm.js');

const pg = (sql: string) => parseSql([{ name: 'x.sql', content: sql }], { dialect: 'postgres' }).schema;

const EDGE = pg(`
  CREATE SCHEMA app;
  CREATE TYPE app.status AS ENUM ('draft', 'it''s done');
  CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, "order" int, active boolean NOT NULL DEFAULT true,
    created_at timestamptz(3) NOT NULL DEFAULT now(), tags text[] DEFAULT '{}', prefs jsonb NOT NULL DEFAULT '{}'::jsonb, small smallint DEFAULT -1, n numeric);
  CREATE TABLE app.users (id bigserial PRIMARY KEY, status app.status NOT NULL DEFAULT 'draft');
  CREATE TABLE app.tree (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id int REFERENCES app.tree(id) ON DELETE CASCADE);
  CREATE TABLE app.m (user_id uuid REFERENCES public.users(id) ON DELETE CASCADE, code text, PRIMARY KEY (user_id, code));
`);

function structure(s: Schema) {
  const byId = new Map(s.tables.map((t) => [t.id, t]));
  return {
    tables: s.tables.map((t) => `${t.name}: ${t.columns.map((c) => `${c.name}${c.pk ? '*' : ''}${c.nullable && !c.pk ? '?' : ''}`).join(',')}`).sort(),
    fks: s.relations
      .map((r) => `${byId.get(r.fromTable)!.name}(${r.fromColumns.length})->${byId.get(r.toTable)!.name}`)
      .sort(),
  };
}

test('canonical types and defaults normalise every source dialect to PostgreSQL first', () => {
  const ms = parseSql([{ name: 'm.sql', content: 'CREATE TABLE [t] ([a] NVARCHAR(MAX), [b] BIT DEFAULT ((1)), [c] DATETIME2 DEFAULT (getdate()), [d] UNIQUEIDENTIFIER DEFAULT newid())\nGO' }], { dialect: 'mssql' }).schema;
  const [a, b, c, d] = ms.tables[0].columns;
  assert.equal(canonicalType(a, ms).kind, 'text');
  assert.equal(canonicalType(b, ms).kind, 'boolean');
  assert.deepEqual(canonicalDefault(b, ms), { kind: 'bool', value: true });
  assert.deepEqual(canonicalDefault(c, ms), { kind: 'now' });
  assert.deepEqual(canonicalDefault(d, ms), { kind: 'uuid' });
  const u = EDGE.tables[0];
  assert.deepEqual(canonicalDefault(u.columns.find((x) => x.name === 'small')!, EDGE), { kind: 'number', value: '-1' });
  assert.equal(canonicalType(EDGE.tables[1].columns[1], EDGE).kind, 'enum');
});

test('SQL Server output: bounded keys, filtered unique, cascade paths, N strings', () => {
  const sql = generateSchemaSql(EDGE, 'mssql');
  assert.match(sql, /\[id\] uniqueidentifier NOT NULL CONSTRAINT \[DF_users_id\] DEFAULT NEWID\(\)/);
  assert.match(sql, /\[email\] nvarchar\(450\) NOT NULL/, 'unique text becomes a bounded key type');
  assert.match(sql, /\[code\] nvarchar\(442\) NOT NULL/, 'text in a composite PK shares the 900-byte key budget with the uuid');
  assert.match(sql, /\[active\] bit NOT NULL CONSTRAINT \[DF_users_active\] DEFAULT 1/);
  assert.match(sql, /datetimeoffset\(3\) NOT NULL CONSTRAINT \[DF_users_created_at\] DEFAULT SYSDATETIMEOFFSET\(\)/);
  assert.match(sql, /\[id\] bigint IDENTITY\(1,1\) NOT NULL/);
  assert.match(sql, /CHECK \(\[status\] IN \(N'draft', N'it''s done'\)\)/);
  assert.match(sql, /IF SCHEMA_ID\(N'app'\) IS NULL EXEC\(N'CREATE SCHEMA \[app\]'\);/);
  assert.doesNotMatch(sql, /REFERENCES \[app\]\.\[tree\] \(\[id\]\) ON DELETE/, 'self-referencing cascade is removed');
  assert.match(sql, /--   tree → tree: ON DELETE CASCADE removed/);
  const back = parseSql([{ name: 'o.sql', content: sql }], { dialect: 'mssql' }).schema;
  assert.deepEqual(structure(back), structure(EDGE));
});

test('MySQL output: flattened schemas, enum, expression defaults, key lengths', () => {
  const sql = generateSchemaSql(EDGE, 'mysql');
  assert.match(sql, /CREATE TABLE `users`/);
  assert.match(sql, /CREATE TABLE `app_users`/, 'clashing names get the schema prefix');
  assert.match(sql, /`status` enum\('draft', 'it''s done'\) NOT NULL DEFAULT 'draft'/);
  assert.match(sql, /`id` char\(36\) NOT NULL DEFAULT \(UUID\(\)\)/);
  assert.match(sql, /`prefs` json NOT NULL DEFAULT \('\{\}'\)/);
  assert.match(sql, /`created_at` datetime\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/);
  assert.match(sql, /`email` varchar\(255\) NOT NULL/);
  assert.match(sql, /`id` bigint NOT NULL AUTO_INCREMENT/);
  const back = parseSql([{ name: 'o.sql', content: sql }], { dialect: 'mysql' }).schema;
  assert.deepEqual(structure(back).fks.length, structure(EDGE).fks.length);
  assert.equal(back.tables.length, EDGE.tables.length);
});

test('SQLite output runs in SQLite and keeps keys, FKs, defaults and checks', async () => {
  const sql = generateSchemaSql(EDGE, 'sqlite');
  assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL/);
  assert.match(sql, /FOREIGN KEY \("parent_id"\) REFERENCES "tree" \("id"\) ON DELETE CASCADE/);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(sql);
  db.exec('PRAGMA foreign_key_check;');
  db.exec(`INSERT INTO "users" (email) VALUES ('a@b.c');`);
  const row = db.exec('SELECT id, active, small, prefs FROM "users"')[0].values[0];
  assert.match(String(row[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'uuid v4 default');
  assert.deepEqual(row.slice(1), [1, -1, '{}']);
  assert.throws(() => db.exec(`INSERT INTO "app_users" (status) VALUES ('bogus');`), /CHECK constraint failed/);
  db.exec('INSERT INTO "tree" (id) VALUES (1); INSERT INTO "tree" (id, parent_id) VALUES (2, 1); DELETE FROM "tree" WHERE id = 1;');
  assert.equal(db.exec('SELECT COUNT(*) FROM "tree"')[0].values[0][0], 0, 'self-referencing cascade works in SQLite');
  db.close();
});

const SAMPLES = ['../MPUDOH-ContractManagementTool/db', '../MPUDOH-Case-Management-System/db'];
for (const dir of SAMPLES) {
  const abs = path.resolve(__dirname, '..', dir);
  test(`sample ${dir}: every dialect parses back to the same structure; SQLite executes`, { skip: !fs.existsSync(abs) && 'sample not present' }, async () => {
    const files = fs
      .readdirSync(abs)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => ({ name: f, content: fs.readFileSync(path.join(abs, f), 'utf8') }));
    const model = parseSql(files).schema;
    for (const d of EXPORT_DIALECTS) {
      const sql = generateSchemaSql(model, d.id);
      const back = parseSql([{ name: `out.${d.id}.sql`, content: sql }], { dialect: d.id }).schema;
      assert.equal(back.tables.length, model.tables.length, `${d.id}: table count`);
      assert.equal(back.relations.length, model.relations.length, `${d.id}: FK count`);
      if (d.id === 'sqlite') {
        const SQL = await initSqlJs();
        const db = new SQL.Database();
        db.exec(sql);
        db.exec('PRAGMA foreign_key_check;');
        db.close();
      }
    }
  });
}
