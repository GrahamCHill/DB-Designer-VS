import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Pt, Rect, RelationshipPath, crosses, orthogonalThrough, roundedPath, routeOrthogonal, routeRelationships, simplify, snap, toWaypoints } from '../src/webview/router';
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

test('a tall table is routed around beyond the default search bounds', () => {
  const wall = { x1: 240, y1: -800, x2: 520, y2: 900 };
  const route = routeOrthogonal({ x: 0.25, y: 40.2 }, 'R', { x: 760.25, y: 85.6 }, 'L', [wall]);
  assert.ok(route);
  assert.ok(!crosses(route, wall));
  assert.ok(route.some(({ y }) => y < wall.y1 || y > wall.y2));
  for (let i = 1; i < route.length; i++) {
    assert.ok(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y);
  }
});

test('an obstacle next to a port is avoided even if the default stub enters it', () => {
  const obstacles = [
    { x1: -100, y1: 0, x2: 0, y2: 190 },
    { x1: 25, y1: 0, x2: 130, y2: 190 },
  ];
  const route = routeOrthogonal({ x: 5, y: 80 }, 'R', { x: 300, y: 80 }, 'L', obstacles);
  assert.ok(route);
  assert.ok(obstacles.every((o) => !crosses(route, o)));
});

test('relationships sharing a corridor use separate lanes when there is room', () => {
  const obstacles = [{ x1: 170, y1: 0, x2: 400, y2: 240 }];
  const edges: RelationshipPath[] = [
    { id: 'a', source: { x: 0, y: 50 }, target: { x: 600, y: 50 }, sSide: 'R', tSide: 'L' },
    { id: 'b', source: { x: 0, y: 65 }, target: { x: 600, y: 65 }, sSide: 'R', tSide: 'L' },
  ];
  const routes = routeRelationships(edges, obstacles);
  const lane = (points: Pt[]) => points.slice(1).find((point, i) => point.y === points[i].y
    && Math.min(point.x, points[i].x) < 170 && Math.max(point.x, points[i].x) > 400)?.y;
  const a = routes.get('a');
  const b = routes.get('b');
  assert.ok(a && b);
  assert.ok(!crosses(a, obstacles[0]) && !crosses(b, obstacles[0]));
  const yA = lane(a);
  const yB = lane(b);
  assert.ok(yA !== undefined && yB !== undefined && Math.abs(yA - yB) >= 10, JSON.stringify([a, b]));
});

test('automatic lines avoid crossing an existing hand-shaped relationship', () => {
  const routes = routeRelationships([
    { id: 'manual', source: { x: 204, y: -40 }, target: { x: 204, y: 22 }, sSide: 'R', tSide: 'R', points: [{ x: 230, y: 0 }] },
    { id: 'auto', source: { x: 0, y: 0 }, target: { x: 350, y: 80 }, sSide: 'R', tSide: 'L' },
  ], []);
  const route = routes.get('auto');
  assert.ok(route);
  const firstTurn = route[1];
  assert.ok(firstTurn.x < 230, `expected the automatic line to turn before the manual one: ${JSON.stringify(route)}`);
});

