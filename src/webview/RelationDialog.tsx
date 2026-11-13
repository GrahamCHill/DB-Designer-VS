import React, { useEffect, useMemo, useState } from 'react';
import { Column, FkAction, Schema, Table, qualifiedName } from '../shared/model';
import { SchemaOp } from '../shared/ops';
import { CloseIcon, KeyIcon, LinkIcon } from './icons';

export interface RelationDraft {
  childTable?: string;
  childColumn?: string;
  parentTable?: string;
  parentColumn?: string;
}

type Cardinality = 'many-to-one' | 'one-to-one' | 'many-to-many';

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
const NEW = '__new__';

/** "users" -> "user", "categories" -> "category" (good enough for column names). */
function singular(name: string): string {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y');
  if (/(ss|us)$/i.test(name)) return name;
  if (/(xes|ches|shes|sses)$/i.test(name)) return name.replace(/es$/i, '');
  return name.replace(/s$/i, '');
}

/** Type a referencing column should have: serial → integer, identity stays the base type. */
function fkType(c: Column | undefined): string {
  if (!c) return 'bigint';
  const t = c.type.toLowerCase();
  if (t === 'serial' || t === 'serial4') return 'integer';
  if (t === 'bigserial' || t === 'serial8') return 'bigint';
  if (t === 'smallserial' || t === 'serial2') return 'smallint';
  return c.type;
}

const sameType = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, '') === b.toLowerCase().replace(/\s+/g, '');

interface Props {
  schema: Schema;
  draft: RelationDraft;
  onCreate(ops: SchemaOp[], summary: string): void;
  onClose(): void;
}

