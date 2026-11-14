import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  DiagramGroup,
  EdgeRoute,
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
import { EXPORT_DIALECTS, ExportDialect } from '../shared/sqlExport';
import { ValidationDialog } from './ValidationDialog';
import type { Verification } from '../verify/index';
import { NodeActions, NodeActionsContext, TableNode, TableNodeData, TableNodeType } from './TableNode';
import { EdgeActionsContext, EdgeMarkers, RelationEdge, RelationEdgeType } from './RelationEdge';
import { Mutate, TableEditor, addColumnTo, newColumn } from './TableEditor';
import { NODE_WIDTH, autoLayout, layoutItems, nodeHeight, placeMissing } from './layout';
import { GroupActions, GroupActionsContext, GroupNode, GroupNodeData, GroupNodeType } from './GroupNode';
import { GROUP_COLORS, GroupBox, descendants, groupAt, groupDepth, parentFor, rectAround } from './groups';
import { RouterContext } from './RelationEdge';
import type { Rect } from './router';
import { DiamondIcon, HashIcon, KeyIcon, LinkIcon, UniqueIcon } from './icons';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);

const nodeTypes = { table: TableNode, tablegroup: GroupNode };
type AnyNode = TableNodeType | GroupNodeType;
const isTable = (n: AnyNode): n is TableNodeType => n.type === 'table';
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

/** Everything undo/redo restores: the schema and the diagram's arrangement. */
interface Snapshot {
  schema: Schema;
  pos: Record<string, Position>;
  groups: DiagramGroup[];
  routes: Record<string, EdgeRoute>;
}

interface History {
  past: Snapshot[];
  future: Snapshot[];
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

function boundsOf(tables: Table[], pos: Record<string, Position>, groups: DiagramGroup[] = []) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const g of groups) {
    x1 = Math.min(x1, g.x);
    y1 = Math.min(y1, g.y);
    x2 = Math.max(x2, g.x + g.w);
    y2 = Math.max(y2, g.y + g.h);
  }
  for (const t of tables) {
    const p = pos[t.id];
    if (!p) continue;
    const b = boxFor(t, p);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : undefined;
}
const colIdOfHandle = (h: string | null | undefined) => (h ? h.replace(/::[LR]$/, '') : '');

