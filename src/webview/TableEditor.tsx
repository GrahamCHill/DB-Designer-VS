import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Column, FkAction, Relation, Schema, Table, newId } from '../shared/model';
import { ChevronIcon, CloseIcon, DownIcon, KeyIcon, LinkIcon, PlusIcon, TrashIcon, UpIcon } from './icons';

export const PG_TYPES = [
  'uuid',
  'text',
  'varchar(255)',
  'char(1)',
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'numeric(18,2)',
  'real',
  'double precision',
  'boolean',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'jsonb',
  'json',
  'bytea',
  'inet',
  'citext',
  'tsvector',
  'text[]',
  'uuid[]',
  'integer[]',
];

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export type Mutate = (fn: (s: Schema) => void, coalesceKey?: string) => void;

interface Props {
  schema: Schema;
  tableId: string;
  focusColumnId?: string;
  mutate: Mutate;
  onClose(): void;
  onDeleted(): void;
}

export function newColumn(name: string, type = 'text'): Column {
  return { id: newId('c'), name, type, nullable: true, pk: false, unique: false };
}

function uniqueColumnName(t: Table, base: string): string {
  let n = base;
  let i = 2;
  while (t.columns.some((c) => c.name.toLowerCase() === n.toLowerCase())) n = `${base}_${i++}`;
  return n;
}

export function addColumnTo(s: Schema, tableId: string): string | undefined {
  const t = s.tables.find((x) => x.id === tableId);
  if (!t) return undefined;
  const c = newColumn(uniqueColumnName(t, 'new_column'));
  t.columns.push(c);
  return c.id;
}

