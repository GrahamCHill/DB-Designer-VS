// Orthogonal edge routing that keeps relationship lines out from under tables.
//
// Tables (padded) are obstacles. The search graph is a sparse grid built only from "interesting"
// coordinates: obstacle edges, the centre lines of the gaps between them, and the two end points.
// A* weighs length, bends, crossings, and shared lanes to keep relationships legible.
// Falls back to null when there is no route.

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export type Side = 'L' | 'R';

export interface RouteOptions {
  /** Clearance kept around tables. */
  pad?: number;
  /** Straight segment leaving / entering a table side. */
  stub?: number;
  /** How far outside the endpoints' bounding box the search may go. */
  margin?: number;
  /** Cost of a bend, in pixels of length. */
  bend?: number;
  /** Safety cap on A* expansions. */
  maxExpansions?: number;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

function coords(values: number[], lo: number, hi: number): number[] {
  const sorted = [...new Set(values.filter((x) => x >= lo && x <= hi))].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i + 1 < sorted.length && sorted[i + 1] - sorted[i] > 8) out.push((sorted[i] + sorted[i + 1]) / 2); // corridor centre
  }
  return out;
}

export function routeOrthogonal(s: Pt, sSide: Side, t: Pt, tSide: Side, obstacles: Rect[], opts: RouteOptions = {}): Pt[] | null {
  return findRoute(s, sSide, t, tSide, obstacles, opts);
}

export interface RelationshipPath {
  id: string;
  source: Pt;
  sSide: Side;
  target: Pt;
  tSide: Side;
  points?: Pt[];
}

type Lane = { at: number; lo: number; hi: number };
const LANE_GAP = 18;
const CROSSING_COST = 180;

/** Count crossings of existing perpendicular lines between adjacent search coordinates. */
function crossingCounts(along: number[], across: number[], perpendicular?: Map<number, Lane[]>): Uint16Array {
  const counts = new Uint16Array(along.length * across.length);
  if (!perpendicular?.size) return counts;
  for (const bucket of perpendicular.values()) {
    for (const line of bucket) {
      // Use the interval [left, right) so a crossing on a grid coordinate is counted once.
      let lo = 0;
      let hi = along.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (along[mid] <= line.at) lo = mid + 1;
        else hi = mid;
      }
      const band = lo - 1;
      if (band < 0 || band >= along.length - 1) continue;
      for (let i = 0; i < across.length; i++) {
        if (line.lo < across[i] && across[i] < line.hi) counts[i * along.length + band]++;
      }
    }
  }
  return counts;
}

/** Let nearby relationships establish their lanes before routing longer ones. */
export function routeRelationships(edges: RelationshipPath[], obstacles: Rect[]): Map<string, Pt[] | null> {
  const routes = new Map<string, Pt[] | null>();
  const lanes = [new Map<number, Lane[]>(), new Map<number, Lane[]>()];
  const reserve = (id: string, points: Pt[]) => {
    routes.set(id, points);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const horizontal = a.y === b.y;
      const at = horizontal ? a.y : a.x;
      const u = horizontal ? a.x : a.y;
      const v = horizontal ? b.x : b.y;
      const index = Math.floor(at / LANE_GAP);
      const buckets = lanes[horizontal ? 0 : 1];
      const bucket = buckets.get(index) ?? [];
      bucket.push({ at, lo: Math.min(u, v), hi: Math.max(u, v) });
      buckets.set(index, bucket);
    }
  };
  for (const { id, source, sSide, target, tSide, points } of edges) {
    if (points?.length) reserve(id, orthogonalThrough(source, sSide, points, target, tSide));
  }
  const span = ({ source, target }: RelationshipPath) => Math.abs(source.x - target.x) + Math.abs(source.y - target.y);
  const ordered = [...edges].sort((a, b) => span(a) - span(b));
  for (const { id, source, sSide, target, tSide } of ordered) {
    if (routes.has(id)) continue;
    const result = findRoute(source, sSide, target, tSide, obstacles, {}, lanes);
    if (result) reserve(id, result);
    else routes.set(id, null);
  }
  return routes;
}

