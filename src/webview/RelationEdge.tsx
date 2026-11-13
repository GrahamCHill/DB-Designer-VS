import React, { memo, useContext } from 'react';
import { BaseEdge, Edge, EdgeLabelRenderer, EdgeProps, Position, getSmoothStepPath } from '@xyflow/react';
import { CloseIcon } from './icons';

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
}

export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;

export const EdgeActionsContext = React.createContext<{ remove(id: string): void }>({ remove() {} });

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

/**
 * The edge runs from the referenced (parent / PK) column to the referencing (child / FK) column.
 * The parent end carries a "PK · 1" chip and a bar; the child end an "FK · N" chip and a crow's foot.
 */
function RelationEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<RelationEdgeType>) {
  const actions = useContext(EdgeActionsContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
    offset: 28,
  });
  const active = selected || data?.highlighted;
  const state = active ? 'active' : data?.dimmed ? 'dimmed' : '';
  const [px, py] = offset(sourceX, sourceY, sourcePosition, 24);
  const [cx, cy] = offset(targetX, targetY, targetPosition, 24);
  const markerSuffix = active ? '-active' : '';
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
        {selected || data?.hovered ? (
          <div className="erd-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <span className="mono">{data?.label}</span>
            <span className="erd-edge-card">1 : {data?.childCard}</span>
            {data?.onDelete && data.onDelete !== 'NO ACTION' ? <span className="erd-edge-action">on delete {data.onDelete.toLowerCase()}</span> : null}
            {selected ? (
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
