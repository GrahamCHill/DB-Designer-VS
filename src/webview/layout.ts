import dagre from '@dagrejs/dagre';
import { Position, Schema, Table } from '../shared/model';

export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 26;

export function nodeHeight(t: Table): number {
  return HEADER_HEIGHT + Math.max(1, t.columns.length) * ROW_HEIGHT + 6;
}

/** Something to place: a table, or a whole group treated as one rigid block. */
export interface LayoutItem {
  id: string;
  w: number;
  h: number;
}

// Generous gaps leave corridors for the edge router, so lines don't have to pass under tables.
const GAP_X = 110;
const GAP_Y = 64;
const RANK_GAP = 240;

/**
 * Place items: connected ones with dagre (parents left, children right), tall ranks wrapped into
 * sub-columns for a roughly 16:9 diagram, and unconnected items in a grid underneath.
 */
export function layoutItems(items: LayoutItem[], links: { from: string; to: string }[]): Record<string, Position> {
  const ids = new Set(items.map((i) => i.id));
  const rels = links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  const connected = new Set<string>();
  for (const r of rels) {
    connected.add(r.from);
    connected.add(r.to);
  }
  const out: Record<string, Position> = {};
  let maxY = 0;

  const linked = items.filter((t) => connected.has(t.id));
  if (linked.length) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 140, edgesep: 20, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of linked) g.setNode(t.id, { width: t.w, height: t.h });
    rels.forEach((r, k) => g.setEdge(r.to, r.from, {}, `e${k}`));
    dagre.layout(g);

    // Hub-and-spoke schemas (everything references `users`) make dagre produce a few enormous
    // ranks. Keep dagre's rank (x) and in-rank order (y) but wrap tall ranks into sub-columns.
    const ranks = new Map<number, LayoutItem[]>();
    for (const t of linked) {
      const x = Math.round(g.node(t.id).x);
      if (!ranks.has(x)) ranks.set(x, []);
      ranks.get(x)!.push(t);
    }
    const area = linked.reduce((a, t) => a + (t.w + GAP_X) * (t.h + GAP_Y), 0);
    const tallest = Math.max(...linked.map((t) => t.h));
    const targetH = Math.max(tallest, Math.sqrt((area * 9) / 16) * 1.15);
    let x = 0;
    for (const rx of [...ranks.keys()].sort((a, b) => a - b)) {
      const members = ranks.get(rx)!.sort((a, b) => g.node(a.id).y - g.node(b.id).y);
      const total = members.reduce((a, t) => a + t.h + GAP_Y, 0);
      const cols = Math.max(1, Math.ceil(total / targetH));
      const perCol = total / cols;
      const colWidths: number[] = new Array(cols).fill(0);
      const placed: { t: LayoutItem; col: number; y: number }[] = [];
      let col = 0;
      let y = 0;
      for (const t of members) {
        const h = t.h + GAP_Y;
        if (y > 0 && y + h / 2 > perCol && col < cols - 1) {
          col++;
          y = 0;
        }
        placed.push({ t, col, y });
        colWidths[col] = Math.max(colWidths[col], t.w);
        y += h;
        maxY = Math.max(maxY, y);
      }
      const colX = colWidths.map((_, i) => colWidths.slice(0, i).reduce((a, w) => a + w + GAP_X, 0));
      for (const p of placed) out[p.t.id] = { x: x + colX[p.col], y: p.y };
      x += colWidths.reduce((a, w) => a + w + GAP_X, 0) - GAP_X + RANK_GAP;
    }
  }

  const isolated = items.filter((t) => !connected.has(t.id));
  if (isolated.length) {
    const cols = Math.max(3, Math.ceil(Math.sqrt(isolated.length * 1.6)));
    let y = linked.length ? maxY + 200 : 0;
    for (let i = 0; i < isolated.length; i += cols) {
      const row = isolated.slice(i, i + cols);
      let rowH = 0;
      let x = 0;
      for (const t of row) {
        out[t.id] = { x, y };
        x += t.w + GAP_X;
        rowH = Math.max(rowH, t.h);
      }
      y += rowH + GAP_Y + 20;
    }
  }
  return out;
}

/** Lay out tables (each table is its own item). */
export function autoLayout(tables: Table[], schema: Schema): Record<string, Position> {
  return layoutItems(
    tables.map((t) => ({ id: t.id, w: NODE_WIDTH, h: nodeHeight(t) })),
    schema.relations.map((r) => ({ from: r.fromTable, to: r.toTable })),
  );
}

/** Place tables that have no saved position to the right of everything else. */
export function placeMissing(tables: Table[], known: Record<string, Position>): Record<string, Position> {
  const out: Record<string, Position> = {};
  const placed = tables.filter((t) => known[t.id]);
  let x = 0;
  let top = 0;
  for (const t of placed) {
    x = Math.max(x, known[t.id].x + NODE_WIDTH);
    top = Math.min(top, known[t.id].y);
  }
  x += 120;
  let y = top;
  for (const t of tables) {
    if (known[t.id]) continue;
    out[t.id] = { x, y };
    y += nodeHeight(t) + 50;
    if (y > top + 2400) {
      y = top;
      x += NODE_WIDTH + 60;
    }
  }
  return out;
}
