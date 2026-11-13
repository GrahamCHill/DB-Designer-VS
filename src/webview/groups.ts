// Table groups: coloured rectangles that own the tables (and groups) placed inside them.

import type { DiagramGroup } from '../shared/model';

export type { DiagramGroup };

export const GROUP_COLORS = ['#3ecf8e', '#4f8ef7', '#f7a14f', '#e05d6f', '#a26ef7', '#2bb3c0', '#d4b72a', '#8c96a3'];
export const GROUP_HEADER = 34;
export const GROUP_PAD = 24;

/** What the image export needs to draw a group. */
export interface GroupBox {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  color: string;
  depth: number;
}

export function groupDepth(id: string, groups: DiagramGroup[]): number {
  let depth = 0;
  let cur = groups.find((g) => g.id === id);
  const guard = new Set<string>();
  while (cur?.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    cur = groups.find((g) => g.id === cur!.parentId);
    if (cur) depth++;
  }
  return depth;
}

export function descendants(id: string, groups: DiagramGroup[]): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const g of groups) if (g.parentId === pid && !out.has(g.id)) (out.add(g.id), walk(g.id));
  };
  walk(id);
  return out;
}

const area = (g: { w: number; h: number }) => g.w * g.h;

/** Smallest group whose rectangle contains the point (optionally ignoring some groups). */
export function groupAt(x: number, y: number, groups: DiagramGroup[], ignore: Set<string> = new Set()): DiagramGroup | undefined {
  return groups
    .filter((g) => !ignore.has(g.id) && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h)
    .sort((a, b) => area(a) - area(b))[0];
}

/** Smallest other group that fully contains `g` (its new parent). */
export function parentFor(g: DiagramGroup, groups: DiagramGroup[]): string | undefined {
  const blocked = descendants(g.id, groups);
  blocked.add(g.id);
  return groups
    .filter((o) => !blocked.has(o.id) && o.x <= g.x && o.y <= g.y && o.x + o.w >= g.x + g.w && o.y + o.h >= g.y + g.h)
    .sort((a, b) => area(a) - area(b))[0]?.id;
}

/** Rectangle around some boxes, leaving room for the group header. */
export function rectAround(boxes: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number } {
  const x1 = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD;
  const y1 = Math.min(...boxes.map((b) => b.y)) - GROUP_PAD - GROUP_HEADER;
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PAD;
  const y2 = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PAD;
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
}
