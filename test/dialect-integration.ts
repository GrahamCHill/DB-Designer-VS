// Executes the generated schema SQL on real engines and verifies the result (not part of `npm test`;
// needs the test containers). Usage:
//   node dist-test/dialect-integration.js [--keep-sql]
// Env: PG_URL, MSSQL_URL (mssql://sa:pw@host:port), MYSQL_URL (mysql://root:pw@host:port; MySQL or MariaDB),
//      MSSQL2025_URL (optional: also runs the "SQL Server 2025" target), ENGINES (optional: comma list to run)
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import * as sql from 'mssql';
import * as mysql from 'mysql2/promise';
import type { SqlJsStatic } from 'sql.js';
import { parseSql } from '../src/shared/sqlParser';
import { ExportDialect, engineOf, generateSchemaSql } from '../src/shared/sqlExport';
import { Dialect, Schema } from '../src/shared/model';
import { buildSchema } from '../src/introspect/index';
import { introspectPostgres } from '../src/introspect/postgres';
import { introspectMssql } from '../src/introspect/mssql';
import { introspectMysql } from '../src/introspect/mysql';
import { introspectSqlite } from '../src/introspect/sqlite';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs: () => Promise<SqlJsStatic> = require('sql.js/dist/sql-asm.js');

const PG_URL = process.env.PG_URL ?? 'postgres://postgres:test@127.0.0.1:55999';
const MSSQL_URL = process.env.MSSQL_URL ?? 'mssql://sa:Erd_Test_Pw_2026!@127.0.0.1:51433';
const MYSQL_URL = process.env.MYSQL_URL ?? 'mysql://root:erdtest@127.0.0.1:53306';
const MSSQL2025_URL = process.env.MSSQL2025_URL;
const msUrl = (id: ExportDialect) => (id === 'mssql2025' ? MSSQL2025_URL! : MSSQL_URL);
/** Set once the MySQL-protocol server has been asked for its version. */
let isMaria = false;
const versions: Record<string, string> = {};
const KEEP = process.argv.includes('--keep-sql');
const OUT_DIR = path.join(__dirname, 'dialect-sql');

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const EDGE_CASES = `
CREATE SCHEMA app;
CREATE TYPE app.status AS ENUM ('draft', 'active', 'it''s closed');
CREATE DOMAIN app.email AS varchar(320) CHECK (VALUE LIKE '%@%');
CREATE TABLE public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email app.email UNIQUE NOT NULL, "order" int, "group" text,
  "Weird Name" text, active boolean NOT NULL DEFAULT true, created_at timestamptz(3) NOT NULL DEFAULT now(), updated timestamp DEFAULT CURRENT_TIMESTAMP,
  born date DEFAULT current_date, tags text[] DEFAULT '{}', prefs jsonb NOT NULL DEFAULT '{}'::jsonb, ip inet, avatar bytea, ttl interval,
  balance numeric, score numeric(12,4) DEFAULT 0, ratio double precision, small smallint DEFAULT -1, search tsvector, nickname text UNIQUE);
CREATE TABLE app.users (id bigserial PRIMARY KEY, legacy_ref varchar(40) UNIQUE, status app.status NOT NULL DEFAULT 'draft', note varchar(5000));
COMMENT ON TABLE app.users IS 'Legacy users (it''s separate)';
COMMENT ON COLUMN app.users.note IS 'Free "text"';
CREATE TABLE app.tree (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id int REFERENCES app.tree(id) ON DELETE CASCADE, name text NOT NULL);
-- Diamond: two cascade paths from a to d
CREATE TABLE app.a (id int PRIMARY KEY);
CREATE TABLE app.b (id int PRIMARY KEY, a_id int NOT NULL REFERENCES app.a(id) ON DELETE CASCADE);
CREATE TABLE app.c (id int PRIMARY KEY, a_id int NOT NULL REFERENCES app.a(id) ON DELETE CASCADE);
CREATE TABLE app.d (id int PRIMARY KEY, b_id int REFERENCES app.b(id) ON DELETE CASCADE, c_id int REFERENCES app.c(id) ON DELETE SET NULL ON UPDATE CASCADE);
-- Composite keys, text keys, FK type alignment
CREATE TABLE app.memberships (user_id uuid REFERENCES public.users(id) ON DELETE CASCADE, group_code text, role varchar(30) NOT NULL DEFAULT 'member',
  PRIMARY KEY (user_id, group_code));
CREATE TABLE app.membership_log (id serial PRIMARY KEY, user_id uuid NOT NULL, group_code varchar(10) NOT NULL, at timestamptz DEFAULT now(),
  FOREIGN KEY (user_id, group_code) REFERENCES app.memberships(user_id, group_code) ON DELETE SET DEFAULT);
CREATE TABLE app.wide (id int PRIMARY KEY, ${Array.from({ length: 20 }, (_, i) => `v${i} varchar(1000)`).join(', ')});
`;

