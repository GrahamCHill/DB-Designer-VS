import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseSql } from '../src/shared/sqlParser';
import { Schema, Table } from '../src/shared/model';

const parse = (sql: string | string[], dialect?: NonNullable<Parameters<typeof parseSql>[1]>['dialect']) =>
  parseSql(
    (Array.isArray(sql) ? sql : [sql]).map((content, i) => ({ name: `f${i}.sql`, content })),
    { dialect },
  );

function table(s: Schema, name: string): Table {
  const t = s.tables.find((x) => `${x.schema}.${x.name}` === name || x.name === name);
  assert.ok(t, `table ${name} exists (have: ${s.tables.map((x) => `${x.schema}.${x.name}`).join(', ')})`);
  return t!;
}
function col(t: Table, name: string) {
  const c = t.columns.find((x) => x.name === name);
  assert.ok(c, `column ${t.name}.${name} exists (have: ${t.columns.map((x) => x.name).join(', ')})`);
  return c!;
}
function fk(s: Schema, from: string, fromCol: string) {
  const ft = table(s, from);
  const c = col(ft, fromCol);
  const r = s.relations.find((x) => x.fromTable === ft.id && x.fromColumns.includes(c.id));
  assert.ok(r, `FK on ${from}.${fromCol}`);
  const tt = s.tables.find((x) => x.id === r!.toTable)!;
  return { rel: r!, to: tt, toCols: r!.toColumns.map((id) => tt.columns.find((x) => x.id === id)!.name) };
}

test('postgres CREATE TABLE with inline and table constraints', () => {
  const { schema, warnings } = parse(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      tags text[] DEFAULT '{}'::text[],
      amount NUMERIC(18, 2),
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Closed'))
    );
    CREATE TABLE app.user_roles (
      user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
      role_id int NOT NULL,
      CONSTRAINT user_roles_pk PRIMARY KEY (user_id, role_id)
    );
  `);
  assert.deepEqual(warnings, []);
  const u = table(schema, 'app.users');
  assert.equal(col(u, 'id').pk, true);
  assert.equal(col(u, 'id').type, 'uuid');
  assert.equal(col(u, 'id').default, 'uuid_generate_v4()');
  assert.equal(col(u, 'email').unique, true);
  assert.equal(col(u, 'email').nullable, false);
  assert.equal(col(u, 'created_at').type, 'timestamp with time zone');
  assert.equal(col(u, 'tags').type, 'text[]');
  assert.equal(col(u, 'amount').type, 'numeric(18,2)');
  assert.equal(col(u, 'status').default, "'Active'");
  const ur = table(schema, 'app.user_roles');
  assert.deepEqual(ur.columns.filter((c) => c.pk).map((c) => c.name), ['user_id', 'role_id']);
  assert.equal(ur.pkName, 'user_roles_pk');
  const f = fk(schema, 'app.user_roles', 'user_id');
  assert.equal(f.to.name, 'users');
  assert.deepEqual(f.toCols, ['id']);
  assert.equal(f.rel.onDelete, 'CASCADE');
});

test('migrations: ALTER TABLE add/drop/rename, DO blocks, search_path, comments', () => {
  const { schema } = parse([
    `CREATE TABLE app.files (id uuid PRIMARY KEY);
     CREATE TABLE app.contracts (id uuid PRIMARY KEY, old_name text, legacy int);`,
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contracts' AND column_name = 'pdf_file_id') THEN
         ALTER TABLE app.contracts ADD COLUMN pdf_file_id UUID NULL REFERENCES app.files(id) ON DELETE SET NULL;
       END IF;
     END $$;`,
    `ALTER TABLE app.contracts RENAME COLUMN old_name TO new_name;
     ALTER TABLE app.contracts DROP COLUMN IF EXISTS legacy;
     ALTER TABLE app.contracts ADD COLUMN IF NOT EXISTS a int, ADD COLUMN IF NOT EXISTS b text NOT NULL DEFAULT 'x';
     ALTER TABLE app.contracts ALTER COLUMN a SET NOT NULL, ALTER COLUMN a TYPE bigint USING a::bigint;
     COMMENT ON TABLE app.contracts IS 'All contracts';
     COMMENT ON COLUMN app.contracts.a IS 'The a';`,
    `SET search_path TO app, public;
     CREATE TABLE cms_cases (case_id text PRIMARY KEY, file_id uuid REFERENCES files(id));`,
    `CREATE TABLE plain (id serial PRIMARY KEY);`,
  ]);
  const c = table(schema, 'app.contracts');
  assert.deepEqual(
    c.columns.map((x) => x.name),
    ['id', 'new_name', 'pdf_file_id', 'a', 'b'],
  );
  assert.equal(col(c, 'a').type, 'bigint');
  assert.equal(col(c, 'a').nullable, false);
  assert.equal(col(c, 'a').comment, 'The a');
  assert.equal(c.comment, 'All contracts');
  assert.equal(fk(schema, 'app.contracts', 'pdf_file_id').rel.onDelete, 'SET NULL');
  // search_path puts the unqualified table into app and resolves the reference there
  assert.equal(table(schema, 'cms_cases').schema, 'app');
  assert.equal(fk(schema, 'cms_cases', 'file_id').to.schema, 'app');
  // search_path resets per file
  assert.equal(table(schema, 'plain').schema, 'public');
  assert.equal(col(table(schema, 'plain'), 'id').identity, true);
});

