import dagre from '@dagrejs/dagre';
import { DiagramGroup, Position, Schema, Table, tableKey } from '../shared/model';
import { GROUP_HEADER, GROUP_PAD } from './groups';

export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 26;

export function nodeHeight(t: Table): number {
  return HEADER_HEIGHT + Math.max(1, t.columns.length) * ROW_HEIGHT + 6;
}

/** Something to place: a table, or a whole group treated as one rigid block. */
interface LayoutItem {
  id: string;
  w: number;
  h: number;
}

type LayoutLink = { from: string; to: string };
type PlacedLayout = { positions: Record<string, Position>; groups: DiagramGroup[]; w: number; h: number };
type PositionedItems = Omit<PlacedLayout, 'groups'>;

// Generous gaps leave corridors for the edge router, so lines don't have to pass under tables.
const GAP_X = 110;
const GAP_Y = 88;
const RANK_GAP = 240;

/**
 * Lay out connected components separately, then pack them into rows with room for routes.
 * Place unconnected items in a grid underneath.
 */
function layoutItems(items: LayoutItem[], links: LayoutLink[]): Record<string, Position> {
  const neighbors = new Map(items.map(({ id }) => [id, new Set<string>()]));
  for (const { from, to } of links) {
    if (from === to || !neighbors.has(from) || !neighbors.has(to)) continue;
    neighbors.get(from)!.add(to);
    neighbors.get(to)!.add(from);
  }

  // A relationship stays in its own connected component. Packing components as blocks keeps
  // unrelated tables out of each other's routing corridors.
  const components = new Map<string, LayoutItem[]>();
  const componentOf = new Map<string, string>();
  for (const { id } of items) {
    if (componentOf.has(id) || !neighbors.get(id)?.size) continue;
    const queue = [id];
    componentOf.set(id, id);
    for (const member of queue) {
      for (const neighbor of neighbors.get(member)!) {
        if (componentOf.has(neighbor)) continue;
        componentOf.set(neighbor, id);
        queue.push(neighbor);
      }
    }
    components.set(id, []);
  }
  for (const item of items) {
    const component = componentOf.get(item.id);
    if (component !== undefined) components.get(component)!.push(item);
  }
  const relsByComponent = new Map([...components.keys()].map((id) => [id, [] as LayoutLink[]]));
  for (const link of links) {
    const component = componentOf.get(link.from);
    if (component !== undefined && component === componentOf.get(link.to) && link.from !== link.to) relsByComponent.get(component)!.push(link);
  }
  const blocks = [...components].map(([id, members]) => layoutConnected(members, relsByComponent.get(id)!));
  blocks.sort((a, b) => b.h - a.h || b.w - a.w);
  const area = blocks.reduce((sum, b) => sum + (b.w + RANK_GAP) * (b.h + RANK_GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area * 16 / 9), ...blocks.map((b) => b.w));

  const out: Record<string, Position> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x && x + block.w > rowWidth) {
      x = 0;
      y += rowHeight + RANK_GAP;
      rowHeight = 0;
    }
    for (const [id, p] of Object.entries(block.positions)) out[id] = { x: p.x + x, y: p.y + y };
    x += block.w + RANK_GAP;
    rowHeight = Math.max(rowHeight, block.h);
  }

  const isolated = items.filter(({ id }) => !componentOf.has(id));
  const cols = Math.max(3, Math.ceil(Math.sqrt(isolated.length * 1.6)));
  y += blocks.length ? rowHeight + RANK_GAP : 0;
  for (let i = 0; i < isolated.length; i += cols) {
    const row = isolated.slice(i, i + cols);
    x = 0;
    for (const t of row) {
      out[t.id] = { x, y };
      x += t.w + GAP_X;
    }
    y += Math.max(...row.map((t) => t.h)) + GAP_Y + 20;
  }
  return out;
}

function layoutConnected(linked: LayoutItem[], rels: LayoutLink[]): PositionedItems {
  const out: Record<string, Position> = {};
  let maxY = 0;
  let x = 0;

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: GAP_Y, ranksep: 140, edgesep: 28, marginx: 0, marginy: 0 });
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
  for (const rx of [...ranks.keys()].sort((a, b) => a - b)) {
    const members = ranks.get(rx)!.sort((a, b) => g.node(a.id).y - g.node(b.id).y);
    const total = members.reduce((a, t) => a + t.h + GAP_Y, 0);
    const cols = Math.max(1, Math.ceil(total / targetH));
    const perCol = total / cols;
    const colWidths: number[] = [];
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
      colWidths[col] = Math.max(colWidths[col] ?? 0, t.w);
      y += h;
      maxY = Math.max(maxY, y);
    }
    const colX = colWidths.map((_, i) => colWidths.slice(0, i).reduce((a, w) => a + w + GAP_X, 0));
    for (const p of placed) out[p.t.id] = { x: x + colX[p.col], y: p.y };
    x += colWidths.reduce((a, w) => a + w + GAP_X, 0) - GAP_X + RANK_GAP;
  }
  return { positions: out, w: x - RANK_GAP, h: maxY - GAP_Y };
}