// Newest-engine features: PostgreSQL 18 uuidv7() and VIRTUAL generated columns, pgvector, json.
const LATEST = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE public.docs (id uuid PRIMARY KEY DEFAULT uuidv7(), title text NOT NULL, body jsonb NOT NULL DEFAULT '{}', embedding vector(3),
  tags text[] DEFAULT '{}', price numeric(10,2), price_with_tax numeric(10,2) GENERATED ALWAYS AS (price * 1.15) VIRTUAL);
CREATE TABLE public.chunks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, doc_id uuid NOT NULL REFERENCES public.docs(id) ON DELETE CASCADE,
  n int NOT NULL, embedding vector(3) NOT NULL, UNIQUE (doc_id, n));
`;

const MSSQL_SOURCE = `
CREATE TABLE [dbo].[Customers] ([Id] INT IDENTITY(1,1) NOT NULL, [Name] NVARCHAR(200) NOT NULL, [Notes] NVARCHAR(MAX) NULL,
  [IsVip] BIT NOT NULL DEFAULT ((0)), [Created] DATETIME2 NOT NULL DEFAULT (GETDATE()), [Guid] UNIQUEIDENTIFIER NOT NULL DEFAULT (NEWID()),
  [Balance] MONEY NULL, CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([Id] ASC))
GO
CREATE TABLE [sales].[Orders] ([Id] BIGINT IDENTITY(1,1) PRIMARY KEY, [CustomerId] INT NOT NULL, [Total] DECIMAL(10, 2) NULL, [Placed] DATETIMEOFFSET NULL,
  [Blob] VARBINARY(MAX) NULL, [Code] CHAR(3) NULL)
GO
ALTER TABLE [sales].[Orders] WITH CHECK ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerId]) REFERENCES [dbo].[Customers] ([Id]) ON DELETE CASCADE
GO
`;

function sqlFolder(dir: string): { name: string; content: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const inputs: { name: string; schema: Schema }[] = [
  { name: 'edge-cases', schema: parseSql([{ name: 'edge.sql', content: EDGE_CASES }], { dialect: 'postgres' }).schema },
  { name: 'mssql-source', schema: parseSql([{ name: 'ms.sql', content: MSSQL_SOURCE }], { dialect: 'mssql' }).schema },
  { name: 'latest-features', schema: parseSql([{ name: 'latest.sql', content: LATEST }], { dialect: 'postgres' }).schema },
];
for (const [name, dir] of [
  ['contract-management', '../MPUDOH-ContractManagementTool/db'],
  ['case-management', '../MPUDOH-Case-Management-System/db'],
]) {
  const abs = path.resolve(__dirname, '..', dir);
  if (fs.existsSync(abs)) inputs.push({ name, schema: parseSql(sqlFolder(abs)).schema });
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

interface Engine {
  id: ExportDialect;
  run(dbName: string, ddl: string): Promise<Schema>;
}

const pgEngine: Engine = {
  id: 'postgres',
  async run(db, ddl) {
    const admin = new Client({ connectionString: `${PG_URL}/postgres` });
    await admin.connect();
    versions.postgres ??= (await admin.query('SHOW server_version')).rows[0].server_version;
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
    await admin.query(`CREATE DATABASE "${db}"`);
    await admin.end();
    const c = new Client({ connectionString: `${PG_URL}/${db}` });
    await c.connect();
    try {
      await c.query(ddl);
    } finally {
      await c.end();
    }
    return buildSchema('postgres', await introspectPostgres(`${PG_URL}/${db}`));
  },
};

const mssqlEngine = (id: 'mssql' | 'mssql2025'): Engine => ({
  id,
  async run(db, ddl) {
    const base = `${msUrl(id)}?trustServerCertificate=true&encrypt=false`;
    const u = new URL(base);
    const cfg = (database: string): sql.config => ({
      server: u.hostname,
      port: Number(u.port),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const master = await new sql.ConnectionPool(cfg('master')).connect();
    versions[id] ??= String((await master.request().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS v")).recordset[0].v);
    await master.request().batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`);
    await master.close();
    const pool = await new sql.ConnectionPool(cfg(db)).connect();
    try {
      for (const batch of ddl.split(/^\s*GO\s*$/im)) if (batch.trim()) await pool.request().batch(batch);
    } finally {
      await pool.close();
    }
    return buildSchema('mssql', await introspectMssql(`mssql://${u.username}:${u.password}@${u.hostname}:${u.port}/${db}?encrypt=false&trustServerCertificate=true`));
  },
});

