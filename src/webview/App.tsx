import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Connection,
  ConnectionMode,
  Controls,
  EdgeChange,
  MiniMap,
  NodeChange,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import {
  Column,
  ErdFile,
  HostToWebview,
  Layout,
  Position,
  Schema,
  Table,
  ViewMode,
  WebviewToHost,
  cloneSchema,
  emptySchema,
  newId,
  qualifiedName,
  tableKey,
} from '../shared/model';
import { SchemaOp, applyOps } from '../shared/ops';
import { AiSuggestion } from '../shared/ai';
import { RelationDialog, RelationDraft } from './RelationDialog';
import { AiPanel, AiState } from './AiPanel';
import { Box, DARK, LIGHT, boxFor, edgeSides, renderDiagram } from './exportImage';
import { NodeActions, NodeActionsContext, TableNode, TableNodeData, TableNodeType } from './TableNode';
import { EdgeActionsContext, EdgeMarkers, RelationEdge, RelationEdgeType } from './RelationEdge';
import { Mutate, TableEditor, addColumnTo, newColumn } from './TableEditor';
import { NODE_WIDTH, autoLayout, placeMissing } from './layout';
import { DiamondIcon, HashIcon, KeyIcon, LinkIcon, UniqueIcon } from './icons';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);

const nodeTypes = { table: TableNode };
const edgeTypes = { relation: RelationEdge };

/** Supabase/managed-Postgres internal schemas hidden by default for live connections. */
const INTERNAL_SCHEMAS = new Set([
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'supabase_functions',
  'supabase_migrations',
  'extensions',
  'graphql',
  'graphql_public',
  'pgsodium',
  'pgsodium_masks',
  'vault',
  'net',
  'pgbouncer',
  'cron',
  '_analytics',
  'topology',
  'tiger',
]);

interface Meta {
  title: string;
  sourceLabel: string;
  warnings: string[];
  readOnlySource: boolean;
  mode: ViewMode;
  canSaveFile: boolean;
}

interface History {
  past: Schema[];
  future: Schema[];
  lastKey?: string;
  lastTime: number;
}