function findRoute(
  s: Pt, sSide: Side, t: Pt, tSide: Side, obstacles: Rect[], opts: RouteOptions, lanes?: Map<number, Lane[]>[],
): Pt[] | null {
  const local = searchRoute(s, sSide, t, tSide, obstacles, opts, lanes);
  if (local || opts.margin !== undefined || opts.pad !== undefined) return local;
  // A tall table may seal off the local search box. Include the diagram perimeter on retry.
  const margin = obstacles.reduce((m, o) => Math.max(m, Math.abs(s.x - o.x1), Math.abs(s.x - o.x2),
    Math.abs(s.y - o.y1), Math.abs(s.y - o.y2)), 260) + 40;
  return searchRoute(s, sSide, t, tSide, obstacles, { ...opts, margin }, lanes)
    ?? searchRoute(s, sSide, t, tSide, obstacles, { ...opts, margin, pad: 4, stub: 16 });
}

function searchRoute(
  s: Pt, sSide: Side, t: Pt, tSide: Side, obstacles: Rect[], opts: RouteOptions, lanes?: Map<number, Lane[]>[],
): Pt[] | null {
  const PAD = opts.pad ?? 14;
  const STUB = opts.stub ?? 26;
  const MARGIN = opts.margin ?? 260;
  const BEND = opts.bend ?? 60;
  const MAX = opts.maxExpansions ?? 40000;
  const padded = obstacles.map((o) => ({ x1: o.x1 - PAD, y1: o.y1 - PAD, x2: o.x2 + PAD, y2: o.y2 + PAD }));
  const stub = (point: Pt, side: Side): Pt => {
    let x = point.x + (side === 'R' ? STUB : -STUB);
    for (const o of padded) {
      if (point.y <= o.y1 || point.y >= o.y2) continue;
      if (side === 'R' && point.x <= o.x1) x = Math.min(x, o.x1);
      if (side === 'L' && point.x >= o.x2) x = Math.max(x, o.x2);
    }
    return { x, y: point.y };
  };
  const s1 = stub(s, sSide);
  const t1 = stub(t, tSide);
  const bx1 = Math.min(s1.x, t1.x) - MARGIN;
  const bx2 = Math.max(s1.x, t1.x) + MARGIN;
  const by1 = Math.min(s1.y, t1.y) - MARGIN;
  const by2 = Math.max(s1.y, t1.y) + MARGIN;
  const strictlyInside = (o: Rect, p: Pt) => o.x1 < p.x && p.x < o.x2 && o.y1 < p.y && p.y < o.y2;
  const obs = padded.filter((o) => o.x2 > bx1 && o.x1 < bx2 && o.y2 > by1 && o.y1 < by2);
  if (obs.some((o) => strictlyInside(o, s1) || strictlyInside(o, t1))) return null;

  const grid = (values: number[], lo: number, hi: number, occupied?: Map<number, Lane[]>) => {
    const base = coords(values, lo, hi);
    if (!occupied?.size) return base;
    const extra = base.filter((x) => occupied.has(Math.floor(x / LANE_GAP))).flatMap((x) => [x - LANE_GAP, x + LANE_GAP]);
    return [...new Set([...base, ...extra.filter((x) => x > lo && x < hi)])].sort((a, b) => a - b);
  };
  const xs = grid([s1.x, t1.x, bx1, bx2, ...obs.flatMap((o) => [o.x1, o.x2])], bx1, bx2, lanes?.[1]);
  const ys = grid([s1.y, t1.y, by1, by2, ...obs.flatMap((o) => [o.y1, o.y2])], by1, by2, lanes?.[0]);
  const nx = xs.length;
  const ny = ys.length;
  const si = xs.indexOf(s1.x);
  const sj = ys.indexOf(s1.y);
  const ti = xs.indexOf(t1.x);
  const tj = ys.indexOf(t1.y);

  const nearbyLanes = (coordinates: number[], occupied?: Map<number, Lane[]>) => coordinates.map((at) => {
    const nearby: Lane[] = [];
    if (!occupied?.size) return nearby;
    const index = Math.floor(at / LANE_GAP);
    for (let k = index - 1; k <= index + 1; k++) {
      for (const lane of occupied.get(k) ?? []) if (Math.abs(lane.at - at) < LANE_GAP) nearby.push(lane);
    }
    return nearby;
  });
  const horizontalLanes = nearbyLanes(ys, lanes?.[0]);
  const verticalLanes = nearbyLanes(xs, lanes?.[1]);
  const horizontalCrossings = crossingCounts(xs, ys, lanes?.[1]);
  const verticalCrossings = crossingCounts(ys, xs, lanes?.[0]);
  const rowObstacles = ys.map((y) => obs.filter((o) => o.y1 < y && y < o.y2));
  const columnObstacles = xs.map((x) => obs.filter((o) => o.x1 < x && x < o.x2));
  const hFree = (j: number, i1: number, i2: number) => {
    const a = Math.min(xs[i1], xs[i2]);
    const b = Math.max(xs[i1], xs[i2]);
    return !rowObstacles[j].some((o) => o.x1 < b && o.x2 > a);
  };
  const vFree = (i: number, j1: number, j2: number) => {
    const a = Math.min(ys[j1], ys[j2]);
    const b = Math.max(ys[j1], ys[j2]);
    return !columnObstacles[i].some((o) => o.y1 < b && o.y2 > a);
  };

  // State id = ((j * nx) + i) * 2 + dir (0 = moving horizontally, 1 = vertically)
  const id = (i: number, j: number, d: number) => (j * nx + i) * 2 + d;
  const g = new Float64Array(nx * ny * 2).fill(Infinity);
  const prev = new Int32Array(nx * ny * 2).fill(-1);
  const closed = new Uint8Array(nx * ny * 2);
  const heap = new Heap();
  const h = (i: number, j: number) => Math.abs(xs[i] - xs[ti]) + Math.abs(ys[j] - ys[tj]);
  const start = id(si, sj, 0); // the stub leaves horizontally
  g[start] = 0;
  heap.push(h(si, sj), start);
  let goal = -1;
  let expansions = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expansions > MAX) return null;
    const d = cur & 1;
    const cell = cur >> 1;
    const i = cell % nx;
    const j = (cell - i) / nx;
    if (i === ti && j === tj) {
      goal = cur;
      break;
    }
    const gc = g[cur];
    const tryMove = (ni: number, nj: number, nd: number, len: number) => {
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) return;
      if (nd === 0 ? !hFree(nj, i, ni) : !vFree(ni, j, nj)) return;
      let cost = gc + len + (nd !== d ? BEND : 0);
      const crossings = nd === 0
        ? horizontalCrossings[j * nx + Math.min(i, ni)]
        : verticalCrossings[i * ny + Math.min(j, nj)];
      cost += crossings * CROSSING_COST;
      const nearby = nd === 0 ? horizontalLanes[j] : verticalLanes[i];
      if (nearby.length) {
        const a = nd === 0 ? xs[i] : ys[j];
        const b = nd === 0 ? xs[ni] : ys[nj];
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (const lane of nearby) {
          cost += 8 * Math.max(0, Math.min(lane.hi, hi) - Math.max(lane.lo, lo));
        }
      }
      if (ni === ti && nj === tj && nd === 1) cost += BEND; // the end stub enters horizontally
      const nid = id(ni, nj, nd);
      if (cost < g[nid]) {
        g[nid] = cost;
        prev[nid] = cur;
        heap.push(cost + h(ni, nj), nid);
      }
    };
    tryMove(i + 1, j, 0, Math.abs(xs[i + 1] - xs[i]) || 0);
    tryMove(i - 1, j, 0, Math.abs(xs[i] - xs[i - 1]) || 0);
    tryMove(i, j + 1, 1, Math.abs(ys[j + 1] - ys[j]) || 0);
    tryMove(i, j - 1, 1, Math.abs(ys[j] - ys[j - 1]) || 0);
  }
  if (goal < 0) return null;

  const pts: Pt[] = [];
  for (let c = goal; c >= 0; c = prev[c]) {
    const cell = c >> 1;
    const i = cell % nx;
    pts.push({ x: xs[i], y: ys[(cell - i) / nx] });
  }
  pts.reverse();
  const route = simplify([s, ...pts, t]);
  return obstacles.some((o) => crosses(route, o)) ? null : route;
}

