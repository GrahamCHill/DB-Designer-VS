import dagre from '@dagrejs/dagre';
import { Position, Schema, Table } from '../shared/model';

export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 26;

export function nodeHeight(t: Table): number {
  return HEADER_HEIGHT + Math.max(1, t.columns.length) * ROW_HEIGHT + 6;
}

/**
 * Lay out tables: connected tables with dagre (parents left, children right),
 * isolated tables in a grid underneath.
 */
export function autoLayout(tables: Table[], schema: Schema): Record<string, Position> {
  const ids = new Set(tables.map((t) => t.id));
  const rels = schema.relations.filter((r) => ids.has(r.fromTable) && ids.has(r.toTable) && r.fromTable !== r.toTable);
  const connected = new Set<string>();
  for (const r of rels) {
    connected.add(r.fromTable);
    connected.add(r.toTable);
  }

  const out: Record<string, Position> = {};
  let maxY = 0;
  let minX = 0;

  const linked = tables.filter((t) => connected.has(t.id));
  if (linked.length) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 140, edgesep: 20, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of linked) g.setNode(t.id, { width: NODE_WIDTH, height: nodeHeight(t) });
    for (const r of rels) g.setEdge(r.toTable, r.fromTable, {}, r.id);
    dagre.layout(g);

    // Hub-and-spoke schemas (everything references `users`) make dagre produce a few enormous
    // ranks. Keep dagre's rank (x) and in-rank order (y) but wrap tall ranks into sub-columns
    // so the overall diagram is roughly 16:9.
    const GAP_X = 50;
    const GAP_Y = 36;
    const RANK_GAP = 150;
    const ranks = new Map<number, Table[]>();
    for (const t of linked) {
      const x = Math.round(g.node(t.id).x);
      if (!ranks.has(x)) ranks.set(x, []);
      ranks.get(x)!.push(t);
    }
    const area = linked.reduce((a, t) => a + (NODE_WIDTH + GAP_X) * (nodeHeight(t) + GAP_Y), 0);
    const tallestNode = Math.max(...linked.map(nodeHeight));
    const targetH = Math.max(tallestNode, Math.sqrt((area * 9) / 16) * 1.15);
    let x = 0;
    for (const rx of [...ranks.keys()].sort((a, b) => a - b)) {
      const members = ranks.get(rx)!.sort((a, b) => g.node(a.id).y - g.node(b.id).y);
      const total = members.reduce((a, t) => a + nodeHeight(t) + GAP_Y, 0);
      const cols = Math.max(1, Math.ceil(total / targetH));
      const perCol = total / cols;
      let col = 0;
      let y = 0;
      for (const t of members) {
        const h = nodeHeight(t) + GAP_Y;
        if (y > 0 && y + h / 2 > perCol && col < cols - 1) {
          col++;
          y = 0;
        }
        out[t.id] = { x: x + col * (NODE_WIDTH + GAP_X), y };
        y += h;
        maxY = Math.max(maxY, y);
      }
      x += cols * (NODE_WIDTH + GAP_X) - GAP_X + RANK_GAP;
    }
    minX = 0;
  }

  const isolated = tables.filter((t) => !connected.has(t.id));
  if (isolated.length) {
    const cols = Math.max(3, Math.ceil(Math.sqrt(isolated.length * 1.6)));
    const gapX = NODE_WIDTH + 60;
    let y = linked.length ? maxY + 160 : 0;
    for (let i = 0; i < isolated.length; i += cols) {
      const row = isolated.slice(i, i + cols);
      let rowH = 0;
      row.forEach((t, j) => {
        out[t.id] = { x: minX + j * gapX, y };
        rowH = Math.max(rowH, nodeHeight(t));
      });
      y += rowH + 60;
    }
  }
  return out;
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
