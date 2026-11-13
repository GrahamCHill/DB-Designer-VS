import React, { memo, useContext, useEffect, useState } from 'react';
import { Node, NodeProps, NodeResizer } from '@xyflow/react';
import type { DiagramGroup } from '../shared/model';
import { GROUP_COLORS } from './groups';

export interface GroupNodeData extends Record<string, unknown> {
  group: DiagramGroup;
  depth: number;
  members: number;
  editable: boolean;
}
export type GroupNodeType = Node<GroupNodeData, 'tablegroup'>;

export interface GroupActions {
  update(id: string, patch: Partial<DiagramGroup>): void;
  remove(id: string): void;
  resized(id: string, rect: { x: number; y: number; w: number; h: number }): void;
}
export const GroupActionsContext = React.createContext<GroupActions>({ update() {}, remove() {}, resized() {} });

function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '62, 207, 142';
}

function GroupNodeImpl({ data, selected }: NodeProps<GroupNodeType>) {
  const actions = useContext(GroupActionsContext);
  const { group: g, depth, editable } = data;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(g.name);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setName(g.name), [g.name]);
  useEffect(() => {
    if (!editing) setConfirm(false);
  }, [editing]);

  const style = { '--group-color': g.color, '--group-color-rgb': hexToRgb(g.color) } as React.CSSProperties;
  return (
    <div className={`erd-group ${selected ? 'selected' : ''} ${depth > 0 ? 'nested' : ''}`} style={style}>
      {editable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={200}
          minHeight={120}
          lineClassName="erd-group-resize-line"
          handleClassName="erd-group-resize-handle"
          onResizeEnd={(_, p) => actions.resized(g.id, { x: p.x, y: p.y, w: p.width, h: p.height })}
        />
      ) : null}
      <div className="erd-group-header" onDoubleClick={() => editable && setEditing(true)}>
        <span className="erd-group-tag">{depth > 0 ? 'SUB' : 'GRP'}</span>
        <span className="erd-group-name">{g.name}</span>
        {depth > 0 ? (
          <span className="erd-group-depth" title="Nested group">
            {depth}
          </span>
        ) : null}
        <span className="erd-group-count" title="Tables in this group">
          {data.members}
        </span>
        {editable ? (
          <button className="erd-group-edit nodrag" onClick={() => setEditing(!editing)} title="Edit group">
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="erd-group-editor nodrag nopan" onMouseDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                actions.update(g.id, { name: name.trim() || g.name });
                setEditing(false);
              } else if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={() => actions.update(g.id, { name: name.trim() || g.name })}
          />
          <div className="erd-group-swatches">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${c === g.color ? 'on' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => actions.update(g.id, { color: c })}
              />
            ))}
          </div>
          <div className="erd-group-editor-actions">
            <button className={`btn danger ${confirm ? 'solid' : ''}`} onClick={() => (confirm ? actions.remove(g.id) : setConfirm(true))}>
              {confirm ? 'Click again: delete group (tables stay)' : 'Delete group'}
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={() => (actions.update(g.id, { name: name.trim() || g.name }), setEditing(false))}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