test('ALTER TABLE ADD CONSTRAINT / DROP CONSTRAINT / RENAME TO / SET SCHEMA / DROP TABLE', () => {
  const { schema } = parse(`
    CREATE TABLE a (id int);
    CREATE TABLE b (id int PRIMARY KEY, a_id int, code text);
    ALTER TABLE ONLY public.a ADD CONSTRAINT a_pkey PRIMARY KEY (id);
    ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a (id) ON UPDATE CASCADE;
    ALTER TABLE b ADD CONSTRAINT b_code_key UNIQUE (code);
    ALTER TABLE b DROP CONSTRAINT b_code_key;
    ALTER TABLE a RENAME TO parent;
    CREATE TABLE gone (id int);
    DROP TABLE IF EXISTS gone CASCADE;
    CREATE SCHEMA x;
    ALTER TABLE b SET SCHEMA x;
    CREATE UNIQUE INDEX IF NOT EXISTS b_code_idx ON x.b (code);
    CREATE UNIQUE INDEX b_partial ON x.b (a_id) WHERE a_id IS NOT NULL;
  `);
  assert.equal(schema.tables.length, 2);
  const p = table(schema, 'parent');
  assert.equal(col(p, 'id').pk, true);
  const b = table(schema, 'x.b');
  assert.equal(col(b, 'code').unique, true, 'unique index marks the column unique');
  assert.equal(b.uniqueIndexes?.[col(b, 'code').id], 'b_code_idx');
  assert.equal(col(b, 'a_id').unique, false, 'partial unique index ignored');
  const f = fk(schema, 'x.b', 'a_id');
  assert.equal(f.to.name, 'parent');
  assert.equal(f.rel.onUpdate, 'CASCADE');
  assert.equal(f.rel.name, 'b_a_fk');
});

test('FK without column list references the PK; dropping a referenced table drops the FK', () => {
  const { schema } = parse(`
    CREATE TABLE p (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    CREATE TABLE c (id int PRIMARY KEY, p_id bigint REFERENCES p);
    CREATE TABLE d (id int PRIMARY KEY, c_id int REFERENCES c(id));
    DROP TABLE d;
  `);
  assert.equal(col(table(schema, 'p'), 'id').identity, true);
  assert.deepEqual(fk(schema, 'c', 'p_id').toCols, ['id']);
  assert.equal(schema.relations.length, 1);
});

