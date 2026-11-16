import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiagramGroup } from '../src/shared/model';
import { GROUP_HEADER, descendants, groupAt, groupDepth, parentFor, rectAround } from '../src/webview/groups';
import { layoutDiagram, nodeHeight, NODE_WIDTH } from '../src/webview/layout';
import { parseSql } from '../src/shared/sqlParser';

const g = (id: string, x: number, y: number, w: number, h: number, parentId?: string): DiagramGroup => ({ id, name: id, color: '#3ecf8e', x, y, w, h, parentId, tables: [] });

test('membership goes to the smallest group under the drop point', () => {
  const outer = g('outer', 0, 0, 1000, 800);
  const inner = g('inner', 100, 100, 300, 300, 'outer');
  assert.equal(groupAt(200, 200, [outer, inner])?.id, 'inner');
  assert.equal(groupAt(600, 600, [outer, inner])?.id, 'outer');
  assert.equal(groupAt(2000, 10, [outer, inner]), undefined);
});

test('nesting: parent is the smallest group that fully contains it; never a descendant', () => {
  const a = g('a', 0, 0, 1000, 1000);
  const b = g('b', 50, 50, 600, 600, 'a');
  const c = g('c', 100, 100, 200, 200, 'b');
  const all = [a, b, c];
  assert.equal(parentFor(c, all), 'b');
  assert.equal(groupDepth('c', all), 2);
  assert.deepEqual([...descendants('a', all)].sort(), ['b', 'c']);
  // Moving "a" inside its own child must not make the child its parent.
  const moved = { ...a, x: 60, y: 60, w: 100, h: 100 };
  assert.notEqual(parentFor(moved, [moved, b, c]), 'b');
});

test('rectAround leaves room for the header and padding', () => {
  const r = rectAround([
    { x: 100, y: 100, w: 280, h: 200 },
    { x: 500, y: 150, w: 280, h: 100 },
  ]);
  assert.ok(r.x < 100 && r.y < 100 - 30 && r.x + r.w > 780 && r.y + r.h > 300);
});

test('auto layout spaces out measured tables and expands nested groups to contain them', () => {
  const { schema } = parseSql([{ name: 'groups.sql', content: `
    CREATE TABLE parent (id int PRIMARY KEY);
    CREATE TABLE child (id int PRIMARY KEY, parent_id int REFERENCES parent(id));
    CREATE TABLE other (id int PRIMARY KEY, child_id int REFERENCES child(id));
    CREATE TABLE ungrouped (id int PRIMARY KEY, other_id int REFERENCES other(id));
  ` }]);
  const [parent, child, other, ungrouped] = schema.tables;
  const groups = [
    { ...g('outer', 0, 0, 340, 220), tables: ['public.other'] },
    { ...g('inner', 0, 0, 320, 170, 'outer'), tables: ['public.parent', 'public.child'] },
  ];
  const measured = new Map([[parent.id, { width: 340, height: 420 }]]);
  const result = layoutDiagram(schema.tables, schema, groups, measured);
  const boxes = schema.tables.map((t) => ({
    ...result.positions[t.id], w: measured.get(t.id)?.width ?? NODE_WIDTH, h: measured.get(t.id)?.height ?? nodeHeight(t),
  }));
  const separate = (a: typeof boxes[number], b: typeof boxes[number]) =>
    a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y;
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) assert.ok(separate(a, b), JSON.stringify([a, b]));
  }
  const [outer, inner] = result.groups;
  const contains = (a: DiagramGroup, b: typeof boxes[number]) =>
    a.x < b.x && a.y + GROUP_HEADER < b.y && a.x + a.w > b.x + b.w && a.y + a.h > b.y + b.h;
  assert.ok(contains(outer, inner));
  assert.ok(contains(inner, boxes[0]) && contains(inner, boxes[1]));
  assert.ok(contains(outer, boxes[2]));
  assert.ok(separate(outer, { ...result.positions[ungrouped.id], w: NODE_WIDTH, h: nodeHeight(ungrouped) }));
  assert.deepEqual(inner.tables, [`public.${parent.name}`, `public.${child.name}`]);
  assert.deepEqual(outer.tables, [`public.${other.name}`]);
});