const mysqlEngine: Engine = {
  id: 'mysql',
  async run(db, ddl) {
    const admin = await mysql.createConnection(MYSQL_URL);
    if (!versions.mysql) {
      const [[v]] = (await admin.query('SELECT VERSION() AS v')) as unknown as [{ v: string }[]];
      versions.mysql = v.v;
      isMaria = /mariadb/i.test(v.v);
    }
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await admin.query(`CREATE DATABASE \`${db}\` DEFAULT CHARACTER SET utf8mb4`);
    await admin.end();
    const c = await mysql.createConnection({ uri: `${MYSQL_URL}/${db}`, multipleStatements: true });
    try {
      await c.query(ddl);
    } finally {
      await c.end();
    }
    return buildSchema('mysql', await introspectMysql(`${MYSQL_URL}/${db}`));
  },
};

const sqliteDbs = new Map<string, import('sql.js').Database>();

const sqliteEngine: Engine = {
  id: 'sqlite',
  async run(db, ddl) {
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    d.exec(ddl);
    // Raises "foreign key mismatch" if any FK targets a column that is not a key.
    d.exec('PRAGMA foreign_key_check;');
    const ok = d.exec('PRAGMA integrity_check;')[0].values[0][0];
    if (ok !== 'ok') throw new Error(`integrity_check: ${ok}`);
    const file = path.join(OUT_DIR, `${db}.sqlite`);
    fs.writeFileSync(file, Buffer.from(d.export()));
    sqliteDbs.set(db, d);
    return buildSchema('sqlite', await introspectSqlite(file));
  },
};

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/"/g, '');

/** Structure that must survive any dialect: tables, columns (name, nullability), PKs, FK column pairs, which columns have a default. */
function structure(s: Schema, opts: { flatten: boolean; withDefaults: boolean; isModel: boolean; pg: boolean }) {
  const byId = new Map(s.tables.map((t) => [t.id, t]));
  const tname = (t: { schema: string; name: string }) => {
    if (!opts.flatten) return `${['public', 'dbo', ''].includes(t.schema) ? '' : t.schema + '.'}${t.name}`.toLowerCase();
    // Same rule as the exporter: prefix the schema only when names clash.
    const clash = opts.isModel && s.tables.filter((x) => x.name.toLowerCase() === t.name.toLowerCase()).length > 1;
    return (clash && !['public', 'dbo', ''].includes(t.schema) ? `${t.schema}_${t.name}` : t.name).toLowerCase();
  };
  // DEFAULT NULL is no default; generated columns are created as plain columns outside PostgreSQL (documented).
  const hasDefault = (d?: string | null) =>
    d !== undefined && d !== null && !/^\s*null\s*$/i.test(d) && !/^nextval/i.test(d) && (opts.pg || !/^GENERATED\s/i.test(d));
  const tables = new Map<string, string>();
  for (const t of s.tables) {
    const cols = t.columns.map(
      (c) =>
        `${c.name.toLowerCase()}:${c.nullable && !c.pk ? 'null' : 'notnull'}${c.pk ? ':pk' : ''}${opts.withDefaults && hasDefault(c.default) ? ':def' : ''}`,
    );
    tables.set(tname(t), cols.join(' '));
  }
  const fks = s.relations
    .map((r) => {
      const f = byId.get(r.fromTable)!;
      const t = byId.get(r.toTable)!;
      return `${tname(f)}(${r.fromColumns.map((id) => f.columns.find((c) => c.id === id)!.name.toLowerCase())})->${tname(t)}(${r.toColumns.map((id) => t.columns.find((c) => c.id === id)!.name.toLowerCase())})`;
    })
    .sort();
  return { tables, fks };
}