/** Drop repeated and collinear points. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

/** SVG path through the points with rounded corners. */
export function roundedPath(points: Pt[], radius = 10): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x} ${points[0].y}`;
  for (let k = 1; k < points.length - 1; k++) {
    const a = points[k - 1];
    const b = points[k];
    const c = points[k + 1];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const p1 = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const p2 = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    d += ` L${p1.x} ${p1.y} Q${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

/** Point halfway along the polyline (for labels). */
export function midpoint(points: Pt[]): Pt {
  const lens = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) {
      const f = lens[i] ? half / lens[i] : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
    }
    half -= lens[i];
  }
  return points[points.length - 1];
}

/** Does any segment of the polyline pass through (the interior of) a rectangle? */
export function crosses(points: Pt[], r: Rect): boolean {
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (a.y === b.y) {
      if (r.y1 < a.y && a.y < r.y2 && Math.min(a.x, b.x) < r.x2 && Math.max(a.x, b.x) > r.x1) return true;
    } else if (a.x === b.x) {
      if (r.x1 < a.x && a.x < r.x2 && Math.min(a.y, b.y) < r.y2 && Math.max(a.y, b.y) > r.y1) return true;
    }
  }
  return false;
}

/**
 * A user-shaped line: leaves the source side, passes through each bend point with orthogonal (L-shaped)
 * segments, and enters the target side horizontally.
 */