/** Lay out tables (each table is its own item). */
export function autoLayout(tables: Table[], schema: Schema): Record<string, Position> {
  return layoutDiagram(tables, schema, []).positions;
}

/** Lay out each group's contents before placing the group among its siblings. */
export function layoutDiagram(
  tables: Table[],
  schema: Schema,
  groups: DiagramGroup[],
  measured: ReadonlyMap<string, { width?: number; height?: number }> = new Map(),
): { positions: Record<string, Position>; groups: DiagramGroup[] } {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const tablesByKey = new Map(tables.map((t) => [tableKey(t), t]));
  const groupOfTable = new Map<string, string>();
  const groupsByParent = new Map<string | undefined, DiagramGroup[]>();
  for (const g of groups) {
    // Older diagram files can have a missing parent or a cycle. Place those at the root.
    const seen = new Set([g.id]);
    let ancestor = g.parentId;
    while (ancestor && groupsById.has(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = groupsById.get(ancestor)?.parentId;
    }
    const cyclic = ancestor !== undefined && seen.has(ancestor);
    const parentId = g.parentId && groupsById.has(g.parentId) && !cyclic ? g.parentId : undefined;
    const siblings = groupsByParent.get(parentId) ?? [];
    siblings.push(g);
    groupsByParent.set(parentId, siblings);
    for (const key of g.tables) {
      const table = tablesByKey.get(key);
      if (table) groupOfTable.set(table.id, g.id);
    }
  }
  const tableItems = tables.map((t) => ({
    id: t.id,
    w: measured.get(t.id)?.width ?? NODE_WIDTH,
    h: measured.get(t.id)?.height ?? nodeHeight(t),
  }));
  const links = schema.relations.map((r) => ({ from: r.fromTable, to: r.toTable }));

  function place(parentId?: string): PlacedLayout {
    const children = (groupsByParent.get(parentId) ?? []).map((group) => ({ group, contents: place(group.id) }));
    const directTables = tableItems.filter((table) => groupOfTable.get(table.id) === parentId);
    const items = [...directTables];
    const blockOf = new Map(directTables.map(({ id }) => [id, id]));
    for (const { group, contents } of children) {
      const block = `grp:${group.id}`;
      for (const id of Object.keys(contents.positions)) blockOf.set(id, block);
      items.push({ id: block, w: Math.max(group.w, contents.w), h: Math.max(group.h, contents.h) });
    }
    const placed = layoutItems(items, links.flatMap(({ from, to }) => {
      const a = blockOf.get(from);
      const b = blockOf.get(to);
      return a && b ? [{ from: a, to: b }] : [];
    }));
    const insetX = parentId === undefined ? 0 : GROUP_PAD;
    const insetY = parentId === undefined ? 0 : GROUP_HEADER + GROUP_PAD;
    const positions: Record<string, Position> = {};
    const placedGroups: DiagramGroup[] = [];
    let w = 0;
    let h = 0;
    for (const item of items) {
      const x = placed[item.id].x + insetX;
      const y = placed[item.id].y + insetY;
      w = Math.max(w, x + item.w + insetX);
      h = Math.max(h, y + item.h + insetX);
    }
    for (const { id } of directTables) positions[id] = { x: placed[id].x + insetX, y: placed[id].y + insetY };
    for (const { group, contents } of children) {
      const p = placed[`grp:${group.id}`];
      const x = p.x + insetX;
      const y = p.y + insetY;
      placedGroups.push({ ...group, x, y, w: Math.max(group.w, contents.w), h: Math.max(group.h, contents.h), parentId });
      for (const [id, p] of Object.entries(contents.positions)) positions[id] = { x: x + p.x, y: y + p.y };
      for (const g of contents.groups) placedGroups.push({ ...g, x: x + g.x, y: y + g.y });
    }
    return { positions, groups: placedGroups, w, h };
  }

  const result = place();
  return { positions: result.positions, groups: result.groups };
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