test('SQL Server DDL', () => {
  const { schema, dialect } = parse(`
    CREATE TABLE [dbo].[Customers] (
      [Id] INT IDENTITY(1,1) NOT NULL,
      [Name] NVARCHAR(200) NOT NULL,
      [Created] DATETIME2 NOT NULL CONSTRAINT DF_Customers_Created DEFAULT (GETDATE()),
      CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([Id] ASC) WITH (PAD_INDEX = OFF) ON [PRIMARY]
    ) ON [PRIMARY]
    GO
    CREATE TABLE [dbo].[Orders] (
      [Id] INT IDENTITY(1,1) PRIMARY KEY,
      [CustomerId] INT NOT NULL,
      [Total] DECIMAL(10, 2) NULL
    )
    GO
    ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerId]) REFERENCES [dbo].[Customers] ([Id])
    GO
    ALTER TABLE [dbo].[Orders] ADD [Note] NVARCHAR(MAX) NULL, [Flag] BIT NOT NULL
    GO
  `);
  assert.equal(dialect, 'mssql');
  const cu = table(schema, 'dbo.Customers');
  assert.equal(col(cu, 'Id').pk, true);
  assert.equal(col(cu, 'Id').identity, true);
  assert.equal(col(cu, 'Name').type, 'nvarchar(200)');
  assert.equal(col(cu, 'Created').default, '(GETDATE())');
  assert.equal(cu.pkName, 'PK_Customers');
  const o = table(schema, 'dbo.Orders');
  assert.deepEqual(o.columns.map((c) => c.name), ['Id', 'CustomerId', 'Total', 'Note', 'Flag']);
  assert.equal(fk(schema, 'dbo.Orders', 'CustomerId').to.name, 'Customers');
});

test('SQL Server: WITH CHECK before ADD is handled', () => {
  // `ALTER TABLE t WITH CHECK ADD CONSTRAINT` – the WITH CHECK prefix must not hide the action.
  const { schema } = parse(
    `CREATE TABLE [a] ([id] int PRIMARY KEY)
     GO
     CREATE TABLE [b] ([id] int PRIMARY KEY, [a_id] int)
     GO
     ALTER TABLE [b] WITH NOCHECK ADD CONSTRAINT [fk] FOREIGN KEY ([a_id]) REFERENCES [a]([id])
     GO`,
    'mssql',
  );
  assert.equal(schema.relations.length, 1);
});