test('auto layout gives disconnected sets of related tables separate space', () => {
  const { schema } = parseSql([{ name: 'components.sql', content: `
    CREATE TABLE a (id int PRIMARY KEY);
    CREATE TABLE b (id int PRIMARY KEY);
    CREATE TABLE a1 (parent int REFERENCES a(id));
    CREATE TABLE b1 (parent int REFERENCES b(id));
    CREATE TABLE a2 (parent int REFERENCES a(id));
    CREATE TABLE b2 (parent int REFERENCES b(id));
  ` }]);
  const positions = autoLayout(schema.tables, schema);
  const bounds = (prefix: string) => {
    const boxes = schema.tables.filter((t) => t.name.startsWith(prefix))
      .map((t) => ({ ...positions[t.id], bottom: positions[t.id].y + nodeHeight(t) }));
    return {
      x1: Math.min(...boxes.map((b) => b.x)), x2: Math.max(...boxes.map((b) => b.x + NODE_WIDTH)),
      y1: Math.min(...boxes.map((b) => b.y)), y2: Math.max(...boxes.map((b) => b.bottom)),
    };
  };
  const a = bounds('a');
  const b = bounds('b');
  assert.ok(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
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
  const edges = schema.relations.flatMap((r) => {
    const parent = schema.tables.find((t) => t.id === r.toTable)!;
    const child = schema.tables.find((t) => t.id === r.fromTable)!;
    return r.fromColumns.map((column, i) => ({
      id: `${r.id}::${i}`,
      ...edgeSidesFor(parent, box.get(parent.id)!, r.toColumns[i], child, box.get(child.id)!, column, parent === child),
    }));
  });
  const t0 = Date.now();
  const routes = routeRelationships(edges, rects);
  for (const [id, pts] of routes) {
    assert.ok(pts, `no route for ${id}`);
    for (const rect of rects) assert.equal(crosses(pts, rect), false, `${id} crosses a table`);
  }
  const ms = Date.now() - t0;
  assert.equal(routes.size, edges.length);
  assert.ok(ms < 8000, `routing all ${edges.length} column connections took ${ms} ms`);
});

test('manual routes: waypoints from a route reproduce it, and follow moved tables', () => {
  const s = { x: 0, y: 100 };
  const t = { x: 400, y: 300 };
  const obstacles = [{ x1: 120, y1: 40, x2: 280, y2: 360 }];
  const auto = routeOrthogonal(s, 'R', t, 'L', obstacles)!;
  assert.ok(auto.length >= 4);
  const w = toWaypoints(auto);
  assert.deepEqual(orthogonalThrough(s, 'R', w, t, 'L'), simplify(auto));
  // Tables moved: the line still starts and ends horizontally on the column rows.
  const s2 = { x: -40, y: 140 };
  const t2 = { x: 460, y: 260 };
  const moved = orthogonalThrough(s2, 'R', w, t2, 'L');
  assert.deepEqual(moved[0], s2);
  assert.deepEqual(moved[moved.length - 1], t2);
  assert.equal(moved[1].y, s2.y);
  assert.equal(moved[moved.length - 2].y, t2.y);
  for (let k = 1; k < moved.length; k++) assert.ok(moved[k].x === moved[k - 1].x || moved[k].y === moved[k - 1].y, 'orthogonal');
  // Z-shaped line (two corners) keeps its vertical position as one waypoint.
  const z = [s, { x: 200, y: 100 }, { x: 200, y: 300 }, t];
  assert.deepEqual(toWaypoints(z), [{ x: 200, y: 200 }]);
  assert.deepEqual(orthogonalThrough(s, 'R', toWaypoints(z), t, 'L'), z);
  assert.deepEqual(snap({ x: 14, y: 26 }), { x: 10, y: 30 });
});

test('manual routes never approach a table through itself', () => {
  // FK end on the right side of a table whose left edge is at x=600; the bend is to the left of it.
  const s = { x: 100, y: 250 };
  const t = { x: 805, y: 340 };
  const pts = orthogonalThrough(s, 'R', [{ x: 650, y: 180 }], t, 'R');
  const table = { x1: 600, y1: 290, x2: 800, y2: 420 };
  assert.ok(!crosses(pts, table), JSON.stringify(pts));
  // Bend behind the source table: leave it vertically first rather than crossing back over it.
  const back = orthogonalThrough({ x: 205, y: 300 }, 'R', [{ x: 100, y: 150 }], { x: 600, y: 300 }, 'L');
  assert.equal(back[2].x, back[1].x, 'leaves the stub vertically: ' + JSON.stringify(back));
  assert.ok(back[1].x > 205);
});
