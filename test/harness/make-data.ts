// Generates test/harness/data.js from a folder of .sql files for the browser harness.
import * as fs from 'fs';
import * as path from 'path';
import { parseSql } from '../../src/shared/sqlParser';

const dir = path.resolve(process.argv[2] ?? '../MPUDOH-ContractManagementTool/db'); // relative to the repo root
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
const res = parseSql(files);
const msg = {
  type: 'load',
  title: path.basename(path.dirname(dir)) + '/' + path.basename(dir),
  sourceLabel: `${files.length} SQL files · ${dir} · ${res.dialect}`,
  baseline: res.schema,
  working: res.schema,
  layout: {},
  warnings: res.warnings,
  readOnlySource: false,
};
fs.writeFileSync(path.resolve('test/harness/data.js'), `window.__ERD_LOAD__ = ${JSON.stringify(msg)};\n`);
console.log(`wrote data.js: ${res.schema.tables.length} tables`);
