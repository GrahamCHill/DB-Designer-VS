import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseSql } from '../src/shared/sqlParser';
import { applyOps, describeOp, sanitizeOps } from '../src/shared/ops';
import { buildUserPrompt, extractJson, toReview } from '../src/shared/ai';
import { generateDiffSql } from '../src/shared/pgExport';
import { buildStandaloneHtml } from '../src/standalone';
import { cloneSchema } from '../src/shared/model';

const base = () =>
  parseSql([
    {
      name: 'x.sql',
      content: `
        CREATE TABLE app.customers (id uuid PRIMARY KEY, name text NOT NULL, phone1 text, phone2 text, city text, city_postcode text);
        CREATE TABLE app.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_name text, total numeric(12,2));
      `,
    },
  ]).schema;

test('applyOps: normalise repeating groups and add a missing FK', () => {
  const s = base();
  const before = cloneSchema(s);
  const errors = applyOps(s, [
    {
      op: 'add_table',
      table: 'app.customer_phones',
      columns: [
        { name: 'id', type: 'bigint', primary_key: true },
        { name: 'customer_id', type: 'uuid', nullable: false },
        { name: 'phone', type: 'text', nullable: false },
      ],
    },
    { op: 'add_foreign_key', table: 'app.customer_phones', columns: ['customer_id'], ref_table: 'app.customers', ref_columns: ['id'], on_delete: 'CASCADE' },
    { op: 'drop_column', table: 'app.customers', column: 'phone1' },
    { op: 'drop_column', table: 'customers', column: 'phone2' },
    { op: 'add_column', table: 'app.orders', column: { name: 'customer_id', type: 'uuid' } },
    { op: 'add_foreign_key', table: 'app.orders', columns: ['customer_id'], ref_table: 'app.customers', ref_columns: [] },
    { op: 'drop_column', table: 'app.orders', column: 'customer_name' },
    { op: 'rename_column', table: 'app.orders', column: 'total', new_name: 'total_amount' },
    { op: 'alter_column', table: 'app.customers', column: 'name', unique: true },
  ]);
  assert.deepEqual(errors, []);
  const phones = s.tables.find((t) => t.name === 'customer_phones')!;
  assert.equal(phones.schema, 'app');
  assert.equal(phones.columns[0].pk, true);
  assert.equal(s.relations.length, 2);
  assert.equal(s.relations.find((r) => r.fromTable === phones.id)!.onDelete, 'CASCADE');

  const sql = generateDiffSql(before, s);
  assert.match(sql, /CREATE TABLE app\.customer_phones/);
  assert.match(sql, /ALTER TABLE app\.customers DROP COLUMN IF EXISTS phone1;/);
  assert.match(sql, /ALTER TABLE app\.orders RENAME COLUMN total TO total_amount;/);
  assert.match(sql, /ADD CONSTRAINT customers_name_key UNIQUE \(name\)/);
  assert.match(sql, /FOREIGN KEY \(customer_id\) REFERENCES app\.customers \(id\) ON DELETE CASCADE/);
});

test('applyOps: reports problems without throwing, referencing a non-key column makes it unique', () => {
  const s = base();
  const errors = applyOps(s, [
    { op: 'drop_column', table: 'app.nope', column: 'x' },
    { op: 'drop_column', table: 'app.orders', column: 'nope' },
    { op: 'add_table', table: 'app.orders', columns: [{ name: 'id', type: 'int' }] },
    { op: 'add_foreign_key', table: 'app.orders', columns: ['customer_name'], ref_table: 'app.customers', ref_columns: ['name'] },
  ]);
  assert.equal(errors.length, 3);
  assert.equal(s.tables.find((t) => t.name === 'customers')!.columns.find((c) => c.name === 'name')!.unique, true);
  assert.equal(s.relations.length, 1);
});

test('sanitizeOps: accepts the flat structured-output shape and rejects junk', () => {
  const { ops, problems } = sanitizeOps([
    { op: 'add_table', table: 'app.cities', column_defs: [{ name: 'id', type: 'serial', primary_key: true }, { name: 'name', type: 'text' }] },
    { op: 'add_column', table: 'app.customers', column_defs: [{ name: 'city_id', type: 'integer' }] },
    { op: 'add_foreign_key', table: 'app.customers', column: 'city_id', ref_table: 'app.cities', ref_columns: ['id'], on_delete: 'set_null' },
    { op: 'explode', table: 'x' },
    { op: 'drop_column', table: 'x' },
  ]);
  assert.equal(ops.length, 3);
  assert.equal(problems.length, 2);
  assert.deepEqual(ops[2], {
    op: 'add_foreign_key',
    table: 'app.customers',
    columns: ['city_id'],
    ref_table: 'app.cities',
    ref_columns: ['id'],
    on_delete: 'SET NULL',
    on_update: undefined,
  });
  assert.match(describeOp(ops[0]), /Create table app\.cities \(id serial PK, name text\)/);
});

test('AI reply parsing: fenced JSON, sanitised operations, prompt contains DDL', () => {
  const reply =
    'Here you go:\n```json\n' +
    JSON.stringify({
      summary: 'Mostly fine.',
      suggestions: [
        {
          title: 'Split phone numbers',
          severity: 'HIGH',
          category: '1NF',
          tables: ['app.customers'],
          explanation: 'phone1/phone2 is a repeating group.',
          operations: [{ op: 'drop_column', table: 'app.customers', column: 'phone2' }, { op: 'bogus' }],
        },
      ],
    }) +
    '\n```';
  const review = toReview(extractJson(reply), 'test-model');
  assert.equal(review.suggestions.length, 1);
  assert.equal(review.suggestions[0].severity, 'high');
  assert.equal(review.suggestions[0].operations.length, 1);
  assert.equal(review.suggestions[0].problems?.length, 1);
  assert.throws(() => extractJson('no json here'));

  const prompt = buildUserPrompt({ schema: base(), focus: 'phones' });
  assert.match(prompt, /CREATE TABLE app\.customers/);
  assert.match(prompt, /focus on: phones/);
  const s = base();
  const narrowed = buildUserPrompt({ schema: s, tableIds: [s.tables[1].id] });
  assert.doesNotMatch(narrowed, /CREATE TABLE app\.customers/);
});

test('standalone HTML embeds data safely', () => {
  const s = base();
  s.tables[0].comment = 'evil </script><script>alert(1)</script>   line';
  const html = buildStandaloneHtml(
    { format: 'erd-viewer', version: 1, title: 'A <b>title</b>', savedAt: new Date().toISOString(), schema: s, layout: {} },
    'console.log("</script>")',
    'body{}',
  );
  assert.equal((html.match(/<\/script>/g) ?? []).length, 3, 'only the 3 real closing tags');
  assert.match(html, /<title>A &lt;b&gt;title&lt;\/b&gt; · ERD<\/title>/);
  const json = /window\.__ERD_LOAD__ = (.*);<\/script>/.exec(html)![1];
  const load = JSON.parse(json);
  assert.equal(load.mode, 'standalone');
  assert.equal(load.working.tables[0].comment, s.tables[0].comment);
});
