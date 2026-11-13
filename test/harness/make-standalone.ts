// Builds test/harness/standalone.html from a SQL folder using the same code as "Share → Standalone viewer".
import * as fs from 'fs';
import * as path from 'path';
import { parseSql } from '../../src/shared/sqlParser';
import { buildStandaloneHtml } from '../../src/standalone';
const dir = path.resolve(process.argv[2] ?? '../MPUDOH-Case-Management-System/db');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
const { schema } = parseSql(files);
const html = buildStandaloneHtml(
  { format: 'erd-viewer', version: 1, title: path.basename(path.dirname(dir)), savedAt: new Date().toISOString(), source: dir, schema, layout: {} },
  fs.readFileSync('dist/webview.js', 'utf8'),
  fs.readFileSync('dist/webview.css', 'utf8'),
);
fs.writeFileSync('test/harness/standalone.html', html);
console.log(`standalone.html: ${schema.tables.length} tables, ${(html.length / 1024).toFixed(0)} KB`);