test('MySQL DDL', () => {
  const { schema, dialect } = parse(`
    CREATE TABLE \`authors\` (
      \`id\` int unsigned NOT NULL AUTO_INCREMENT,
      \`name\` varchar(100) NOT NULL COMMENT 'Display name',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_name\` (\`name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Authors';
    CREATE TABLE \`books\` (
      \`id\` int unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`author_id\` int unsigned NOT NULL,
      \`title\` varchar(255) CHARACTER SET utf8mb4 NOT NULL,
      KEY \`idx_author\` (\`author_id\`),
      CONSTRAINT \`fk_books_author\` FOREIGN KEY (\`author_id\`) REFERENCES \`authors\` (\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);
  assert.equal(dialect, 'mysql');
  const a = table(schema, 'authors');
  assert.equal(col(a, 'id').identity, true);
  assert.equal(col(a, 'id').type, 'int unsigned');
  assert.equal(col(a, 'name').unique, true);
  assert.equal(col(a, 'name').comment, 'Display name');
  assert.equal(a.comment, 'Authors');
  assert.equal(col(table(schema, 'books'), 'title').type, 'varchar(255)');
  assert.equal(fk(schema, 'books', 'author_id').rel.onDelete, 'CASCADE');
});

test('SQLite DDL', () => {
  const { schema, dialect } = parse(`
    CREATE TABLE artist (artistid INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE track (
      trackid INTEGER PRIMARY KEY,
      trackname TEXT,
      trackartist INTEGER,
      FOREIGN KEY(trackartist) REFERENCES artist(artistid)
    ) WITHOUT ROWID;
  `);
  assert.equal(dialect, 'sqlite');
  assert.equal(col(table(schema, 'artist'), 'artistid').identity, true);
  assert.equal(fk(schema, 'track', 'trackartist').to.name, 'artist');
});

test('comments, strings and dollar quotes do not confuse the splitter', () => {
  const { schema } = parse(`
    -- CREATE TABLE commented_out (id int);
    /* CREATE TABLE also_commented (id int); /* nested */ still comment */
    CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $body$
    BEGIN
      CREATE TABLE inside_function (id int);
      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql;
    CREATE TABLE real_one (id int PRIMARY KEY, note text DEFAULT 'semi;colon -- not a comment');
    INSERT INTO real_one VALUES (1, 'CREATE TABLE nope (id int);');
  `);
  assert.deepEqual(schema.tables.map((t) => t.name), ['real_one']);
  assert.equal(col(table(schema, 'real_one'), 'note').default, "'semi;colon -- not a comment'");
});

test('DO blocks: to_regclass guards are evaluated, other guards assumed true', () => {
  const { schema } = parse([
    `CREATE TABLE app.users (id uuid PRIMARY KEY);
     CREATE TABLE public.things (id int PRIMARY KEY);`,
    `DO $$
     BEGIN
       IF to_regclass('public.users') IS NOT NULL THEN
         ALTER TABLE users ADD COLUMN IF NOT EXISTS skipped text;
         CREATE TABLE IF NOT EXISTS skipped_table (id int);
       ELSE
         CREATE TABLE IF NOT EXISTS else_table (id int);
       END IF;
       IF to_regclass('app.users') IS NOT NULL THEN
         ALTER TABLE app.users ADD COLUMN IF NOT EXISTS kept text;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE column_name = 'flag') THEN
         ALTER TABLE things ADD COLUMN flag boolean;
       END IF;
     END $$;`,
  ]);
  assert.deepEqual(schema.tables.map((t) => t.name).sort(), ['else_table', 'things', 'users']);
  assert.deepEqual(table(schema, 'app.users').columns.map((c) => c.name), ['id', 'kept']);
  assert.ok(col(table(schema, 'things'), 'flag'));
});

test('postgres: unqualified names resolve strictly through search_path', () => {
  const { schema, warnings } = parse(`
    CREATE TABLE app.users (id uuid PRIMARY KEY);
    CREATE TABLE notes (id int PRIMARY KEY, user_id uuid REFERENCES users(id));
  `);
  assert.equal(schema.relations.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /users not found/);
});

test('enum types: created in DO blocks, extended with ALTER TYPE, exported', () => {
  const { schema } = parse(`
    CREATE SCHEMA ocr;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
        CREATE TYPE ocr.task_status AS ENUM ('PENDING', 'DONE');
      END IF;
    END $$;
    ALTER TYPE ocr.task_status ADD VALUE IF NOT EXISTS 'FAILED';
    ALTER TYPE ocr.task_status ADD VALUE 'RUNNING' BEFORE 'DONE';
    CREATE DOMAIN email AS text CHECK (VALUE ~ '@');
    CREATE TABLE ocr.tasks (id int PRIMARY KEY, status ocr.task_status NOT NULL DEFAULT 'PENDING', owner email);
  `);
  assert.deepEqual(schema.types?.find((t) => t.name === 'task_status')?.values, ['PENDING', 'RUNNING', 'DONE', 'FAILED']);
  assert.equal(schema.types?.find((t) => t.name === 'email')?.kind, 'domain');
  assert.equal(col(table(schema, 'ocr.tasks'), 'status').type, 'ocr.task_status');
});

// Sample repositories next to this one (skipped when absent).
const SAMPLES = [
  { dir: '../MPUDOH-ContractManagementTool/db', minTables: 90, minRelations: 120 },
  { dir: '../MPUDOH-Case-Management-System/db', minTables: 29, minRelations: 21 },
];
for (const s of SAMPLES) {
  const dir = path.resolve(__dirname, '..', s.dir);
  test(`sample: ${s.dir}`, { skip: !fs.existsSync(dir) && 'sample folder not present' }, () => {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const res = parseSql(files);
    assert.equal(res.dialect, 'postgres');
    assert.ok(res.schema.tables.length >= s.minTables, `tables: ${res.schema.tables.length}`);
    assert.ok(res.schema.relations.length >= s.minRelations, `relations: ${res.schema.relations.length}`);
    assert.deepEqual(res.warnings, []);
    for (const t of res.schema.tables) assert.ok(t.columns.every((c) => c.type), `${t.name} has typed columns`);
  });
}