export function TableEditor({ schema, tableId, focusColumnId, mutate, onClose, onDeleted }: Props) {
  const table = schema.tables.find((t) => t.id === tableId);
  const [expanded, setExpanded] = useState<string | undefined>(focusColumnId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(focusColumnId);
    if (focusColumnId) {
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLInputElement>(`[data-col="${CSS.escape(focusColumnId)}"] input`);
        el?.scrollIntoView({ block: 'nearest' });
        el?.focus();
        el?.select();
      });
    }
  }, [focusColumnId, tableId]);

  useEffect(() => setConfirmDelete(false), [tableId]);

  const schemas = useMemo(() => [...new Set(schema.tables.map((t) => t.schema))].sort(), [schema.tables]);

  // Candidate referenced columns: PK/unique columns of every table (plus anything already referenced).
  const refOptions = useMemo(() => {
    const out: { table: Table; cols: Column[] }[] = [];
    for (const t of schema.tables) {
      const cols = t.columns.filter((c) => c.pk || c.unique);
      if (cols.length) out.push({ table: t, cols });
    }
    return out;
  }, [schema.tables]);

  if (!table) return null;

  const relFor = (colId: string): Relation | undefined =>
    schema.relations.find((r) => r.fromTable === table.id && r.fromColumns.includes(colId));

  const setTable = (patch: Partial<Table>, key?: string) =>
    mutate((s) => {
      const t = s.tables.find((x) => x.id === tableId);
      if (t) Object.assign(t, patch);
    }, key);

  const setCol = (colId: string, patch: Partial<Column>, key?: string) =>
    mutate((s) => {
      const c = s.tables.find((x) => x.id === tableId)?.columns.find((x) => x.id === colId);
      if (c) {
        Object.assign(c, patch);
        if (patch.pk) c.nullable = false;
      }
    }, key);

  const moveCol = (colId: string, dir: -1 | 1) =>
    mutate((s) => {
      const t = s.tables.find((x) => x.id === tableId);
      if (!t) return;
      const i = t.columns.findIndex((c) => c.id === colId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= t.columns.length) return;
      [t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
    });

  const deleteCol = (colId: string) =>
    mutate((s) => {
      const t = s.tables.find((x) => x.id === tableId);
      if (!t) return;
      t.columns = t.columns.filter((c) => c.id !== colId);
      s.relations = s.relations.filter((r) => !r.fromColumns.includes(colId) && !r.toColumns.includes(colId));
      if (t.uniques) t.uniques = t.uniques.filter((u) => !u.columns.includes(colId));
    });

  const setReference = (colId: string, value: string) =>
    mutate((s) => {
      const existing = s.relations.find((r) => r.fromTable === tableId && r.fromColumns.includes(colId));
      if (!value) {
        s.relations = s.relations.filter((r) => r !== existing);
        return;
      }
      const [toTable, toCol] = value.split('\u0000');
      if (existing && existing.fromColumns.length === 1) {
        existing.toTable = toTable;
        existing.toColumns = [toCol];
        existing.name = undefined;
      } else {
        s.relations.push({ id: newId('r'), fromTable: tableId, fromColumns: [colId], toTable, toColumns: [toCol] });
      }
      // Default the FK column's type to the referenced column's type when it is still a placeholder.
      const t = s.tables.find((x) => x.id === tableId);
      const c = t?.columns.find((x) => x.id === colId);
      const target = s.tables.find((x) => x.id === toTable)?.columns.find((x) => x.id === toCol);
      if (c && target && (!c.type || c.type === 'text')) c.type = target.type.replace(/^(big)?serial$/, (m) => (m === 'bigserial' ? 'bigint' : 'integer'));
    });

  const setRelAction = (colId: string, which: 'onDelete' | 'onUpdate', v: FkAction) =>
    mutate((s) => {
      const r = s.relations.find((x) => x.fromTable === tableId && x.fromColumns.includes(colId));
      if (r) r[which] = v === 'NO ACTION' ? undefined : v;
    });

  const addCol = () => {
    let created: string | undefined;
    mutate((s) => {
      created = addColumnTo(s, tableId);
    });
    if (created) setExpanded(created);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLInputElement>(`[data-col="${CSS.escape(created ?? '')}"] input`);
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus();
      el?.select();
    });
  };

  const deleteTable = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    mutate((s) => {
      s.tables = s.tables.filter((t) => t.id !== tableId);
      s.relations = s.relations.filter((r) => r.fromTable !== tableId && r.toTable !== tableId);
    });
    onDeleted();
  };

  const tableById = new Map(schema.tables.map((t) => [t.id, t]));

  return (
    <aside className="erd-editor" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header>
        <h2>Edit table</h2>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="erd-editor-body">
        <div className="field-row">
          <label className="field">
            <span>Schema</span>
            <input list="erd-schemas" value={table.schema} onChange={(e) => setTable({ schema: e.target.value.trim() }, `t-schema-${tableId}`)} />
            <datalist id="erd-schemas">
              {schemas.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className="field grow">
            <span>Name</span>
            <input value={table.name} onChange={(e) => setTable({ name: e.target.value.trim() }, `t-name-${tableId}`)} spellCheck={false} />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <input
            value={table.comment ?? ''}
            placeholder="Optional"
            onChange={(e) => setTable({ comment: e.target.value || undefined }, `t-comment-${tableId}`)}
          />
        </label>

        <div className="erd-editor-section">
          <h3>Columns</h3>
          <div className="col-head">
            <span />
            <span>Name</span>
            <span>Type</span>
            <span title="Primary key">PK</span>
            <span title="Nullable">Null</span>
            <span />
          </div>
          <div ref={listRef}>
            {table.columns.map((c, i) => {
              const rel = relFor(c.id);
              const relTarget = rel ? tableById.get(rel.toTable) : undefined;
              const relCol = rel && relTarget ? relTarget.columns.find((x) => x.id === rel.toColumns[rel.fromColumns.indexOf(c.id)]) : undefined;
              const open = expanded === c.id;
              return (
                <div key={c.id} className={`col-edit ${open ? 'open' : ''}`} data-col={c.id}>
                  <div className="col-line">
                    <button className="icon-btn" title={open ? 'Hide details' : 'More options'} onClick={() => setExpanded(open ? undefined : c.id)}>
                      <ChevronIcon open={open} size={12} />
                    </button>
                    <input
                      className="mono"
                      value={c.name}
                      spellCheck={false}
                      onChange={(e) => setCol(c.id, { name: e.target.value.trim() }, `c-name-${c.id}`)}
                    />
                    <input
                      className="mono"
                      list="erd-types"
                      value={c.type}
                      spellCheck={false}
                      onChange={(e) => setCol(c.id, { type: e.target.value }, `c-type-${c.id}`)}
                    />
                    <input type="checkbox" title="Primary key" checked={c.pk} onChange={(e) => setCol(c.id, { pk: e.target.checked })} />
                    <input
                      type="checkbox"
                      title="Nullable"
                      checked={c.nullable && !c.pk}
                      disabled={c.pk}
                      onChange={(e) => setCol(c.id, { nullable: e.target.checked })}
                    />
                    <span className="col-markers">
                      {c.pk ? (
                        <span className="ic pk" title="Primary key">
                          <KeyIcon size={11} />
                        </span>
                      ) : null}
                      {rel ? (
                        <span className="ic fk" title={`References ${relTarget?.name}.${relCol?.name}`}>
                          <LinkIcon size={11} />
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {open ? (
                    <div className="col-details">
                      <label className="field">
                        <span>Default value</span>
                        <input
                          className="mono"
                          value={c.default ?? ''}
                          placeholder="e.g. now(), gen_random_uuid(), 0, 'draft'"
                          spellCheck={false}
                          onChange={(e) => setCol(c.id, { default: e.target.value || undefined }, `c-def-${c.id}`)}
                        />
                      </label>
                      <div className="checks">
                        <label>
                          <input type="checkbox" checked={c.unique} onChange={(e) => setCol(c.id, { unique: e.target.checked })} /> Unique
                        </label>
                        <label>
                          <input type="checkbox" checked={!!c.identity} onChange={(e) => setCol(c.id, { identity: e.target.checked || undefined })} />{' '}
                          Identity
                        </label>
                      </div>
                      <label className="field">
                        <span>Foreign key → references</span>
                        {rel && rel.fromColumns.length > 1 ? (
                          <div className="muted small">
                            Part of composite key ({rel.fromColumns.length} columns) → {relTarget?.name}. Delete the edge to remove it.
                          </div>
                        ) : (
                          <select value={rel && relCol ? `${rel.toTable}\u0000${relCol.id}` : ''} onChange={(e) => setReference(c.id, e.target.value)}>
                            <option value="">(none)</option>
                            {rel && relTarget && relCol && !(relCol.pk || relCol.unique) ? (
                              <option value={`${rel.toTable}\u0000${relCol.id}`}>
                                {relTarget.schema ? relTarget.schema + '.' : ''}
                                {relTarget.name}.{relCol.name}
                              </option>
                            ) : null}
                            {refOptions.map(({ table: t, cols }) => (
                              <optgroup key={t.id} label={`${t.schema ? t.schema + '.' : ''}${t.name}`}>
                                {cols.map((rc) => (
                                  <option key={rc.id} value={`${t.id}\u0000${rc.id}`}>
                                    {t.name}.{rc.name} ({rc.type})
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        )}
                      </label>
                      {rel ? (
                        <div className="field-row">
                          <label className="field grow">
                            <span>On delete</span>
                            <select value={rel.onDelete ?? 'NO ACTION'} onChange={(e) => setRelAction(c.id, 'onDelete', e.target.value as FkAction)}>
                              {FK_ACTIONS.map((a) => (
                                <option key={a}>{a}</option>
                              ))}
                            </select>
                          </label>
                          <label className="field grow">
                            <span>On update</span>
                            <select value={rel.onUpdate ?? 'NO ACTION'} onChange={(e) => setRelAction(c.id, 'onUpdate', e.target.value as FkAction)}>
                              {FK_ACTIONS.map((a) => (
                                <option key={a}>{a}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ) : null}
                      <label className="field">
                        <span>Description</span>
                        <input
                          value={c.comment ?? ''}
                          placeholder="Optional"
                          onChange={(e) => setCol(c.id, { comment: e.target.value || undefined }, `c-comment-${c.id}`)}
                        />
                      </label>
                      <div className="col-detail-actions">
                        <button className="btn" disabled={i === 0} onClick={() => moveCol(c.id, -1)} title="Move up">
                          <UpIcon size={12} /> Up
                        </button>
                        <button className="btn" disabled={i === table.columns.length - 1} onClick={() => moveCol(c.id, 1)} title="Move down">
                          <DownIcon size={12} /> Down
                        </button>
                        <span className="grow" />
                        <button className="btn danger" onClick={() => deleteCol(c.id)}>
                          <TrashIcon size={12} /> Delete column
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <datalist id="erd-types">
            {PG_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button className="btn add-col" onClick={addCol}>
            <PlusIcon size={12} /> Add column
          </button>
        </div>
      </div>
      <footer>
        <button className={`btn danger ${confirmDelete ? 'solid' : ''}`} onClick={deleteTable}>
          <TrashIcon size={12} /> {confirmDelete ? 'Click again to delete table' : 'Delete table'}
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </aside>
  );
}
