import React, { memo, useContext } from 'react';
import { BaseEdge, Edge, EdgeLabelRenderer, EdgeProps, Position, getSmoothStepPath, useReactFlow } from '@xyflow/react';
import type { EdgeRoute } from '../shared/model';
import { CloseIcon } from './icons';
import { Pt, Side, midpoint, orthogonalThrough, roundedPath, simplify, snap, toWaypoints } from './router';

/** Automatic routes computed together after table geometry settles. */
export const RouterContext = React.createContext<ReadonlyMap<string, Pt[] | null> | undefined>(undefined);

export interface RelationEdgeData extends Record<string, unknown> {
  /** e.g. "contracts.pdf_file_id → files.id" */
  label: string;
  onDelete?: string;
  onUpdate?: string;
  /** Cardinality at the FK (child) end: "N" or "1". */
  childCard: 'N' | '1';
  highlighted: boolean;
  /** Show the detail label (edge hovered). */
  hovered?: boolean;
  dimmed: boolean;
  /** One of its tables is being dragged: draw a simple line until the drag ends. */
  moving?: boolean;
  /** The user's own shape for this line (sides and bend points), if any. */
  route?: EdgeRoute;
  editable?: boolean;
}

export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;

export interface EdgeActions {
  remove(id: string): void;
  /** Called once before a line is changed by hand (records an undo step). */
  beginEdit(id: string): void;
  setRoute(id: string, route: EdgeRoute | undefined): void;
}

export const EdgeActionsContext = React.createContext<EdgeActions>({ remove() {}, beginEdit() {}, setRoute() {} });

function offset(x: number, y: number, pos: Position, d: number): [number, number] {
  switch (pos) {
    case Position.Left:
      return [x - d, y];
    case Position.Right:
      return [x + d, y];
    case Position.Top:
      return [x, y - d];
    default:
      return [x, y + d];
  }
}

const sideOf = (p: Position): Side => (p === Position.Right ? 'R' : 'L');

/** A handle on the line: drag to reshape; `dbl` runs on double-click. */
interface Grip {
  key: string;
  at: Pt;
  kind: 'seg-h' | 'seg-v' | 'bend' | 'add';
  title: string;
  /** New waypoints for a pointer position (flow coordinates, snapped). */
  apply(p: Pt): Pt[];
  dbl?(): void;
}

/**
 * The edge runs from the referenced (parent / PK) column to the referencing (child / FK) column.
 * The parent end carries a "PK · 1" chip and a bar; the child end an "FK · N" chip and a crow's foot.
 */
function RelationEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<RelationEdgeType>) {
  const actions = useContext(EdgeActionsContext);
  const router = useContext(RouterContext);
  const rf = useReactFlow();
  const horizontal = (sourcePosition === Position.Left || sourcePosition === Position.Right) && (targetPosition === Position.Left || targetPosition === Position.Right);
  const s: Pt = { x: Math.round(sourceX), y: Math.round(sourceY) };
  const t: Pt = { x: Math.round(targetX), y: Math.round(targetY) };
  const sSide = sideOf(sourcePosition);
  const tSide = sideOf(targetPosition);
  const manual = data?.route?.points?.length ? data.route.points : undefined;
  const pending = !manual && !data?.moving && horizontal ? router?.get(id) : undefined;
  const first = pending?.[0];
  const last = pending?.at(-1);
  const auto = first?.x === s.x && first.y === s.y && last?.x === t.x && last.y === t.y ? pending : undefined;
  const route = manual && horizontal ? orthogonalThrough(s, sSide, manual, t, tSide) : auto;
  const [stepPath, stepX, stepY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
    offset: 28,
  });
  const mid = route ? midpoint(route) : undefined;
  const path = route ? roundedPath(route) : stepPath;
  const labelX = mid?.x ?? stepX;
  const labelY = mid?.y ?? stepY;
  const active = selected || data?.highlighted;
  const state = active ? 'active' : data?.dimmed ? 'dimmed' : '';
  const [px, py] = offset(sourceX, sourceY, sourcePosition, 24);
  const [cx, cy] = offset(targetX, targetY, targetPosition, 24);
  const markerSuffix = active ? '-active' : '';
  const editing = !!selected && !!data?.editable && horizontal;

  // The line as drawn, as an orthogonal polyline (direct lines are approximated by a step through the middle).
  const full: Pt[] = route ?? orthogonalThrough(s, sSide, [], t, tSide);

  const grips: Grip[] = [];
  if (editing) {
    const pts = simplify(full);
    const corners = pts.slice(1, -1);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (len < 28) continue;
      const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const isEnd = k === 0 || k === pts.length - 2;
      if (isEnd) {
        // Segments touching a table stay on the column's row: dragging one adds a bend point instead.
        const first = k === 0;
        const base = manual ?? toWaypoints(pts);
        grips.push({
          key: `add${k}`,
          at,
          kind: 'add',
          title: 'Drag to add a bend',
          apply: (p) => (first ? [p, ...base] : [...base, p]),
        });
        continue;
      }
      const isH = a.y === b.y;
      // Interior segment k joins corners k-1 and k: slide it sideways.
      grips.push({
        key: `seg${k}`,
        at,
        kind: isH ? 'seg-h' : 'seg-v',
        title: isH ? 'Drag up or down to move this part of the line' : 'Drag left or right to move this part of the line',
        apply: (p) => {
          const c = corners.map((q) => ({ ...q }));
          if (isH) c[k - 1].y = c[k].y = p.y;
          else c[k - 1].x = c[k].x = p.x;
          return toWaypoints([s, ...c, t]);
        },
      });
    }
    (manual ?? []).forEach((w, i) =>
      grips.push({
        key: `bend${i}`,
        at: w,
        kind: 'bend',
        title: 'Drag to move this bend; double-click to remove it',
        apply: (p) => manual!.map((q, j) => (j === i ? p : q)),
        dbl: () => {
          actions.beginEdit(id);
          const rest = manual!.filter((_, j) => j !== i);
          actions.setRoute(id, { ...data?.route, points: rest.length ? rest : undefined });
        },
      }),
    );
  }

  const startDrag = (g: Grip) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let started = false;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return;
        started = true;
        actions.beginEdit(id);
      }
      const p = snap(rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
      actions.setRoute(id, { ...data?.route, points: g.apply(p) });
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const flip = (end: 's' | 't') => {
    actions.beginEdit(id);
    const cur = end === 's' ? sSide : tSide;
    // The hand-drawn bends were made for the old side; start from an automatic route again.
    actions.setRoute(id, { ...data?.route, points: undefined, [end]: cur === 'R' ? 'L' : 'R' });
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`erd-edge ${state}`}
        markerStart={`url(#erd-one${markerSuffix})`}
        markerEnd={`url(#erd-${data?.childCard === '1' ? 'one' : 'many'}${markerSuffix})`}
        interactionWidth={14}
      />
      <EdgeLabelRenderer>
        <div className={`erd-edge-chip pk ${state}`} style={{ transform: `translate(-50%, -135%) translate(${px}px, ${py}px)` }}>
          PK
        </div>
        <div className={`erd-edge-chip fk ${state}`} style={{ transform: `translate(-50%, -135%) translate(${cx}px, ${cy}px)` }}>
          FK
        </div>
        {grips.map((g) => (
          <div
            key={g.key}
            className={`erd-edge-grip ${g.kind} nodrag nopan`}
            title={g.title}
            style={{ transform: `translate(-50%, -50%) translate(${g.at.x}px, ${g.at.y}px)` }}
            onPointerDown={startDrag(g)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              g.dbl?.();
            }}
          />
        ))}
        {selected || data?.hovered ? (
          <div
            className="erd-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, ${editing ? '-160%' : '-50%'}) translate(${labelX}px, ${labelY}px)` }}
          >
            <span className="mono">{data?.label}</span>
            <span className="erd-edge-card">1 : {data?.childCard}</span>
            {data?.onDelete && data.onDelete !== 'NO ACTION' ? <span className="erd-edge-action">on delete {data.onDelete.toLowerCase()}</span> : null}
            {editing ? (
              <>
                <button className="btn mini" title="Attach the line to the other side of the referenced (PK) table" onClick={() => flip('s')}>
                  ⇄ PK side
                </button>
                <button className="btn mini" title="Attach the line to the other side of the referencing (FK) table" onClick={() => flip('t')}>
                  ⇄ FK side
                </button>
                {data?.route ? (
                  <button
                    className="btn mini"
                    title="Forget the manual shape and route this line automatically"
                    onClick={() => {
                      actions.beginEdit(id);
                      actions.setRoute(id, undefined);
                    }}
                  >
                    Reset
                  </button>
                ) : null}
              </>
            ) : null}
            {selected && data?.editable !== false ? (
              <button className="icon-btn danger" title="Delete foreign key (Del)" onClick={() => actions.remove(id)}>
                <CloseIcon size={11} />
              </button>
            ) : null}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

export const RelationEdge = memo(RelationEdgeImpl);

/** SVG marker definitions referenced by the edges (crow's foot notation). */
export function EdgeMarkers() {
  const marker = (id: string, cls: string, d: string) => (
    // refX=20: the marker's right edge sits on the path's endpoint, so the drawing lies on the line
    // just before the table; auto-start-reverse mirrors it for the start of the path.
    <marker id={id} viewBox="0 0 20 20" refX="20" refY="10" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d={d} className={cls} fill="none" strokeWidth="1.5" />
    </marker>
  );
  const one = 'M10 4 L10 16 M0 10 L20 10';
  const many = 'M0 10 L20 10 M7 10 L20 3 M7 10 L20 17';
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        {marker('erd-one', 'erd-marker', one)}
        {marker('erd-one-active', 'erd-marker active', one)}
        {marker('erd-many', 'erd-marker', many)}
        {marker('erd-many-active', 'erd-marker active', many)}
      </defs>
    </svg>
  );
}
