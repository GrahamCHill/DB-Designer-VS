import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiagramGroup } from '../src/shared/model';
import { descendants, groupAt, groupDepth, parentFor, rectAround } from '../src/webview/groups';

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