export function orthogonalThrough(s: Pt, sSide: Side, points: Pt[], t: Pt, tSide: Side, stub = 26): Pt[] {
  const s1 = { x: s.x + (sSide === 'R' ? stub : -stub), y: s.y };
  const t1 = { x: t.x + (tSide === 'R' ? stub : -stub), y: t.y };
  const out: Pt[] = [s, s1];
  let cur = s1;
  points.forEach((p, i) => {
    // Normally across, then up/down onto the bend point. Leaving a table, never double back across it.
    const back = i === 0 && (sSide === 'R' ? p.x < s1.x : p.x > s1.x);
    out.push(back ? { x: cur.x, y: p.y } : { x: p.x, y: cur.y }, p);
    cur = p;
  });
  // Normally up/down, then across into the table; but never approach it through the table itself.
  const through = points.length > 0 && (tSide === 'R' ? cur.x < t1.x : cur.x > t1.x);
  out.push(through ? { x: t1.x, y: cur.y } : { x: cur.x, y: t1.y }, t1, t);
  return simplify(out);
}

/** Snap a point to a grid so hand-placed bends line up. */
export function snap(p: Pt, grid = 10): Pt {
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

/**
 * Waypoints that reproduce an orthogonal line (from routeOrthogonal or orthogonalThrough) when fed back
 * into orthogonalThrough. The first and last corners sit on the table rows and are left out, so the line
 * keeps attaching to its columns when tables move.
 */
export function toWaypoints(full: Pt[]): Pt[] {
  const c = simplify(full).slice(1, -1);
  if (c.length >= 3) return c.slice(1, -1);
  if (c.length === 2) return [{ x: c[0].x, y: (c[0].y + c[1].y) / 2 }];
  return [];
}
