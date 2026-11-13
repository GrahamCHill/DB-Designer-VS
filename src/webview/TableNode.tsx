import React, { memo, useContext, useEffect } from 'react';
import { Handle, NodeProps, Position, Node, useUpdateNodeInternals } from '@xyflow/react';
import { Table } from '../shared/model';
import { DiamondIcon, EditIcon, HashIcon, KeyIcon, LinkIcon, PlusIcon, UniqueIcon } from './icons';
import { NODE_WIDTH } from './layout';

export interface TableNodeData extends Record<string, unknown> {
  table: Table;
  /** Column ids that are the referencing side of an FK, mapped to "schema.table.column" of the target. */
  fkTargets: Record<string, string>;
  /** Highlighted column ids (related to the selected table/edge). */
  hlCols: string;
  dimmed: boolean;
  related: boolean;
  showSchema: boolean;
  /** Column ids added/changed in the editor (vs. baseline). */
  changed: string;
  isNew: boolean;
}

export type TableNodeType = Node<TableNodeData, 'table'>;

export interface NodeActions {
  edit(tableId: string, columnId?: string): void;
  addColumn(tableId: string): void;
}

export const NodeActionsContext = React.createContext<NodeActions>({ edit() {}, addColumn() {} });

function TableNodeImpl({ id, data, selected }: NodeProps<TableNodeType>) {
  const actions = useContext(NodeActionsContext);
  // Columns (and so connection handles) changed: let React Flow re-measure them so edges attach.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleKey = data.table.columns.map((c) => c.id).join("|");
  useEffect(() => updateNodeInternals(id), [handleKey, id, updateNodeInternals]);
  const { table, fkTargets, dimmed, related, showSchema, isNew } = data;
  const hl = data.hlCols ? new Set(data.hlCols.split('|')) : undefined;
  const changed = data.changed ? new Set(data.changed.split('|')) : undefined;
  const cls = ['erd-table', selected ? 'selected' : '', dimmed ? 'dimmed' : '', related ? 'related' : '', isNew ? 'is-new' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} style={{ width: NODE_WIDTH }} onDoubleClick={() => actions.edit(table.id)}>
      <div className="erd-table-header" title={table.comment || undefined}>
        <span className="erd-table-name">
          {showSchema && table.schema ? <span className="erd-table-schema">{table.schema}.</span> : null}
          {table.name}
        </span>
        <span className="erd-table-actions nodrag">
          <button className="icon-btn" title="Add column" onClick={(e) => (e.stopPropagation(), actions.addColumn(table.id))}>
            <PlusIcon />
          </button>
          <button className="icon-btn" title="Edit table" onClick={(e) => (e.stopPropagation(), actions.edit(table.id))}>
            <EditIcon />
          </button>
        </span>
      </div>
      <div className="erd-columns">
        {table.columns.length === 0 ? <div className="erd-empty">No columns</div> : null}
        {table.columns.map((c) => {
          const fk = fkTargets[c.id];
          const rowCls = ['erd-col', hl?.has(c.id) ? 'hl' : '', changed?.has(c.id) ? 'changed' : ''].filter(Boolean).join(' ');
          const tip = [
            `${c.name}: ${c.type || '(no type)'}`,
            c.pk ? 'Primary key' : '',
            fk ? `Foreign key → ${fk}` : '',
            c.unique && !c.pk ? 'Unique' : '',
            c.identity ? 'Identity / auto-increment' : '',
            c.nullable && !c.pk ? 'Nullable' : 'Not null',
            c.default ? `Default: ${c.default}` : '',
            c.comment ? `\n${c.comment}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div key={c.id} className={rowCls} title={tip} onDoubleClick={(e) => (e.stopPropagation(), actions.edit(table.id, c.id))}>
              <Handle type="source" position={Position.Left} id={`${c.id}::L`} className="erd-handle" />
              <span className="erd-col-icons">
                {c.pk ? (
                  <span className="ic pk">
                    <KeyIcon />
                  </span>
                ) : fk ? (
                  <span className="ic fk">
                    <LinkIcon />
                  </span>
                ) : (
                  <span className={`ic null ${c.nullable ? '' : 'notnull'}`}>
                    <DiamondIcon filled={!c.nullable} size={10} />
                  </span>
                )}
              </span>
              <span className={`erd-col-name ${c.pk ? 'is-pk' : ''}`}>{c.name}</span>
              <span className="erd-col-flags">
                {c.pk && fk ? (
                  <span className="ic fk" title={`Foreign key → ${fk}`}>
                    <LinkIcon size={11} />
                  </span>
                ) : null}
                {c.identity ? (
                  <span className="ic" title="Identity">
                    <HashIcon size={11} />
                  </span>
                ) : null}
                {c.unique && !c.pk ? (
                  <span className="ic" title="Unique">
                    <UniqueIcon size={11} />
                  </span>
                ) : null}
              </span>
              <span className="erd-col-type">{c.type}</span>
              <Handle type="source" position={Position.Right} id={`${c.id}::R`} className="erd-handle" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);