function diff(label: string, a: ReturnType<typeof structure>, b: ReturnType<typeof structure>, an: string, bn: string): string[] {
  const out: string[] = [];
  for (const [k, v] of a.tables) {
    const w = b.tables.get(k);
    if (w === undefined) out.push(`${label}: table ${k} missing in ${bn}`);
    else if (w !== v) {
      const va = v.split(' ');
      const vb = w.split(' ');
      out.push(`${label}: ${k} differs. ${an}: ${va.filter((x) => !vb.includes(x)).join(' ')} | ${bn}: ${vb.filter((x) => !va.includes(x)).join(' ')}`);
    }
  }
  for (const k of b.tables.keys()) if (!a.tables.has(k)) out.push(`${label}: extra table ${k} in ${bn}`);
  const fa = new Set(a.fks);
  const fb = new Set(b.fks);
  for (const f of fa) if (!fb.has(f)) out.push(`${label}: FK ${f} missing in ${bn}`);
  for (const f of fb) if (!fa.has(f)) out.push(`${label}: extra FK ${f} in ${bn}`);
  return out;
}

/** Declared types and FK actions in the generated SQL (parsed back) must match what the engine reports. */
function typesAndActions(declared: Schema, live: Schema, engine: ExportDialect): string[] {
  const out: string[] = [];
  const fam = engineOf(engine);
  const key = (t: { schema: string; name: string }) => (fam === 'postgres' || fam === 'mssql' ? `${t.schema}.${t.name}` : t.name).toLowerCase();
  const liveT = new Map(live.tables.map((t) => [key(t), t]));
  const canon = (t: string) => {
    let x = norm(t);
    if (fam === 'mssql') x = x.replace(/^(datetime2|datetimeoffset|time)\(7\)$/, '$1');
    if (fam === 'mysql') x = x.replace(/^(boolean|bool)$/, 'tinyint(1)');
    if (fam === 'mysql' && isMaria) x = x.replace(/^json$/, 'longtext'); // MariaDB's JSON is an alias of LONGTEXT + JSON_VALID
    if (engine === 'postgres')
      x = x
        .replace(/^timestamptz/, 'timestampwithtimezone')
        .replace(/^timestamp(\(\d\))?$/, 'timestamp$1withouttimezone')
        .replace(/^int$|^integer$|^serial$/, 'integer')
        .replace(/^bigserial$/, 'bigint')
        .replace(/^varchar/, 'charactervarying')
        .replace(/^boolean$/, 'boolean')
        .replace(/^double precision$/, 'doubleprecision');
    return x;
  };
  for (const t of declared.tables) {
    const lt = liveT.get(key(t));
    if (!lt) continue;
    for (const c of t.columns) {
      const lc = lt.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      if (!lc) continue;
      if (engine === 'postgres') continue; // PG output = PG source types, verified by the PG integration test
      if (canon(c.type) !== canon(lc.type)) out.push(`type ${t.name}.${c.name}: declared ${c.type}, engine has ${lc.type}`);
    }
  }
  const fkKey = (s: Schema, r: Schema['relations'][number]) => {
    const f = s.tables.find((t) => t.id === r.fromTable)!;
    return `${key(f)}(${r.fromColumns.map((id) => f.columns.find((c) => c.id === id)!.name.toLowerCase())})`;
  };
  const liveFk = new Map(live.relations.map((r) => [fkKey(live, r), r]));
  for (const r of declared.relations) {
    const lr = liveFk.get(fkKey(declared, r));
    if (!lr) continue;
    const a = (x?: string) => (!x || x === 'RESTRICT' ? 'NO ACTION' : x);
    if (a(r.onDelete) !== a(lr.onDelete) || a(r.onUpdate) !== a(lr.onUpdate))
      out.push(`FK ${fkKey(declared, r)}: declared ${a(r.onDelete)}/${a(r.onUpdate)}, engine has ${a(lr.onDelete)}/${a(lr.onUpdate)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data checks: defaults produce values, cascades delete, enum constraints reject bad values.

async function query(engine: ExportDialect, db: string, text: string): Promise<Record<string, unknown>[]> {
  switch (engineOf(engine)) {
    case 'postgres': {
      const c = new Client({ connectionString: `${PG_URL}/${db}` });
      await c.connect();
      try {
        return (await c.query(text)).rows;
      } finally {
        await c.end();
      }
    }
    case 'mssql': {
      const u = new URL(msUrl(engine));
      const pool = await new sql.ConnectionPool({
        server: u.hostname,
        port: Number(u.port),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: db,
        options: { encrypt: false, trustServerCertificate: true },
      }).connect();
      try {
        return (await pool.request().query(text)).recordset ?? [];
      } finally {
        await pool.close();
      }
    }
    case 'mysql': {
      const c = await mysql.createConnection(`${MYSQL_URL}/${db}`);
      try {
        const [rows] = await c.query(text);
        return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      } finally {
        await c.end();
      }
    }
    case 'sqlite': {
      const d = sqliteDbs.get(db)!;
      const res = d.exec(text);
      if (!res.length) return [];
      return res[0].values.map((row) => Object.fromEntries(res[0].columns.map((c, i) => [c, row[i]])));
    }
  }
}

async function dataChecks(engine: ExportDialect, db: string): Promise<string[]> {
  const problems: string[] = [];
  const t = (schema: string, name: string) =>
    ({
      postgres: `${schema === 'public' ? 'public' : schema}."${name}"`,
      mssql: `[${schema === 'public' ? 'dbo' : schema}].[${name}]`,
      mysql: `\`${name === 'users' && schema === 'app' ? 'app_users' : name}\``,
      sqlite: `"${name === 'users' && schema === 'app' ? 'app_users' : name}"`,
    })[engineOf(engine)];
  const s = (v: string) => (engineOf(engine) === 'mssql' ? `N'${v}'` : `'${v}'`);

  await query(engine, db, `INSERT INTO ${t('public', 'users')} (email) VALUES (${s('x@example.com')})`);
  const [row] = await query(engine, db, `SELECT id, active, small, prefs, tags, created_at FROM ${t('public', 'users')}`);
  const id = String(row?.id ?? '');
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) problems.push(`data: generated uuid default looks wrong: "${id}"`);
  if (!(row?.active === true || row?.active === 1)) problems.push(`data: boolean default true became ${JSON.stringify(row?.active)}`);
  if (Number(row?.small) !== -1) problems.push(`data: default -1 became ${JSON.stringify(row?.small)}`);
  const prefs = typeof row?.prefs === 'string' ? row.prefs : JSON.stringify(row?.prefs);
  if (prefs.replace(/\s/g, '') !== '{}') problems.push(`data: json default '{}' became ${prefs}`);
  if (!row?.created_at) problems.push('data: timestamp default now() produced no value');

  await query(engine, db, `INSERT INTO ${t('app', 'a')} (id) VALUES (1)`);
  await query(engine, db, `INSERT INTO ${t('app', 'b')} (id, a_id) VALUES (10, 1)`);
  await query(engine, db, `DELETE FROM ${t('app', 'a')} WHERE id = 1`);
  const [cnt] = await query(engine, db, `SELECT COUNT(*) AS n FROM ${t('app', 'b')}`);
  if (Number(cnt?.n) !== 0) problems.push('data: ON DELETE CASCADE from a to b did not delete the child row');

  let rejected = false;
  try {
    await query(engine, db, `INSERT INTO ${t('app', 'users')} (status) VALUES (${s('bogus')})`);
  } catch {
    rejected = true;
  }
  if (!rejected) problems.push("data: enum/CHECK accepted the invalid value 'bogus'");
  return problems;
}

