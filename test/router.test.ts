import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Rect, crosses, roundedPath, routeOrthogonal } from '../src/webview/router';
import { autoLayout, nodeHeight, NODE_WIDTH } from '../src/webview/layout';
import { edgeSidesFor } from '../src/webview/edgeGeometry';
import { parseSql } from '../src/shared/sqlParser';

test('routes around a table that sits between the two ends', () => {
  const block: Rect = { x1: 250, y1: 0, x2: 350, y2: 300 };
  const pts = routeOrthogonal({ x: 0, y: 100 }, 'R', { x: 600, y: 100 }, 'L', [block])!;
  assert.ok(pts, 'a route exists');
  assert.equal(crosses(pts, { x1: block.x1 - 1, y1: block.y1 - 1, x2: block.x2 + 1, y2: block.y2 + 1 }), false);
  assert.deepEqual(pts[0], { x: 0, y: 100 });
  assert.deepEqual(pts[pts.length - 1], { x: 600, y: 100 });
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, 'orthogonal segments');
  assert.match(roundedPath(pts), /^M0 100 .* L600 100$/);
});

test('straight line when nothing is in the way; self-reference loops outside the table', () => {
  const pts = routeOrthogonal({ x: 0, y: 50 }, 'R', { x: 400, y: 50 }, 'L', [])!;
  assert.equal(pts.length, 2);
  const table: Rect = { x1: 100, y1: 100, x2: 380, y2: 400 };
  const self = routeOrthogonal({ x: 385, y: 150 }, 'R', { x: 385, y: 300 }, 'R', [table])!;
  assert.ok(self && !crosses(self, table));
});

const SAMPLE = path.resolve(__dirname, '..', '../MPUDOH-ContractManagementTool/db');
test('real schema: no routed line passes under a table', { skip: !fs.existsSync(SAMPLE) && 'sample not present' }, () => {
  const files = fs
    .readdirSync(SAMPLE)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(SAMPLE, f), 'utf8') }));
  const schema = parseSql(files).schema;
  const pos = autoLayout(schema.tables, schema);
  const box = new Map(schema.tables.map((t) => [t.id, { x: pos[t.id].x, y: pos[t.id].y, w: NODE_WIDTH, h: nodeHeight(t) }]));
  const rects: Rect[] = schema.tables.map((t) => {
    const b = box.get(t.id)!;
    return { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h };
  });
  let routed = 0;
  let fallback = 0;
  const t0 = Date.now();
  for (const r of schema.relations) {
    const parent = schema.tables.find((t) => t.id === r.toTable)!;
    const child = schema.tables.find((t) => t.id === r.fromTable)!;
    const g = edgeSidesFor(parent, box.get(parent.id)!, r.toColumns[0], child, box.get(child.id)!, r.fromColumns[0], parent === child);
    const pts = routeOrthogonal(g.source, g.sSide, g.target, g.tSide, rects);
    if (!pts) {
      fallback++;
      continue;
    }
    routed++;
    for (const rect of rects) assert.equal(crosses(pts, rect), false, `${child.name} → ${parent.name} crosses a table`);
  }
  const ms = Date.now() - t0;
  assert.ok(routed >= schema.relations.length * 0.95, `routed ${routed}/${schema.relations.length} (fallback ${fallback})`);
  assert.ok(ms < 8000, `routing all ${schema.relations.length} relations took ${ms} ms`);
});
