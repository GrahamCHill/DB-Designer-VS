// Manual end-to-end check of the AI review against a real model (not part of npm test).
// Usage: node dist-test/ai-e2e.js <provider> <model>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const [, , provider = 'ollama', model = 'qwen2.5-coder:3b'] = process.argv;
const settings: Record<string, string> = { provider, ollamaModel: model, anthropicModel: model, vscodeModel: '', openaiModel: model, openaiBaseUrl: process.argv[4] ?? 'http://localhost:11434/v1' };
class CancellationError extends Error {}
const stub = {
  workspace: { getConfiguration: () => ({ get: (k: string) => settings[k], update: async () => undefined }) },
  window: { showQuickPick: async () => undefined, showInputBox: async () => undefined, showInformationMessage: () => undefined },
  CancellationError,
  ConfigurationTarget: { Global: 1 },
};
const load = Module._load;
Module._load = function (r: string, ...a: unknown[]) {
  return r === 'vscode' ? stub : load.call(this, r, ...a);
};

async function main() {
  const { runReview } = await import('../src/ai/providers');
  const { parseSql } = await import('../src/shared/sqlParser');
  const { applyOps, describeOp } = await import('../src/shared/ops');
  const { cloneSchema } = await import('../src/shared/model');
  const { generateDiffSql } = await import('../src/shared/pgExport');
  const schema = parseSql([
    {
      name: 'shop.sql',
      content: `
      CREATE TABLE public.customers (id serial PRIMARY KEY, full_name text NOT NULL, phone1 text, phone2 text, phone3 text,
        city text, province text, postal_code text);
      CREATE TABLE public.orders (id serial PRIMARY KEY, customer_id int, customer_name text, customer_city text,
        product_names text, order_date text, total text);
      CREATE TABLE public.products (id serial PRIMARY KEY, name text, category_name text, category_description text, price numeric(10,2));`,
    },
  ]).schema;
  const t0 = Date.now();
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const out = { appendLine: (s: string) => console.log(s) };
  const secrets = { get: async () => undefined, store: async () => undefined };
  const review = await runReview({ schema }, secrets as never, token as never, out as never);
  console.log(`\n${review.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s\nSUMMARY: ${review.summary}\n`);
  const working = cloneSchema(schema);
  for (const s of review.suggestions) {
    console.log(`[${s.severity}/${s.category}] ${s.title}  (tables: ${s.tables.join(', ')})`);
    for (const o of s.operations) console.log(`    - ${describeOp(o)}`);
    if (s.problems) console.log(`    ! invalid ops dropped: ${s.problems.join('; ')}`);
    const errs = applyOps(working, s.operations);
    if (errs.length) console.log(`    ! apply errors: ${errs.join('; ')}`);
  }
  console.log('\n--- migration after applying everything ---\n' + generateDiffSql(schema, working));
}
main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