/** uuidv7 default, vector values, json default, cascade; the virtual generated column on PostgreSQL. */
async function dataChecksLatest(engine: ExportDialect, db: string): Promise<string[]> {
  const problems: string[] = [];
  const fam = engineOf(engine);
  const t = (name: string) => ({ postgres: `public."${name}"`, mssql: `[dbo].[${name}]`, mysql: `\`${name}\``, sqlite: `"${name}"` })[fam];
  const s = (v: string) => (fam === 'mssql' ? `N'${v}'` : `'${v}'`);
  await query(engine, db, `INSERT INTO ${t('docs')} (title, embedding, price) VALUES (${s('a')}, '[1,2,3]', 10)`);
  const [doc] = await query(engine, db, `SELECT * FROM ${t('docs')}`);
  const id = String(doc?.id ?? '');
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) problems.push(`data: uuid default looks wrong: "${id}"`);
  if (fam === 'postgres' && id[14] !== '7') problems.push(`data: PostgreSQL 18 uuidv7() should give a version-7 uuid, got ${id}`);
  const body = typeof doc?.body === 'string' ? doc.body : JSON.stringify(doc?.body);
  if (body.replace(/\s/g, '') !== '{}') problems.push(`data: json default '{}' became ${body}`);
  const emb = String(typeof doc?.embedding === 'string' ? doc.embedding : JSON.stringify(doc?.embedding)).replace(/\s|\.0+(?=[,\]])|e\+0+/g, '');
  if (!/^\[1(\.0*)?,2(\.0*)?,3(\.0*)?\]$/.test(emb)) problems.push(`data: vector [1,2,3] read back as ${emb}`);
  if (fam === 'postgres' && Number(doc?.price_with_tax) !== 11.5) problems.push(`data: virtual generated column gave ${doc?.price_with_tax}`);
  const idLit = fam === 'mssql' ? `'${id}'` : `'${id}'`;
  await query(engine, db, `INSERT INTO ${t('chunks')} (doc_id, n, embedding) VALUES (${idLit}, 1, '[0.5,0.25,1]')`);
  await query(engine, db, `DELETE FROM ${t('docs')}`);
  const [cnt] = await query(engine, db, `SELECT COUNT(*) AS n FROM ${t('chunks')}`);
  if (Number(cnt?.n) !== 0) problems.push('data: ON DELETE CASCADE docs → chunks did not delete the chunk');
  return problems;
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = process.env.ENGINES ? process.env.ENGINES.split(',').map((x) => x.trim()) : undefined;
  const engines = [pgEngine, mssqlEngine('mssql'), ...(MSSQL2025_URL ? [mssqlEngine('mssql2025')] : []), mysqlEngine, sqliteEngine].filter(
    (e) => !only || only.includes(e.id),
  );
  let failures = 0;
  for (const input of inputs) {
    for (const engine of engines) {
      const label = `${input.name} → ${engine.id}`;
      if (input.name === 'latest-features' && engine.id === 'postgres') {
        const c = new Client({ connectionString: `${PG_URL}/postgres` });
        await c.connect();
        const num = Number((await c.query('SHOW server_version_num')).rows[0].server_version_num);
        const vec = (await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rowCount;
        await c.end();
        if (num < 180000 || !vec) {
          console.log(`SKIP ${label}: needs PostgreSQL 18 with pgvector (server is ${num}${vec ? '' : ', no pgvector'})`);
          continue;
        }
      }
      const ddl = generateSchemaSql(input.schema, engine.id, { sourceLabel: input.name });
      const file = path.join(OUT_DIR, `${input.name}.${engine.id}.sql`);
      fs.writeFileSync(file, ddl);
      let live: Schema;
      try {
        live = await engine.run(`erd_${input.name.replace(/-/g, '_')}`, ddl);
      } catch (e) {
        failures++;
        const pre = ((e as { precedingErrors?: { message: string }[] }).precedingErrors ?? []).map((x) => x.message);
        console.log(`FAIL ${label}: engine rejected the SQL: ${[...pre, (e as Error).message.split('\n')[0]].join(' / ')}`);
        continue;
      }
      const flatten = engine.id === 'mysql' || engine.id === 'sqlite';
      const family = engineOf(engine.id);
      const problems = [
        ...diff(
          'model vs engine',
          structure(input.schema, { flatten, withDefaults: true, isModel: true, pg: engine.id === 'postgres' }),
          structure(live, { flatten, withDefaults: true, isModel: false, pg: engine.id === 'postgres' }),
          'model',
          engine.id,
        ),
        ...typesAndActions(parseSql([{ name: file, content: ddl }], { dialect: family as Dialect }).schema, live, engine.id),
      ];
      // Expected, documented differences
      const filtered = problems;
      if (input.name === 'latest-features') {
        try {
          filtered.push(...(await dataChecksLatest(engine.id, `erd_${input.name.replace(/-/g, '_')}`)));
        } catch (e) {
          filtered.push(`data check crashed: ${(e as Error).message}`);
        }
      }
      if (input.name === 'edge-cases') {
        try {
          filtered.push(...(await dataChecks(engine.id, `erd_${input.name.replace(/-/g, '_')}`)));
        } catch (e) {
          filtered.push(`data check crashed: ${(e as Error).message}`);
        }
      }
      const notes = (ddl.match(/^--   .*/gm) ?? []).length;
      if (filtered.length) {
        failures++;
        console.log(`FAIL ${label}: ${filtered.length} problem(s)`);
        for (const p of filtered.slice(0, 15)) console.log(`     ${p}`);
      } else
        console.log(
          `PASS ${label}: ${live.tables.length} tables, ${live.relations.length} FKs created and verified${notes ? ` (${notes} conversion note${notes === 1 ? '' : 's'})` : ''}`,
        );
      if (!KEEP) fs.rmSync(file);
    }
  }
  console.log(`Engines: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