export function App() {
  const rf = useReactFlow<AnyNode, RelationEdgeType>();
  const [meta, setMeta] = useState<Meta>();
  const [baseline, setBaseline] = useState<Schema>(emptySchema());
  const [schema, setSchemaState] = useState<Schema>(emptySchema());
  const schemaRef = useRef(schema);
  const history = useRef<History>({ past: [], future: [], lastTime: 0 });
  const [historyTick, setHistoryTick] = useState(0);
  const posRef = useRef<Record<string, Position>>({});
  const [nodes, setNodes] = useState<AnyNode[]>([]);
  const nodesRef = useRef<AnyNode[]>([]);
  nodesRef.current = nodes;
  const [groups, setGroupsState] = useState<DiagramGroup[]>([]);
  const groupsRef = useRef<DiagramGroup[]>([]);
  const setGroups = useCallback((g: DiagramGroup[]) => {
    groupsRef.current = g;
    setGroupsState(g);
  }, []);
  const [routes, setRoutesState] = useState<Record<string, EdgeRoute>>({});
  const routesRef = useRef<Record<string, EdgeRoute>>({});
  const setRoutes = useCallback((r: Record<string, EdgeRoute>) => {
    routesRef.current = r;
    setRoutesState(r);
  }, []);
  const [dragging, setDragging] = useState<Set<string>>(new Set());
  const [routing, setRouting] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dbd.routing') !== 'off';
    } catch {
      return true;
    }
  });
  const [routeSnap, setRouteSnap] = useState<{ rects: Rect[]; version: number }>({ rects: [], version: 0 });
  const routeSig = useRef('');
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
  const [validation, setValidation] = useState<Verification[] | 'running'>();
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
      post({ type: 'saveState', layout: currentLayout(), working: schemaRef.current, dirty: dirtyRef.current, groups: groupsRef.current, edges: routesRef.current });
    }, 400);
  }, [currentLayout]);

  // ---- mutations with undo/redo ----------------------------------------

  const snapshot = useCallback(
    (): Snapshot => ({ schema: schemaRef.current, pos: { ...posRef.current }, groups: groupsRef.current, routes: routesRef.current }),
    [],
  );

  /**
   * Record the current state before a change, so it can be undone. Changes with the same `key` within
   * 1.5 s (e.g. typing in one field) merge into a single undo step.
   */
  const record = useCallback(
    (key?: string) => {
      const h = history.current;
      const now = Date.now();
      if (!(key && key === h.lastKey && now - h.lastTime < 1500)) {
        h.past.push(snapshot());
        if (h.past.length > 200) h.past.shift();
      }
      h.lastKey = key;
      h.lastTime = now;
      h.future = [];
      setHistoryTick((x) => x + 1);
    },
    [snapshot],
  );

  const mutate: Mutate = useCallback(
    (fn, key) => {
      record(key);
      const next = cloneSchema(schemaRef.current);
      fn(next);
      setSchema(next);
      scheduleSave();
    },
    [record, setSchema, scheduleSave],
  );

  const restore = useCallback(
    (snap: Snapshot) => {
      setSchema(snap.schema);
      posRef.current = { ...snap.pos };
      setGroups(snap.groups);
      setRoutes(snap.routes);
      setNodes((nds) => nds.map((n) => (n.type === 'table' && snap.pos[n.id] && snap.pos[n.id] !== n.position ? { ...n, position: snap.pos[n.id] } : n)));
      setHistoryTick((x) => x + 1);
      scheduleSave();
    },
    [setSchema, setGroups, setRoutes, scheduleSave],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(snapshot());
    h.lastKey = undefined;
    restore(prev);
  }, [snapshot, restore]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(snapshot());
    h.lastKey = undefined;
    restore(next);
  }, [snapshot, restore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === 'z' || e.code === 'KeyZ') && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        undo();
      } else if (mod && !e.altKey && (key === 'y' || e.code === 'KeyY' || ((key === 'z' || e.code === 'KeyZ') && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        redo();
      } else if (e.key === 'Escape') {
        setMenu(undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
        setGroups(m.groups ?? []);
        setRoutes(m.edges ?? {});
        if (firstLoad.current) {
          const schemas = new Set(m.working.tables.map((t) => t.schema));
          const hide = m.hiddenSchemas ?? (m.readOnlySource && m.mode !== 'standalone' ? [...schemas].filter((s) => INTERNAL_SCHEMAS.has(s)) : []);
          setHiddenSchemas(hide.length < schemas.size ? new Set(hide) : new Set());
        }
        setNodes([]);
        if (known === 0 && m.mode !== 'standalone') scheduleSave();
        if (firstLoad.current) {
          firstLoad.current = false;
          const visible = m.working.tables.filter((t) => !(m.hiddenSchemas ?? []).includes(t.schema));
          const b = boundsOf(visible.length ? visible : m.working.tables, pos, m.groups ?? []);
          setTimeout(() => (b ? rf.fitBounds(b, { padding: 0.05 }) : rf.fitView({ padding: 0.08, maxZoom: 1 })), 80);
        }
      } else if (m.type === 'exported') {
        setToast(m.note ? `Saved ${m.path}. ${m.note}` : `Saved ${m.path}`);
      } else if (m.type === 'validated') {
        setValidation(m.results);
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

  // Keep an open dropdown inside the window (the toolbar wraps on narrow editors).
  useLayoutEffect(() => {
    if (!menu) return;
    const el = document.querySelector<HTMLElement>('.erd-toolbar .menu');
    if (!el) return;
    el.style.left = '';
    el.style.right = '';
    const r = el.getBoundingClientRect();
    if (r.left < 4) {
      el.style.left = '0';
      el.style.right = 'auto';
    } else if (r.right > window.innerWidth - 4) {
      el.style.left = 'auto';
      el.style.right = '0';
    }
  }, [menu]);

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
    const sel = nodes.filter((n) => n.selected && isTable(n));
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
      const keys = new Set(schema.tables.map((t) => tableKey(t)));
      const groupNodes: GroupNodeType[] = groups.map((g) => {
        const id = `grp:${g.id}`;
        const p = prevById.get(id) as GroupNodeType | undefined;
        const depth = groupDepth(g.id, groups);
        const data: GroupNodeData = { group: g, depth, members: g.tables.filter((k) => keys.has(k)).length, editable };
        return {
          ...(p ?? {}),
          id,
          type: 'tablegroup' as const,
          position: { x: g.x, y: g.y },
          width: g.w,
          height: g.h,
          style: { width: g.w, height: g.h },
          zIndex: -1000 + depth,
          dragHandle: '.erd-group-header',
          deletable: false,
          data: p && shallowEqual(p.data, data) ? p.data : data,
        };
      });
      const tableNodes = visibleTables.map((t) => {
        const p = prevById.get(t.id) as TableNodeType | undefined;
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
      return [...groupNodes, ...tableNodes];
    });
  }, [visibleTables, fkTargets, highlight, selectedTable, changedCols, allSchemas, groups, editable, schema.tables]);

  // Obstacles for the edge router: table rectangles, refreshed when geometry settles (not mid-drag).
  useEffect(() => {
    if (dragging.size) return;
    const rects: Rect[] = [];
    for (const n of nodes) {
      if (!isTable(n)) continue;
      const w = n.measured?.width ?? NODE_WIDTH;
      const h = n.measured?.height ?? nodeHeight(n.data.table);
      rects.push({ x1: Math.round(n.position.x), y1: Math.round(n.position.y), x2: Math.round(n.position.x + w), y2: Math.round(n.position.y + h) });
    }
    const sig = rects.map((r) => `${r.x1},${r.y1},${r.x2},${r.y2}`).join(';');
    if (sig === routeSig.current) return;
    const t = setTimeout(() => {
      routeSig.current = sig;
      setRouteSnap((prev) => ({ rects, version: prev.version + 1 }));
    }, 60);
    return () => clearTimeout(t);
  }, [nodes, dragging]);

  // Keep the position cache current.
  useEffect(() => {
    for (const n of nodes) if (isTable(n)) posRef.current[n.id] = n.position;
  }, [nodes]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    const pos = new Map(nodes.filter(isTable).map((n) => [n.id, n]));
    const groupMoving = [...dragging].some((id) => id.startsWith('grp:'));
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
        const edgeId = i === 0 ? r.id : `${r.id}::${i}`;
        const manual = routes[edgeId];
        out.push({
          id: edgeId,
          type: 'relation',
          source: r.toTable,
          target: r.fromTable,
          sourceHandle: `${tc}::${manual?.s ?? sSide}`,
          targetHandle: `${fc}::${manual?.t ?? tSide}`,
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
            moving: groupMoving || dragging.has(r.toTable) || dragging.has(r.fromTable),
            route: manual,
            editable,
          },
        });
      });
    }
    return out;
  }, [nodes, schema.relations, tableById, highlight, selectedEdges, hoverEdge, dragging, routes, editable]);

  // ---- React Flow handlers -------------------------------------------------

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => {
      const nds = nodesRef.current;
      const byId = new Map(nds.map((n) => [n.id, n]));
      const gs = groupsRef.current;
      const extra: NodeChange<AnyNode>[] = [];
      const moved = new Map<string, { dx: number; dy: number }>();
      const resizing = new Set(changes.filter((c) => c.type === 'dimensions' && c.resizing).map((c) => (c as { id: string }).id));
      for (const c of changes) {
        if (c.type !== 'position' || !c.position || !c.id.startsWith('grp:') || resizing.has(c.id)) continue;
        const node = byId.get(c.id);
        if (!node) continue;
        const dx = c.position.x - node.position.x;
        const dy = c.position.y - node.position.y;
        if (!dx && !dy) continue;
        const gid = c.id.slice(4);
        const subtree = new Set([gid, ...descendants(gid, gs)]);
        for (const g of gs) if (subtree.has(g.id)) moved.set(g.id, { dx, dy });
        const keys = new Set(gs.filter((g) => subtree.has(g.id)).flatMap((g) => g.tables));
        for (const n of nds) {
          if (n.id === c.id || changes.some((x) => 'id' in x && x.id === n.id)) continue;
          const member = isTable(n) ? keys.has(tableKey(n.data.table)) : subtree.has(n.id.slice(4));
          if (member) extra.push({ type: 'position', id: n.id, position: { x: n.position.x + dx, y: n.position.y + dy }, dragging: c.dragging });
        }
      }
      setNodes((cur) => applyNodeChanges([...changes.filter((c) => c.type !== 'remove'), ...extra], cur));
      if (moved.size) setGroups(gs.map((g) => (moved.has(g.id) ? { ...g, x: g.x + moved.get(g.id)!.dx, y: g.y + moved.get(g.id)!.dy } : g)));
    },
    [setGroups],
  );

  /** After a drag: tables join the smallest group they were dropped in; groups find their parent group. */
  const settleMembership = useCallback(
    (draggedIds: string[]) => {
      let gs = groupsRef.current;
      const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
      let changed = false;
      for (const id of draggedIds) {
        const n = byId.get(id);
        if (!n) continue;
        if (isTable(n)) {
          const key = tableKey(n.data.table);
          const w = n.measured?.width ?? NODE_WIDTH;
          const h = n.measured?.height ?? nodeHeight(n.data.table);
          const target = groupAt(n.position.x + w / 2, n.position.y + h / 2, gs);
          const current = gs.find((g) => g.tables.includes(key));
          if (target?.id === current?.id) continue;
          gs = gs.map((g) => ({
            ...g,
            tables: g.id === target?.id ? [...g.tables.filter((k) => k !== key), key] : g.tables.filter((k) => k !== key),
          }));
          changed = true;
        } else {
          const g = gs.find((x) => `grp:${x.id}` === id);
          if (!g) continue;
          const parent = parentFor(g, gs);
          if (parent !== g.parentId) {
            gs = gs.map((x) => (x.id === g.id ? { ...x, parentId: parent } : x));
            changed = true;
          }
        }
      }
      if (changed) setGroups(gs);
    },
    [setGroups],
  );

  const groupActions: GroupActions = useMemo(
    () => ({
      update: (id, patch) => {
        record(`group:${id}:${Object.keys(patch).join(',')}`);
        setGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, ...patch } : g)));
        scheduleSave();
      },
      remove: (id) => {
        record();
        const gone = groupsRef.current.find((g) => g.id === id);
        setGroups(groupsRef.current.filter((g) => g.id !== id).map((g) => (g.parentId === id ? { ...g, parentId: gone?.parentId } : g)));
        scheduleSave();
      },
      resized: (id, rect) => {
        record();
        let gs = groupsRef.current.map((g) => (g.id === id ? { ...g, ...rect } : g));
        // Re-evaluate which tables belong to the resized group.
        for (const n of nodesRef.current) {
          if (!isTable(n)) continue;
          const key = tableKey(n.data.table);
          const w = n.measured?.width ?? NODE_WIDTH;
          const h = n.measured?.height ?? nodeHeight(n.data.table);
          const target = groupAt(n.position.x + w / 2, n.position.y + h / 2, gs);
          gs = gs.map((g) => ({ ...g, tables: g.id === target?.id ? [...new Set([...g.tables, key])] : g.tables.filter((k) => k !== key) }));
        }
        setGroups(gs.map((g) => (g.id === id ? { ...g, parentId: parentFor(g, gs) } : g)));
        scheduleSave();
      },
    }),
    [setGroups, scheduleSave, record],
  );

  const addGroup = useCallback(() => {
    const sel = nodesRef.current.filter((n): n is TableNodeType => isTable(n) && !!n.selected);
    const gs = groupsRef.current;
    const id = newId('g');
    const color = GROUP_COLORS[gs.length % GROUP_COLORS.length];
    let rect: { x: number; y: number; w: number; h: number };
    let tables: string[] = [];
    if (sel.length) {
      rect = rectAround(sel.map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_WIDTH, h: n.measured?.height ?? nodeHeight(n.data.table) })));
      tables = sel.map((n) => tableKey(n.data.table));
    } else {
      const el = document.querySelector('.react-flow')?.getBoundingClientRect();
      const c = rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 });
      // Empty group: find a free area near the centre so it isn't hidden behind tables.
      const tables = nodesRef.current.filter(isTable).map((n) => ({
        x: n.position.x,
        y: n.position.y,
        w: n.measured?.width ?? NODE_WIDTH,
        h: n.measured?.height ?? nodeHeight(n.data.table),
      }));
      const W = 600;
      const H = 400;
      const free = (x: number, y: number) => tables.every((r) => x + W + 30 < r.x || x > r.x + r.w + 30 || y + H + 30 < r.y || y > r.y + r.h + 30);
      let spot = { x: c.x - W / 2, y: c.y - H / 2 };
      search: for (let ring = 0; ring < 25; ring++)
        for (let dx = -ring; dx <= ring; dx++)
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const cand = { x: c.x - W / 2 + dx * (W / 2), y: c.y - H / 2 + dy * (H / 2) };
            if (free(cand.x, cand.y)) {
              spot = cand;
              break search;
            }
          }
      rect = { x: Math.round(spot.x), y: Math.round(spot.y), w: W, h: H };
      setTimeout(() => rf.fitBounds({ x: rect.x - 100, y: rect.y - 100, width: rect.w + 200, height: rect.h + 200 }, { duration: 300 }), 50);
    }
    const group: DiagramGroup = { id, name: sel.length ? `Group ${gs.length + 1}` : 'New group', color, ...rect, tables };
    const next = gs.map((g) => ({ ...g, tables: g.tables.filter((k) => !tables.includes(k)) }));
    group.parentId = parentFor(group, next);
    record();
    setGroups([...next, group]);
    scheduleSave();
    setToast(sel.length ? `Grouped ${sel.length} table${sel.length === 1 ? '' : 's'}. Use Edit on the group header to rename or recolour it` : 'Empty group added: drag tables into it, or select tables first and then add a group');
  }, [rf, setGroups, scheduleSave, record]);

  const removeRelations = useCallback(
    (ids: Set<string>) => {
      if (!ids.size) return;
      mutate((s) => {
        s.relations = s.relations.filter((r) => !ids.has(r.id));
      });
      const keep = Object.fromEntries(Object.entries(routesRef.current).filter(([k]) => !ids.has(relIdOf(k))));
      if (Object.keys(keep).length !== Object.keys(routesRef.current).length) setRoutes(keep);
      setSelectedEdges((prev) => new Set([...prev].filter((x) => !ids.has(x))));
    },
    [mutate, setRoutes],
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
      relate: (tableId) => setRelDraft({ childTable: tableId }),
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

  const edgeActions = useMemo(
    () => ({
      remove: (id: string) => removeRelations(new Set([relIdOf(id)])),
      beginEdit: () => record(),
      setRoute: (id: string, route: EdgeRoute | undefined) => {
        const next = { ...routesRef.current };
        if (route && (route.s || route.t || route.points?.length)) next[id] = route;
        else delete next[id];
        setRoutes(next);
        scheduleSave();
      },
    }),
    [removeRelations, record, setRoutes, scheduleSave],
  );

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
    const rects = rf.getNodes().filter((n) => n.type === 'table').map((n) => ({
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
    record();
    const gs = groupsRef.current;
    let pos: Record<string, Position>;
    let newGroups = gs;
    if (!gs.length) pos = autoLayout(visibleTables, schemaRef.current);
    else {
      // Top-level groups are laid out as single blocks (keeping their inside arrangement); other tables individually.
      const keyOf = new Map(visibleTables.map((t) => [t.id, tableKey(t)]));
      const top = gs.filter((g) => !g.parentId || !gs.some((x) => x.id === g.parentId));
      const blockOf = new Map<string, string>(); // table id -> top group id
      for (const g of top) {
        const sub = new Set([g.id, ...descendants(g.id, gs)]);
        const keys = new Set(gs.filter((x) => sub.has(x.id)).flatMap((x) => x.tables));
        for (const t of visibleTables) if (keys.has(keyOf.get(t.id)!)) blockOf.set(t.id, g.id);
      }
      const items = [
        ...top.map((g) => ({ id: `grp:${g.id}`, w: g.w, h: g.h })),
        ...visibleTables.filter((t) => !blockOf.has(t.id)).map((t) => ({ id: t.id, w: NODE_WIDTH, h: nodeHeight(t) })),
      ];
      const itemOf = (tableId: string) => (blockOf.has(tableId) ? `grp:${blockOf.get(tableId)}` : tableId);
      const placed = layoutItems(items, schemaRef.current.relations.map((r) => ({ from: itemOf(r.fromTable), to: itemOf(r.toTable) })));
      pos = {};
      const delta = new Map<string, { dx: number; dy: number }>();
      for (const g of top) {
        const p = placed[`grp:${g.id}`];
        if (p) delta.set(g.id, { dx: p.x - g.x, dy: p.y - g.y });
      }
      for (const t of visibleTables) {
        if (blockOf.has(t.id)) {
          const d = delta.get(blockOf.get(t.id)!);
          const cur = posRef.current[t.id];
          if (d && cur) pos[t.id] = { x: cur.x + d.dx, y: cur.y + d.dy };
        } else if (placed[t.id]) pos[t.id] = placed[t.id];
      }
      const topOf = (g: DiagramGroup): string => {
        let cur = g;
        while (cur.parentId && gs.some((x) => x.id === cur.parentId)) cur = gs.find((x) => x.id === cur.parentId)!;
        return cur.id;
      };
      newGroups = gs.map((g) => {
        const d = delta.get(topOf(g));
        return d ? { ...g, x: g.x + d.dx, y: g.y + d.dy } : g;
      });
    }
    Object.assign(posRef.current, pos);
    setGroups(newGroups);
    setNodes((nds) => nds.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)));
    scheduleSave();
    const b = boundsOf(visibleTables, posRef.current, newGroups);
    setTimeout(() => (b ? rf.fitBounds(b, { padding: 0.05, duration: 300 }) : rf.fitView({ padding: 0.08, maxZoom: 1, duration: 300 })), 50);
  }, [visibleTables, rf, scheduleSave, setGroups, record]);

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

  const doExport = (mode: 'full' | 'diff', target: ExportDialect = 'postgres') => {
    setMenu(undefined);
    const schemas = hiddenSchemas.size ? allSchemas.filter((s) => !hiddenSchemas.has(s)) : undefined;
    post({ type: 'export', mode, schema: schemaRef.current, baseline, schemas, target });
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
          routing,
          routes: routesRef.current,
          groups: groupsRef.current.map(
            (g): GroupBox => ({ x: g.x, y: g.y, w: g.w, h: g.h, name: g.name, color: g.color, depth: groupDepth(g.id, groupsRef.current) }),
          ),
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
    format: 'db-designer-vs',
    version: 1,
    title: meta?.title ?? 'Diagram',
    savedAt: new Date().toISOString(),
    schema: schemaRef.current,
    layout: currentLayout(),
    hiddenSchemas: hiddenSchemas.size ? [...hiddenSchemas] : undefined,
    groups: groupsRef.current.length ? groupsRef.current : undefined,
    edges: Object.keys(routesRef.current).length ? routesRef.current : undefined,
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
      <GroupActionsContext.Provider value={groupActions}>
      <RouterContext.Provider value={{ rects: routeSnap.rects, version: routeSnap.version, enabled: routing }}>
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
                  <button className="btn" onClick={addGroup} title="Group the selected tables (Ctrl/Shift-click or drag a box to select several), or add an empty group">
                    + Group
                  </button>
                </>
              ) : null}
              <button className="btn" onClick={runAutoLayout} title="Re-arrange tables automatically (groups move as blocks)">
                Auto layout
              </button>
              <button
                className={`btn ${routing ? 'on' : ''}`}
                onClick={() => {
                  const v = !routing;
                  setRouting(v);
                  try {
                    localStorage.setItem('dbd.routing', v ? 'on' : 'off');
                  } catch {
                    /* storage unavailable */
                  }
                }}
                title={routing ? 'Lines are routed around tables. Click for direct lines' : 'Route lines around tables'}
              >
                {routing ? 'Lines: routed' : 'Lines: direct'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  const b = boundsOf(visibleTables, posRef.current, groupsRef.current);
                  if (b) rf.fitBounds(b, { padding: 0.05, duration: 300 });
                  else rf.fitView({ padding: 0.08, duration: 300 });
                }}
                title="Fit diagram to screen"
              >
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
                      <div className="menu-head">Parser warnings (also in the "DB Designer" output channel)</div>
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
                    AI review
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
                      <span className="muted small">Schema + layout; opens and stays editable in DB Designer</span>
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
                      <button
                        className="menu-item col"
                        onClick={() => {
                          setMenu(undefined);
                          setValidation('running');
                          const schemas = hiddenSchemas.size ? allSchemas.filter((x) => !hiddenSchemas.has(x)) : undefined;
                          post({ type: 'validate', schema: schemaRef.current, schemas });
                        }}
                      >
                        <span>Validate SQL (all dialects)</span>
                        <span className="muted small">Executes PostgreSQL &amp; SQLite output in-process; checks SQL Server &amp; MySQL output</span>
                      </button>
                      <div className="menu-sep" />
                      <div className="menu-head">
                        Full schema: CREATE TABLE for {hiddenSchemas.size ? 'visible schemas' : 'every table'} + keys
                      </div>
                      {EXPORT_DIALECTS.map((d) => (
                        <button key={d.id} className="menu-item col" onClick={() => doExport('full', d.id)}>
                          <span>{d.label}</span>
                          <span className="muted small">
                            {d.id === 'postgres'
                              ? 'Same types as the diagram'
                              : d.id === 'mssql'
                                ? 'SQL Server 2016–2022 · cascade paths & key sizes handled'
                                : d.id === 'mssql2025'
                                  ? 'Native json and vector(n) types'
                                : d.id === 'mysql'
                                  ? 'MySQL 8.0+ / 9 & MariaDB · one database, InnoDB'
                                  : 'SQLite types · foreign keys inline'}
                          </span>
                        </button>
                      ))}
                      <div className="menu-sep" />
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
              <ReactFlow<AnyNode, RelationEdgeType>
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
                onNodeDragStart={(_, __, dragged) => {
                  if (editable) record();
                  setDragging(new Set(dragged.map((n) => n.id)));
                }}
                onNodeDragStop={(_, __, dragged) => {
                  setDragging(new Set());
                  if (!editable) return;
                  settleMembership(dragged.map((n) => n.id));
                  scheduleSave();
                }}
                elevateNodesOnSelect={false}
                multiSelectionKeyCode={['Control', 'Meta', 'Shift']}
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
                onChooseModel={() => post({ type: 'aiChooseModel' })}
                onExportMigration={() => doExport('diff')}
                onClose={() => setAiOpen(false)}
              />
            ) : null}
          </div>
          {validation ? <ValidationDialog results={validation} onClose={() => setValidation(undefined)} /> : null}
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
      </RouterContext.Provider>
      </GroupActionsContext.Provider>
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