export function RelationDialog({ schema, draft, onCreate, onClose }: Props) {
  const tables = useMemo(() => [...schema.tables].sort((a, b) => qualifiedName(a).localeCompare(qualifiedName(b))), [schema.tables]);
  const byId = useMemo(() => new Map(schema.tables.map((t) => [t.id, t])), [schema.tables]);
  const firstKey = (t?: Table) => t?.columns.find((c) => c.pk)?.id ?? t?.columns.find((c) => c.unique)?.id ?? t?.columns[0]?.id ?? '';

  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const [childTable, setChildTable] = useState(draft.childTable ?? tables[0]?.id ?? '');
  const [childCol, setChildCol] = useState(draft.childColumn ?? (draft.childTable ? NEW : ''));
  const [parentTable, setParentTable] = useState(draft.parentTable ?? '');
  const [parentCol, setParentCol] = useState(draft.parentColumn ?? firstKey(byId.get(draft.parentTable ?? '')));
  const [newColName, setNewColName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [onDelete, setOnDelete] = useState<FkAction>('NO ACTION');
  const [onUpdate, setOnUpdate] = useState<FkAction>('NO ACTION');
  const [makeUnique, setMakeUnique] = useState(true);
  const [alignType, setAlignType] = useState(true);

  const ct = byId.get(childTable);
  const pt = byId.get(parentTable);
  const pc = pt?.columns.find((c) => c.id === parentCol);
  const cc = ct?.columns.find((c) => c.id === childCol);

  // Suggested names follow the "<parent>_<key>" convention, e.g. user_id.
  const suggestedCol = pt && pc ? `${singular(pt.name)}_${pc.name}` : '';
  useEffect(() => setNewColName(suggestedCol), [suggestedCol]);
  useEffect(() => {
    if (ct && pt) setJoinName(`${singular(ct.name)}_${pt.name}`);
  }, [ct?.name, pt?.name]);

  const pickParentTable = (id: string) => {
    setParentTable(id);
    setParentCol(firstKey(byId.get(id)));
  };
  const swap = () => {
    setChildTable(parentTable);
    setChildCol(parentCol || NEW);
    setParentTable(childTable);
    setParentCol(childCol && childCol !== NEW ? childCol : firstKey(ct));
  };

  // ---- validation ----
  const problems: string[] = [];
  const notes: React.ReactNode[] = [];
  if (!ct || !pt) problems.push('Choose both tables.');
  if (cardinality !== 'many-to-many') {
    if (!pc) problems.push('Choose the referenced (primary key) column.');
    if (childCol === NEW && !newColName.trim()) problems.push('Name the new foreign-key column.');
    if (childCol === NEW && ct?.columns.some((c) => c.name.toLowerCase() === newColName.trim().toLowerCase()))
      problems.push(`${ct?.name} already has a column "${newColName.trim()}". Pick it from the list instead.`);
    if (!childCol) problems.push('Choose the foreign-key column.');
    if (cc && pc && cc.id === pc.id) problems.push('A column cannot reference itself.');
  } else {
    const ak = ct?.columns.filter((c) => c.pk) ?? [];
    const bk = pt?.columns.filter((c) => c.pk) ?? [];
    if (ct && !ak.length) problems.push(`${ct.name} has no primary key.`);
    if (pt && !bk.length) problems.push(`${pt.name} has no primary key.`);
    if (schema.tables.some((t) => t.name.toLowerCase() === joinName.trim().toLowerCase())) problems.push(`A table named "${joinName}" already exists.`);
  }
  const parentNeedsKey = cardinality !== 'many-to-many' && pc && !pc.pk && !pc.unique;
  const typeMismatch = cardinality !== 'many-to-many' && cc && pc && !sameType(cc.type, fkType(pc));
  if (parentNeedsKey && !makeUnique) problems.push('PostgreSQL only allows foreign keys to primary-key or unique columns.');

  const create = () => {
    if (!ct || !pt) return;
    const childName = qualifiedName(ct);
    const parentName = qualifiedName(pt);
    const ops: SchemaOp[] = [];
    let summary = '';
    if (cardinality === 'many-to-many') {
      const join = `${ct.schema ? ct.schema + '.' : ''}${joinName.trim()}`;
      const ak = ct.columns.filter((c) => c.pk);
      const bk = pt.columns.filter((c) => c.pk);
      const aCols = ak.map((c) => ({ name: `${singular(ct.name)}_${c.name}`, type: fkType(c), nullable: false, primary_key: false }));
      let bCols = bk.map((c) => ({ name: `${singular(pt.name)}_${c.name}`, type: fkType(c), nullable: false, primary_key: false }));
      if (ct.id === pt.id) bCols = bCols.map((c) => ({ ...c, name: `related_${c.name}` }));
      ops.push({ op: 'add_table', table: join, columns: [...aCols, ...bCols] });
      ops.push({ op: 'set_primary_key', table: join, columns: [...aCols, ...bCols].map((c) => c.name) });
      ops.push({ op: 'add_foreign_key', table: join, columns: aCols.map((c) => c.name), ref_table: childName, ref_columns: ak.map((c) => c.name), on_delete: 'CASCADE' });
      ops.push({ op: 'add_foreign_key', table: join, columns: bCols.map((c) => c.name), ref_table: parentName, ref_columns: bk.map((c) => c.name), on_delete: 'CASCADE' });
      summary = `Created join table ${joinName} for ${ct.name} ↔ ${pt.name}`;
    } else {
      if (!pc) return;
      let fkName = cc?.name ?? '';
      if (childCol === NEW) {
        fkName = newColName.trim();
        ops.push({ op: 'add_column', table: childName, column: { name: fkName, type: fkType(pc), nullable: true, unique: cardinality === 'one-to-one' } });
      } else {
        if (typeMismatch && alignType) ops.push({ op: 'alter_column', table: childName, column: fkName, type: fkType(pc) });
        if (cardinality === 'one-to-one' && cc && !cc.unique && !cc.pk) ops.push({ op: 'alter_column', table: childName, column: fkName, unique: true });
      }
      if (parentNeedsKey && makeUnique) ops.push({ op: 'alter_column', table: parentName, column: pc.name, unique: true });
      ops.push({
        op: 'add_foreign_key',
        table: childName,
        columns: [fkName],
        ref_table: parentName,
        ref_columns: [pc.name],
        on_delete: onDelete === 'NO ACTION' ? undefined : onDelete,
        on_update: onUpdate === 'NO ACTION' ? undefined : onUpdate,
      });
      summary = `${ct.name}.${fkName} → ${pt.name}.${pc.name} (${cardinality === 'one-to-one' ? '1 : 1' : 'N : 1'})`;
    }
    onCreate(ops, summary);
  };

  const tableOptions = tables.map((t) => (
    <option key={t.id} value={t.id}>
      {qualifiedName(t)}
    </option>
  ));

  return (
    <div className="erd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="erd-modal" role="dialog" aria-label="Create relationship" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>Create relationship</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="erd-modal-body">
          <div className="seg">
            {(
              [
                ['many-to-one', 'Many-to-one', 'Each child row points to one parent row'],
                ['one-to-one', 'One-to-one', 'The foreign key column is also unique'],
                ['many-to-many', 'Many-to-many', 'Creates a join table with two foreign keys'],
              ] as [Cardinality, string, string][]
            ).map(([v, label, tip]) => (
              <button key={v} className={`seg-btn ${cardinality === v ? 'on' : ''}`} title={tip} onClick={() => setCardinality(v)}>
                {label}
              </button>
            ))}
          </div>

          <div className="rel-grid">
            <div className="rel-side">
              <div className="rel-side-title">
                <span className="ic fk">
                  <LinkIcon size={12} />
                </span>{' '}
                {cardinality === 'many-to-many' ? 'Table A' : 'Foreign key (child / referencing)'}
              </div>
              <label className="field">
                <span>Table</span>
                <select value={childTable} onChange={(e) => (setChildTable(e.target.value), setChildCol(NEW))}>
                  {tableOptions}
                </select>
              </label>
              {cardinality !== 'many-to-many' ? (
                <label className="field">
                  <span>Column</span>
                  <select value={childCol} onChange={(e) => setChildCol(e.target.value)}>
                    <option value={NEW}>+ New column…</option>
                    {ct?.columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.type})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cardinality !== 'many-to-many' && childCol === NEW ? (
                <label className="field">
                  <span>New column name</span>
                  <input className="mono" value={newColName} onChange={(e) => setNewColName(e.target.value.trim())} spellCheck={false} />
                  <span className="muted small">Type: {fkType(pc)}</span>
                </label>
              ) : null}
            </div>

            <button className="btn swap" title="Swap sides" onClick={swap}>
              ⇄
            </button>

            <div className="rel-side">
              <div className="rel-side-title">
                <span className="ic pk">
                  <KeyIcon size={12} />
                </span>{' '}
                {cardinality === 'many-to-many' ? 'Table B' : 'Primary key (parent / referenced)'}
              </div>
              <label className="field">
                <span>Table</span>
                <select value={parentTable} onChange={(e) => pickParentTable(e.target.value)}>
                  <option value="">Choose…</option>
                  {tableOptions}
                </select>
              </label>
              {cardinality !== 'many-to-many' ? (
                <label className="field">
                  <span>Column</span>
                  <select value={parentCol} onChange={(e) => setParentCol(e.target.value)}>
                    {pt?.columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pk ? '🔑 ' : c.unique ? '◎ ' : ''}
                        {c.name} ({c.type})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </div>

          {cardinality === 'many-to-many' ? (
            <label className="field">
              <span>Join table name</span>
              <input className="mono" value={joinName} onChange={(e) => setJoinName(e.target.value.trim())} spellCheck={false} />
              <span className="muted small">
                Gets a composite primary key from both tables' keys, and ON DELETE CASCADE foreign keys to each.
              </span>
            </label>
          ) : (
            <div className="field-row">
              <label className="field grow">
                <span>On delete</span>
                <select value={onDelete} onChange={(e) => setOnDelete(e.target.value as FkAction)}>
                  {FK_ACTIONS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>On update</span>
                <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value as FkAction)}>
                  {FK_ACTIONS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {parentNeedsKey ? (
            <label className="check-note">
              <input type="checkbox" checked={makeUnique} onChange={(e) => setMakeUnique(e.target.checked)} />
              <span>
                Make <b>{pt?.name}.{pc?.name}</b> UNIQUE. It is not a key yet, and a foreign key must reference a primary-key or unique column.
              </span>
            </label>
          ) : null}
          {typeMismatch && childCol !== NEW ? (
            <label className="check-note">
              <input type="checkbox" checked={alignType} onChange={(e) => setAlignType(e.target.checked)} />
              <span>
                Change <b>{ct?.name}.{cc?.name}</b> from <code>{cc?.type}</code> to <code>{fkType(pc)}</code> to match the referenced column.
              </span>
            </label>
          ) : null}
          {notes}
          {problems.length ? (
            <ul className="problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <footer>
          <span className="muted small grow">Tip: you can also drag from a column's dot to another column.</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={problems.length > 0} onClick={create}>
            Create relationship
          </button>
        </footer>
      </div>
    </div>
  );
}
