import * as fs from 'fs';
import * as path from 'path';
import { parseSql } from '../src/shared/sqlParser';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const res = parseSql(files.map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') })));
const s = res.schema;
console.log('dialect', res.dialect, 'tables', s.tables.length, 'relations', s.relations.length, 'warnings', res.warnings.length);
const byId = new Map(s.tables.map((t) => [t.id, t]));
const verbose = process.argv[3] === '-v';
for (const t of s.tables) {
  console.log(`${t.schema}.${t.name} (${t.columns.length} cols, pk=${t.columns.filter((c) => c.pk).map((c) => c.name).join(',')})`);
  if (verbose) for (const c of t.columns) console.log(`   ${c.pk ? 'PK' : '  '} ${c.unique ? 'U' : ' '} ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ' = ' + c.default : ''}`);
}
for (const r of s.relations) {
  const f = byId.get(r.fromTable)!, t = byId.get(r.toTable)!;
  const fc = r.fromColumns.map((id) => f.columns.find((c) => c.id === id)!.name);
  const tc = r.toColumns.map((id) => t.columns.find((c) => c.id === id)!.name);
  console.log(`FK ${f.schema}.${f.name}(${fc}) -> ${t.schema}.${t.name}(${tc}) ${r.onDelete ?? ''}`);
}
for (const w of res.warnings) console.log('WARN', w);
