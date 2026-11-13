// Where relationship lines attach to tables. Shared by the live diagram, image export and tests.

import { Table } from '../shared/model';
import { HEADER_HEIGHT, ROW_HEIGHT } from './layout';
import type { Pt, Side } from './router';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Same offset as the React Flow handles (they sit 5px outside the card). */
const HANDLE_OUT = 5;
const COLUMNS_TOP = HEADER_HEIGHT + 3;

/** Which side of each table a relation attaches to. */
export function edgeSides(parent: Box, child: Box, selfRef: boolean): { s: Side; t: Side } {
  const pc = parent.x + parent.w / 2;
  const cc = child.x + child.w / 2;
  if (selfRef || Math.abs(pc - cc) < Math.min(parent.w, child.w) * 0.75) return { s: 'R', t: 'R' };
  return pc < cc ? { s: 'R', t: 'L' } : { s: 'L', t: 'R' };
}

export function columnY(t: Table, b: Box, columnId: string): number {
  const i = Math.max(0, t.columns.findIndex((c) => c.id === columnId));
  return b.y + COLUMNS_TOP + i * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function edgeSidesFor(
  parent: Table,
  pb: Box,
  parentColumn: string,
  child: Table,
  cb: Box,
  childColumn: string,
  selfRef: boolean,
  override?: { s?: Side; t?: Side },
): { source: Pt; sSide: Side; target: Pt; tSide: Side } {
  const auto = edgeSides(pb, cb, selfRef);
  const s = override?.s ?? auto.s;
  const t = override?.t ?? auto.t;
  return {
    source: { x: s === 'R' ? pb.x + pb.w + HANDLE_OUT : pb.x - HANDLE_OUT, y: columnY(parent, pb, parentColumn) },
    sSide: s,
    target: { x: t === 'R' ? cb.x + cb.w + HANDLE_OUT : cb.x - HANDLE_OUT, y: columnY(child, cb, childColumn) },
    tSide: t,
  };
}