function colSig(c: Column): string {
  return [c.name, c.type, c.nullable, c.pk, c.unique, c.default ?? '', !!c.identity, c.comment ?? ''].join('\u0001');
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Schema new tables go into when an operation does not name one. */
function defaultSchemaOf(s: Schema): string {
  if (s.dialect === 'mssql') return 'dbo';
  if (s.dialect === 'mysql' || s.dialect === 'sqlite') return '';
  if (!s.tables.length || s.tables.some((t) => t.schema === 'public')) return 'public';
  const counts = new Map<string, number>();
  for (const t of s.tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const relIdOf = (edgeId: string) => edgeId.split('::')[0];
const colIdOfHandle = (h: string | null | undefined) => (h ? h.replace(/::[LR]$/, '') : '');

export function App() {
  const rf = useReactFlow<TableNodeType, RelationEdgeType>();
  const [meta, setMeta] = useState<Meta>();
  const [baseline, setBaseline] = useState<Schema>(emptySchema());
  const [schema, setSchemaState] = useState<Schema>(emptySchema());
  const schemaRef = useRef(schema);
  const history = useRef<History>({ past: [], future: [], lastTime: 0 });
  const [historyTick, setHistoryTick] = useState(0);
  const posRef = useRef<Record<string, Position>>({});
  const [nodes, setNodes] = useState<TableNodeType[]>([]);
  const [hoverTable, setHoverTable] = useState<string>();
  const [hoverEdge, setHoverEdge] = useState<string>();
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ tableId: string; columnId?: string; nonce: number }>();
  const [hiddenSchemas, setHiddenSchemas] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<'export' | 'share' | 'schemas' | 'warnings' | undefined>();
  const [search, setSearch] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const [toast, setToast] = useState<string>();
  const [relDraft, setRelDraft] = useState<RelationDraft>();
  const [aiOpen, setAiOpen] = useState(false);
  const [ai, setAi] = useState<AiState>({ loading: false, applied: {} });
  const [aiProvider, setAiProvider] = useState('');
  const [exporting, setExporting] = useState(false);
  const [imageTheme, setImageTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('erd.imageTheme') as 'light' | 'dark') || 'light';
    } catch {
      return 'light';
    }
  });
  const firstLoad = useRef(true);
  const editable = meta?.mode !== 'standalone';

  const setSchema = useCallback((s: Schema) => {
    schemaRef.current = s;
    setSchemaState(s);
  }, []);

  // ---- persistence ------------------------------------------------------

  const baselineJson = useMemo(() => JSON.stringify(baseline), [baseline]);
  const dirty = useMemo(() => JSON.stringify(schema) !== baselineJson, [schema, baselineJson]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const currentLayout = useCallback((): Layout => {
    const layout: Layout = {};
    for (const t of schemaRef.current.tables) {
      const p = posRef.current[t.id];
      if (p) layout[tableKey(t)] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return layout;
  }, []);

  const saveTimer = useRef<number>();
  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      post({ type: 'saveState', layout: currentLayout(), working: schemaRef.current, dirty: dirtyRef.current });
    }, 400);
  }, [currentLayout]);

  // ---- mutations with undo/redo ----------------------------------------

  const mutate: Mutate = useCallback(
    (fn, key) => {
      const prev = schemaRef.current;
      const h = history.current;
      const now = Date.now();
      if (!(key && key === h.lastKey && now - h.lastTime < 1500)) {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
      }
      h.lastKey = key;
      h.lastTime = now;
      h.future = [];
      const next = cloneSchema(prev);
      fn(next);
      setSchema(next);
      setHistoryTick((x) => x + 1);
      scheduleSave();
    },
    [setSchema, scheduleSave],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(schemaRef.current);
    h.lastKey = undefined;
    setSchema(prev);
    setHistoryTick((x) => x + 1);
    scheduleSave();
  }, [setSchema, scheduleSave]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(schemaRef.current);
    h.lastKey = undefined;
    setSchema(next);
    setHistoryTick((x) => x + 1);
    scheduleSave();
  }, [setSchema, scheduleSave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        setMenu(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---- messages from the extension host ----------------------------------

  useEffect(() => {
    const onMsg = (e: MessageEvent<HostToWebview>) => {
      const m = e.data;
      if (m.type === 'load') {
        setMeta({
          title: m.title,
          sourceLabel: m.sourceLabel,
          warnings: m.warnings,
          readOnlySource: m.readOnlySource,
          mode: m.mode ?? 'extension',
          canSaveFile: !!m.canSaveFile,
        });
        if (m.aiProvider) setAiProvider(m.aiProvider);
        setBaseline(m.baseline);
        setSchema(m.working);
        history.current = { past: [], future: [], lastTime: 0 };
        setHistoryTick((x) => x + 1);
        // Positions: saved layout (by schema.table) → otherwise auto layout.
        const pos: Record<string, Position> = {};
        for (const t of m.working.tables) {
          const p = m.layout[tableKey(t)] ?? posRef.current[t.id];
          if (p) pos[t.id] = p;
        }
        const known = Object.keys(pos).length;
        if (known === 0) Object.assign(pos, autoLayout(m.working.tables, m.working));
        else if (known < m.working.tables.length) Object.assign(pos, placeMissing(m.working.tables, pos));
        posRef.current = pos;
        if (firstLoad.current) {
          const schemas = new Set(m.working.tables.map((t) => t.schema));
          const hide = m.hiddenSchemas ?? (m.readOnlySource && m.mode !== 'standalone' ? [...schemas].filter((s) => INTERNAL_SCHEMAS.has(s)) : []);
          setHiddenSchemas(hide.length < schemas.size ? new Set(hide) : new Set());
        }
        setNodes([]);
        if (known === 0 && m.mode !== 'standalone') scheduleSave();
        if (firstLoad.current) {
          firstLoad.current = false;
          setTimeout(() => rf.fitView({ padding: 0.08, maxZoom: 1 }), 80);
        }
      } else if (m.type === 'exported') {
        setToast(`Saved ${m.path}`);
      } else if (m.type === 'saved') {
        setToast('Diagram saved');
      } else if (m.type === 'aiResult') {
        setAi({ loading: false, review: m.review, applied: {} });
      } else if (m.type === 'aiError') {
        setAi((a) => ({ ...a, loading: false, error: m.message }));
      } else if (m.type === 'aiProvider') {
        setAiProvider(m.label);
      } else if (m.type === 'openAi') {
        setEditor(undefined);
        setAiOpen(true);
      } else if (m.type === 'applyOps') {
        // An agent (via the VS Code language model tools) asked to change the diagram.
        let errors: string[] = [];
        mutate((s) => {
          errors = applyOps(s, m.ops, defaultSchemaOf(s));
        });
        const n = m.ops.length - errors.length;
        setToast(`${m.description ? m.description + ': ' : ''}applied ${n} change${n === 1 ? '' : 's'}${errors.length ? `, ${errors.length} failed` : ''}. Ctrl+Z to undo.`);
        post({ type: 'opsApplied', requestId: m.requestId, errors });
      }
    };
    window.addEventListener('message', onMsg);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, [rf, setSchema, scheduleSave, mutate]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- derived data ------------------------------------------------------

  const allSchemas = useMemo(() => [...new Set(schema.tables.map((t) => t.schema))].sort(), [schema.tables]);
  const visibleTables = useMemo(() => schema.tables.filter((t) => !hiddenSchemas.has(t.schema)), [schema.tables, hiddenSchemas]);
  const tableById = useMemo(() => new Map(schema.tables.map((t) => [t.id, t])), [schema.tables]);

  const fkTargets = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of schema.relations) {
      const to = tableById.get(r.toTable);
      if (!to) continue;
      r.fromColumns.forEach((fc, i) => {
        const tc = to.columns.find((c) => c.id === r.toColumns[i]);
        out[fc] = `${to.schema ? to.schema + '.' : ''}${to.name}.${tc?.name ?? '?'}`;
      });
    }
    return out;
  }, [schema.relations, tableById]);

  const selectedTable = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    return sel.length === 1 ? sel[0].id : undefined;
  }, [nodes]);

  const highlight = useMemo(() => {
    const focus = selectedTable ?? hoverTable;
    const cols = new Set<string>();
    const tables = new Set<string>();
    const edges = new Set<string>();
    for (const r of schema.relations) {
      const touches = focus && (r.fromTable === focus || r.toTable === focus);
      if (touches || selectedEdges.has(r.id)) {
        r.fromColumns.forEach((c) => cols.add(c));
        r.toColumns.forEach((c) => cols.add(c));
        tables.add(r.fromTable);
        tables.add(r.toTable);
        edges.add(r.id);
      }
    }
    return { focus, cols, tables, edges, dimOthers: !!selectedTable || selectedEdges.size > 0 };
  }, [schema.relations, selectedTable, hoverTable, selectedEdges]);

  const changedCols = useMemo(() => {
    const base = new Map<string, string>();
    const baseTables = new Set(baseline.tables.map((t) => t.id));
    for (const t of baseline.tables) for (const c of t.columns) base.set(c.id, colSig(c));
    const out = new Map<string, string>();
    for (const t of schema.tables) {
      if (!baseTables.has(t.id)) continue;
      const ids = t.columns.filter((c) => base.get(c.id) !== colSig(c)).map((c) => c.id);
      if (ids.length) out.set(t.id, ids.join('|'));
    }
    return { out, baseTables };
  }, [baseline, schema.tables]);

  // Build/refresh nodes, keeping React Flow's own state (position, measured size, selection).
  useEffect(() => {
    const showSchema = allSchemas.length > 1 || (allSchemas[0] !== undefined && !['public', 'dbo', ''].includes(allSchemas[0]));
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return visibleTables.map((t) => {
        const p = prevById.get(t.id);
        const hlCols = highlight.edges.size
          ? t.columns
              .filter((c) => highlight.cols.has(c.id))
              .map((c) => c.id)
              .join('|')
          : '';
        const myFks: Record<string, string> = {};
        for (const c of t.columns) if (fkTargets[c.id]) myFks[c.id] = fkTargets[c.id];
        const data: TableNodeData = {
          table: t,
          fkTargets: p && shallowEqual(p.data.fkTargets, myFks) ? p.data.fkTargets : myFks,
          hlCols,
          dimmed: highlight.dimOthers && !highlight.tables.has(t.id) && t.id !== selectedTable,
          related: highlight.tables.has(t.id) && t.id !== highlight.focus,
          showSchema,
          changed: changedCols.out.get(t.id) ?? '',
          isNew: !changedCols.baseTables.has(t.id),
        };
        if (p && shallowEqual(p.data, data)) return p;
        return {
          ...(p ?? {}),
          id: t.id,
          type: 'table' as const,
          position: p?.position ?? posRef.current[t.id] ?? { x: 0, y: 0 },
          data,
          dragHandle: undefined,
          deletable: false,
        };
      });
    });
  }, [visibleTables, fkTargets, highlight, selectedTable, changedCols, allSchemas]);

  // Keep the position cache current.
  useEffect(() => {
    for (const n of nodes) posRef.current[n.id] = n.position;
  }, [nodes]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    const pos = new Map(nodes.map((n) => [n.id, n]));
    const out: RelationEdgeType[] = [];
    for (const r of schema.relations) {
      const parent = pos.get(r.toTable);
      const child = pos.get(r.fromTable);
      if (!parent || !child) continue;
      const childT = tableById.get(r.fromTable);
      const parentT = tableById.get(r.toTable);
      if (!childT || !parentT) continue;
      const { s: sSide, t: tSide } = edgeSides(
        boxFor(parentT, parent.position, parent.measured),
        boxFor(childT, child.position, child.measured),
        r.toTable === r.fromTable,
      );
      const fromNames = r.fromColumns.map((id) => childT.columns.find((c) => c.id === id));
      const toNames = r.toColumns.map((id) => parentT.columns.find((c) => c.id === id));
      // 1:1 when the FK columns are themselves unique / the whole PK.
      const fkCols = fromNames.filter((c): c is Column => !!c);
      const childPk = childT.columns.filter((c) => c.pk);
      const oneToOne =
        (fkCols.length === 1 && (fkCols[0].unique || (fkCols[0].pk && childPk.length === 1))) ||
        (fkCols.length > 1 && fkCols.length === childPk.length && fkCols.every((c) => c.pk));
      const label = `${childT.name}.${fkCols.map((c) => c.name).join(', ')} → ${parentT.name}.${toNames.map((c) => c?.name).join(', ')}`;
      const highlighted = highlight.edges.has(r.id);
      r.fromColumns.forEach((fc, i) => {
        const tc = r.toColumns[i];
        out.push({
          id: i === 0 ? r.id : `${r.id}::${i}`,
          type: 'relation',
          source: r.toTable,
          target: r.fromTable,
          sourceHandle: `${tc}::${sSide}`,
          targetHandle: `${fc}::${tSide}`,
          selected: selectedEdges.has(r.id),
          zIndex: highlighted ? 5 : 0,
          data: {
            label,
            onDelete: r.onDelete,
            onUpdate: r.onUpdate,
            childCard: oneToOne ? '1' : 'N',
            hovered: hoverEdge === r.id,
            highlighted,
            dimmed: highlight.dimOthers && !highlighted,
          },
        });
      });
    }
    return out;
  }, [nodes, schema.relations, tableById, highlight, selectedEdges, hoverEdge]);

  // ---- React Flow handlers -------------------------------------------------

  const onNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
  }, []);

  const removeRelations = useCallback(
    (ids: Set<string>) => {
      if (!ids.size) return;
      mutate((s) => {
        s.relations = s.relations.filter((r) => !ids.has(r.id));
      });
      setSelectedEdges((prev) => new Set([...prev].filter((x) => !ids.has(x))));
    },
    [mutate],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RelationEdgeType>[]) => {
      const removed = new Set<string>();
      let sel: Set<string> | undefined;
      for (const c of changes) {
        if (c.type === 'remove') removed.add(relIdOf(c.id));
        if (c.type === 'select') {
          sel ??= new Set(selectedEdges);
          if (c.selected) sel.add(relIdOf(c.id));
          else sel.delete(relIdOf(c.id));
        }
      }
      if (sel) setSelectedEdges(sel);
      removeRelations(removed);
    },
    [selectedEdges, removeRelations],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const a = colIdOfHandle(conn.sourceHandle);
      const b = colIdOfHandle(conn.targetHandle);
      if (!a || !b || a === b) return;
      const ta = tableById.get(conn.source);
      const tb = tableById.get(conn.target);
      const ca = ta?.columns.find((c) => c.id === a);
      const cb = tb?.columns.find((c) => c.id === b);
      if (!ta || !tb || !ca || !cb) return;
      // The key side (PK/unique) is the referenced one; otherwise drag from FK → to referenced column.
      let child = { t: ta, c: ca };
      let parent = { t: tb, c: cb };
      const aKey = ca.pk || ca.unique;
      const bKey = cb.pk || cb.unique;
      if (aKey && !bKey) [child, parent] = [parent, child];
      // Confirm direction, cardinality and fixes (unique key, matching type) in the dialog.
      setRelDraft({ childTable: child.t.id, childColumn: child.c.id, parentTable: parent.t.id, parentColumn: parent.c.id });
    },
    [tableById],
  );

  /** Apply schema operations as one undoable step; returns per-operation errors. */
  const runOps = useCallback(
    (ops: SchemaOp[]): string[] => {
      let errors: string[] = [];
      mutate((s) => {
        errors = applyOps(s, ops, defaultSchemaOf(s));
      });
      return errors;
    },
    [mutate],
  );

  const isValidConnection = useCallback(
    (c: Connection | RelationEdgeType) => colIdOfHandle(c.sourceHandle) !== colIdOfHandle(c.targetHandle),
    [],
  );

  // ---- actions --------------------------------------------------------------

  const nodeActions: NodeActions = useMemo(
    () => ({
      edit: (tableId, columnId) => {
        setAiOpen(false);
        setEditor({ tableId, columnId, nonce: Date.now() });
      },
      addColumn: (tableId) => {
        let id: string | undefined;
        mutate((s) => {
          id = addColumnTo(s, tableId);
        });
        setEditor({ tableId, columnId: id, nonce: Date.now() });
      },
    }),
    [mutate],
  );

  const edgeActions = useMemo(() => ({ remove: (id: string) => removeRelations(new Set([relIdOf(id)])) }), [removeRelations]);

  const addTable = useCallback(() => {
    const s = schemaRef.current;
    const counts = new Map<string, number>();
    for (const t of s.tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
    const defaultSchema =
      s.dialect === 'postgres' || s.dialect === 'generic'
        ? counts.has('public') || counts.size === 0
          ? 'public'
          : [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : s.dialect === 'mssql'
          ? 'dbo'
          : '';
    let name = 'new_table';
    for (let i = 2; s.tables.some((t) => t.name.toLowerCase() === name && t.schema === defaultSchema); i++) name = `new_table_${i}`;
    const id = newId('t');
    const idCol: Column = { ...newColumn('id', 'bigint'), pk: true, nullable: false, identity: true };
    const created: Column = { ...newColumn('created_at', 'timestamptz'), nullable: false, default: 'now()' };
    const table: Table = { id, schema: defaultSchema, name, columns: [idCol, created] };
    const el = document.querySelector('.react-flow');
    const rect = el?.getBoundingClientRect();
    const center = rf.screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
    });
    // Find a free spot near the centre of the viewport (spiral outwards on a grid).
    const rects = rf.getNodes().map((n) => ({
      x: n.position.x,
      y: n.position.y,
      w: n.measured?.width ?? NODE_WIDTH,
      h: n.measured?.height ?? 200,
    }));
    const W = NODE_WIDTH;
    const H = 110;
    const free = (x: number, y: number) =>
      rects.every((r) => x + W + 30 < r.x || x > r.x + r.w + 30 || y + H + 30 < r.y || y > r.y + r.h + 30);
    let spot = { x: center.x - W / 2, y: center.y - H / 2 };
    search: for (let ring = 0; ring < 12; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const cand = { x: center.x - W / 2 + dx * (W + 40), y: center.y - H / 2 + dy * (H + 40) };
          if (free(cand.x, cand.y)) {
            spot = cand;
            break search;
          }
        }
      }
    }
    posRef.current[id] = spot;
    setTimeout(() => {
      setNodes((nds) => nds.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
      rf.setCenter(spot.x + W / 2, spot.y + H / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
    }, 60);
    if (hiddenSchemas.has(defaultSchema)) setHiddenSchemas((h) => new Set([...h].filter((x) => x !== defaultSchema)));
    mutate((sc) => {
      sc.tables.push(table);
    });
    setEditor({ tableId: id, nonce: Date.now() });
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.erd-editor .field.grow input');
      input?.focus();
      input?.select();
    });
  }, [mutate, rf, hiddenSchemas]);

  const runAutoLayout = useCallback(() => {
    const pos = autoLayout(visibleTables, schemaRef.current);
    Object.assign(posRef.current, pos);
    setNodes((nds) => nds.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)));
    scheduleSave();
    setTimeout(() => rf.fitView({ padding: 0.08, maxZoom: 1, duration: 300 }), 50);
  }, [visibleTables, rf, scheduleSave]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return visibleTables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q));
  }, [search, visibleTables]);

  const focusTable = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      setSelectedEdges(new Set());
      rf.fitView({ nodes: [{ id }], duration: 350, maxZoom: 1.1, padding: 0.4 });
    },
    [rf],
  );

  const doExport = (mode: 'full' | 'diff') => {
    setMenu(undefined);
    const schemas = hiddenSchemas.size ? allSchemas.filter((s) => !hiddenSchemas.has(s)) : undefined;
    post({ type: 'export', mode, schema: schemaRef.current, baseline, schemas });
  };

  const exportImage = async (format: 'png' | 'svg') => {
    setMenu(undefined);
    setToast(`Rendering ${format.toUpperCase()}…`);
    setExporting(true);
    try {
      await new Promise((r) => setTimeout(r, 30));
      // Draw every visible table (also ones scrolled off-screen) from the model + positions.
      const measured = new Map(rf.getNodes().map((n) => [n.id, n.measured]));
      const boxes = new Map<string, Box>();
      for (const t of visibleTables) {
        const pos = posRef.current[t.id];
        if (pos) boxes.set(t.id, boxFor(t, pos, measured.get(t.id)));
      }
      const img = await renderDiagram(
        {
          tables: visibleTables,
          relations: schemaRef.current.relations,
          boxes,
          palette: imageTheme === 'light' ? LIGHT : DARK,
          title: meta?.title,
        },
        format,
      );
      post({ type: 'saveImage', format, dataUrl: img.dataUrl });
      const mb = (img.bytes / 1048576).toFixed(1);
      setToast(
        format === 'png'
          ? `PNG ${img.width.toLocaleString()} × ${img.height.toLocaleString()} px at ${img.scale}× (${mb} MB)${img.scale < 2 ? '. Use SVG for unlimited zoom' : ''}`
          : `SVG ${mb} MB. Vector, so it stays sharp at any zoom`,
      );
    } catch (e) {
      setToast(`Image export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const erdFile = (): ErdFile => ({
    format: 'erd-viewer',
    version: 1,
    title: meta?.title ?? 'Diagram',
    savedAt: new Date().toISOString(),
    schema: schemaRef.current,
    layout: currentLayout(),
    hiddenSchemas: hiddenSchemas.size ? [...hiddenSchemas] : undefined,
  });

  const share = (kind: 'erd' | 'html') => {
    setMenu(undefined);
    post({ type: 'share', kind, file: erdFile() });
  };

  const saveFile = () => post({ type: 'saveFile', file: erdFile() });

  const runAi = ({ focus, selectedOnly }: { focus: string; selectedOnly: boolean }) => {
    setAi({ loading: true, applied: {}, review: undefined });
    const schemas = hiddenSchemas.size ? allSchemas.filter((s) => !hiddenSchemas.has(s)) : undefined;
    post({
      type: 'aiReview',
      request: { schema: schemaRef.current, schemas, tableIds: selectedOnly && selectedTable ? [selectedTable] : undefined, focus },
    });
  };

  const applySuggestion = (s: AiSuggestion) => {
    const errors = runOps(s.operations);
    setAi((a) => ({ ...a, applied: { ...a.applied, [s.id]: errors } }));
    setToast(errors.length ? `Applied with ${errors.length} problem(s): ${errors[0]}` : `Applied: ${s.title}. Ctrl+Z to undo.`);
  };

  const showTables = (names: string[]) => {
    const ids = names
      .map((n) => {
        const nm = n.toLowerCase();
        return schemaRef.current.tables.find((t) => qualifiedName(t).toLowerCase() === nm || t.name.toLowerCase() === nm.split('.').pop());
      })
      .filter((t): t is Table => !!t)
      .map((t) => t.id);
    if (!ids.length) return;
    setNodes((nds) => nds.map((n) => ({ ...n, selected: ids.length === 1 && n.id === ids[0] })));
    rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 350, maxZoom: 1.1, padding: 0.3 });
  };

  const toggleSchema = (s: string) =>
    setHiddenSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  void historyTick;
  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;

  const relCount = schema.relations.filter((r) => !hiddenSchemas.has(tableById.get(r.fromTable)?.schema ?? '') && !hiddenSchemas.has(tableById.get(r.toTable)?.schema ?? '')).length;

  return (
    <NodeActionsContext.Provider value={nodeActions}>
      <EdgeActionsContext.Provider value={edgeActions}>
        <div className={`erd-app ${editable ? '' : 'standalone'} ${exporting ? 'exporting' : ''}`} onClick={() => menu && setMenu(undefined)}>
          <div className="erd-toolbar" onClick={(e) => e.stopPropagation()}>
            <div className="tb-title">
              <strong>{meta?.title ?? 'ERD'}</strong>
              <span className="muted small" title={meta?.sourceLabel}>
                {visibleTables.length} tables · {relCount} relations
              </span>
              {dirty && editable ? (
                <span className="badge" title="Edits are kept as a draft. Export a migration to apply them.">
                  edited
                </span>
              ) : null}
            </div>
            <div className="tb-search">
              <input
                placeholder="Find table…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSearchIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches.length) {
                    const i = searchIdx % matches.length;
                    focusTable(matches[i].id);
                    setSearchIdx(i + 1);
                  } else if (e.key === 'Escape') setSearch('');
                }}
              />
              {search ? <span className="muted small">{matches.length} found{matches.length ? ' · Enter' : ''}</span> : null}
            </div>
            <div className="tb-actions">
              {allSchemas.length > 1 ? (
                <div className="dropdown">
                  <button className="btn" onClick={() => setMenu(menu === 'schemas' ? undefined : 'schemas')}>
                    Schemas {hiddenSchemas.size ? `(${allSchemas.length - hiddenSchemas.size}/${allSchemas.length})` : ''} ▾
                  </button>
                  {menu === 'schemas' ? (
                    <div className="menu">
                      {allSchemas.map((s) => (
                        <label key={s} className="menu-item">
                          <input type="checkbox" checked={!hiddenSchemas.has(s)} onChange={() => toggleSchema(s)} />
                          <span>{s || '(default)'}</span>
                          <span className="muted small">{schema.tables.filter((t) => t.schema === s).length}</span>
                        </label>
                      ))}
                      <div className="menu-sep" />
                      <button className="menu-item" onClick={() => setHiddenSchemas(new Set())}>
                        Show all
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {editable ? (
                <>
                  <button className="btn" onClick={addTable} title="Add a new table">
                    + Table
                  </button>
                  <button
                    className="btn"
                    onClick={() => setRelDraft(selectedTable ? { childTable: selectedTable } : {})}
                    title="Create a primary key → foreign key relationship (or drag between column dots)"
                  >
                    + Relation
                  </button>
                </>
              ) : null}
              <button className="btn" onClick={runAutoLayout} title="Re-arrange tables automatically">
                Auto layout
              </button>
              <button className="btn" onClick={() => rf.fitView({ padding: 0.08, duration: 300 })} title="Fit diagram to screen">
                Fit
              </button>
              {editable ? (
                <>
                  <button className="btn" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
                    ↶
                  </button>
                  <button className="btn" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">
                    ↷
                  </button>
                </>
              ) : null}
              {meta?.warnings.length ? (
                <div className="dropdown">
                  <button className="btn warn" onClick={() => setMenu(menu === 'warnings' ? undefined : 'warnings')} title="Parser warnings">
                    ⚠ {meta.warnings.length}
                  </button>
                  {menu === 'warnings' ? (
                    <div className="menu wide">
                      <div className="menu-head">Parser warnings (also in the "ERD Viewer" output channel)</div>
                      {meta.warnings.slice(0, 200).map((w, i) => (
                        <div key={i} className="menu-text">
                          {w}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {editable ? (
                <>
                  <button className="btn" onClick={() => post({ type: 'reload' })} title="Reload from source">
                    Reload
                  </button>
                  {dirty ? (
                    <button className="btn" onClick={() => post({ type: 'discard' })} title="Discard all edits">
                      Discard edits
                    </button>
                  ) : null}
                  {meta?.canSaveFile ? (
                    <button className="btn" onClick={saveFile} title="Save edits and layout back into the .erd.json file">
                      Save
                    </button>
                  ) : null}
                  <button
                    className={`btn ${aiOpen ? 'on' : ''}`}
                    onClick={() => (setEditor(undefined), setAiOpen(!aiOpen))}
                    title="Ask an AI model to review the schema for normalisation problems"
                  >
                    ✨ AI review
                  </button>
                </>
              ) : null}
              <div className="dropdown">
                <button className="btn" onClick={() => setMenu(menu === 'share' ? undefined : 'share')}>
                  {editable ? 'Share ▾' : 'Download ▾'}
                </button>
                {menu === 'share' ? (
                  <div className="menu right">
                    <button className="menu-item col" onClick={() => exportImage('png')}>
                      <span>Image: PNG (high-res)</span>
                      <span className="muted small">Whole diagram at up to 4× resolution, so it stays sharp when zoomed in</span>
                    </button>
                    <button className="menu-item col" onClick={() => exportImage('svg')}>
                      <span>Image: SVG (vector)</span>
                      <span className="muted small">Infinite zoom. Opens in browsers, Inkscape, Illustrator and Visio</span>
                    </button>
                    <label className="menu-item small">
                      <input
                        type="checkbox"
                        checked={imageTheme === 'dark'}
                        onChange={(e) => {
                          const v = e.target.checked ? 'dark' : 'light';
                          setImageTheme(v);
                          try {
                            localStorage.setItem('erd.imageTheme', v);
                          } catch {
                            /* storage unavailable */
                          }
                        }}
                      />
                      <span>Dark image background</span>
                    </label>
                    <div className="menu-sep" />
                    <button className="menu-item col" onClick={() => share('erd')}>
                      <span>Diagram file (.erd.json)</span>
                      <span className="muted small">Schema + layout; opens and stays editable in ERD Viewer</span>
                    </button>
                    {editable ? (
                      <button className="menu-item col" onClick={() => share('html')}>
                        <span>Standalone viewer (.html)</span>
                        <span className="muted small">One file anyone can open in a browser to explore the diagram</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {editable ? (
                <div className="dropdown">
                  <button className="btn primary" onClick={() => setMenu(menu === 'export' ? undefined : 'export')}>
                    Export SQL ▾
                  </button>
                  {menu === 'export' ? (
                    <div className="menu right">
                      <button className="menu-item col" onClick={() => doExport('full')}>
                        <span>Full schema (PostgreSQL)</span>
                        <span className="muted small">
                          CREATE TABLE for {hiddenSchemas.size ? 'visible schemas' : 'every table'}, then foreign keys
                        </span>
                      </button>
                      <button className="menu-item col" disabled={!dirty} onClick={() => doExport('diff')}>
                        <span>Changes only — migration (PostgreSQL)</span>
                        <span className="muted small">{dirty ? 'ALTER/CREATE/DROP for edits made in the diagram' : 'No edits yet'}</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <div className="erd-main">
            <div className="erd-canvas">
              <ReactFlow<TableNodeType, RelationEdgeType>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={editable ? onConnect : undefined}
                nodesConnectable={editable}
                isValidConnection={isValidConnection}
                connectionMode={ConnectionMode.Loose}
                onNodeDragStop={() => editable && scheduleSave()}
                onNodeMouseEnter={(_, n) => setHoverTable(n.id)}
                onNodeMouseLeave={() => setHoverTable(undefined)}
                onPaneClick={() => setSelectedEdges(new Set())}
                onEdgeMouseEnter={(_, e) => setHoverEdge(relIdOf(e.id))}
                onEdgeMouseLeave={() => setHoverEdge(undefined)}
                deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
                minZoom={0.05}
                maxZoom={2}
                onlyRenderVisibleElements={nodes.length > 60 && !exporting}
                proOptions={{ hideAttribution: true }}
                fitView={false}
              >
                {/* Inside the viewport so image export includes the crow's-foot markers. */}
                <ViewportPortal>
                  <EdgeMarkers />
                </ViewportPortal>
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                <MiniMap pannable zoomable nodeStrokeWidth={2} className="erd-minimap" />
                <Controls showInteractive={false} position="bottom-right" style={{ marginRight: 230 }} />
              </ReactFlow>
              <Legend />
              {schema.tables.length === 0 && meta && editable ? (
                <div className="erd-empty-state">
                  <p>No tables yet.</p>
                  <button className="btn primary" onClick={addTable}>
                    + Add a table
                  </button>
                </div>
              ) : null}
              {toast ? <div className="erd-toast">{toast}</div> : null}
            </div>
            {editor && editable ? (
              <TableEditor
                key={editor.tableId}
                schema={schema}
                tableId={editor.tableId}
                focusColumnId={editor.columnId}
                mutate={mutate}
                onClose={() => setEditor(undefined)}
                onDeleted={() => setEditor(undefined)}
              />
            ) : aiOpen && editable ? (
              <AiPanel
                state={ai}
                provider={aiProvider}
                selectedTableName={selectedTable ? qualifiedName(tableById.get(selectedTable) ?? { schema: '', name: '' }) : undefined}
                visibleCount={visibleTables.length}
                onRun={runAi}
                onCancel={() => post({ type: 'aiCancel' })}
                onApply={applySuggestion}
                onShowTables={showTables}
                onChooseProvider={() => post({ type: 'aiChooseProvider' })}
                onExportMigration={() => doExport('diff')}
                onClose={() => setAiOpen(false)}
              />
            ) : null}
          </div>
          {relDraft && editable ? (
            <RelationDialog
              schema={schema}
              draft={relDraft}
              onClose={() => setRelDraft(undefined)}
              onCreate={(ops, summary) => {
                const errors = runOps(ops);
                setRelDraft(undefined);
                setToast(errors.length ? `Relationship created with problems: ${errors.join('; ')}` : `Relationship created: ${summary}`);
              }}
            />
          ) : null}
        </div>
      </EdgeActionsContext.Provider>
    </NodeActionsContext.Provider>
  );
}

function Legend() {
  return (
    <div className="erd-legend">
      <span>
        <span className="ic pk">
          <KeyIcon size={11} />
        </span>
        Primary key
      </span>
      <span>
        <span className="ic fk">
          <LinkIcon size={11} />
        </span>
        Foreign key
      </span>
      <span>
        <HashIcon size={11} /> Identity
      </span>
      <span>
        <UniqueIcon size={11} /> Unique
      </span>
      <span>
        <DiamondIcon size={10} /> Nullable
      </span>
      <span>
        <DiamondIcon size={10} filled /> Not null
      </span>
      <span className="legend-rel">
        <span className="erd-edge-chip pk static">PK</span>
        <svg width="46" height="12" aria-hidden>
          <path d="M2 6 H44 M8 1 V11 M32 6 L44 1 M32 6 L44 11" className="erd-marker" fill="none" strokeWidth="1.4" />
        </svg>
        <span className="erd-edge-chip fk static">FK</span>
        one-to-many
      </span>
    </div>
  );
}

