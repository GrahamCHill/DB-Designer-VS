// Schema model shared by the extension host, the parser, the exporter and the webview.

export type Dialect = 'postgres' | 'mssql' | 'mysql' | 'sqlite' | 'generic';

export interface Column {
  /** Stable id (survives renames inside the editor). */
  id: string;
  name: string;
  /** Type as written in the source dialect, e.g. "numeric(18,2)", "timestamptz", "nvarchar(255)". */
  type: string;
  nullable: boolean;
  pk: boolean;
  unique: boolean;
  default?: string;
  /** IDENTITY / AUTO_INCREMENT / GENERATED ... AS IDENTITY. */
  identity?: boolean;
  comment?: string;
}

export interface Table {
  /** Stable id (survives renames inside the editor). */
  id: string;
  schema: string;
  name: string;
  columns: Column[];
  comment?: string;
  /** Name of the primary key constraint, when known. */
  pkName?: string;
  /** Multi-column unique constraints (single-column ones live on Column.unique). Values are column ids. */
  uniques?: { name?: string; columns: string[] }[];
  /** Names of single-column unique constraints, keyed by column id, when known. */
  uniqueNames?: Record<string, string>;
  /** Single-column uniqueness that comes from CREATE UNIQUE INDEX: column id -> index name. */
  uniqueIndexes?: Record<string, string>;
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface Relation {
  id: string;
  name?: string;
  /** Child (referencing) side. */
  fromTable: string;
  fromColumns: string[];
  /** Parent (referenced) side. */
  toTable: string;
  toColumns: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
}

/** User-defined types that columns may refer to (PostgreSQL enums and domains). */
export interface UserType {
  schema: string;
  name: string;
  kind: 'enum' | 'domain';
  values?: string[];
  /** For domains: everything after the name, e.g. "AS text CHECK (VALUE <> '')". */
  definition?: string;
}

export interface Schema {
  dialect: Dialect;
  tables: Table[];
  relations: Relation[];
  types?: UserType[];
}

export interface Position {
  x: number;
  y: number;
}

/** Manual control of a relationship line: attachment sides and bend points (flow coordinates). */
export interface EdgeRoute {
  /** Side of the referenced (PK) table the line leaves from. */
  s?: 'L' | 'R';
  /** Side of the referencing (FK) table the line enters. */
  t?: 'L' | 'R';
  points?: Position[];
}

/** A coloured area that owns tables (and nested groups); dragging it moves them together. */
export interface DiagramGroup {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  /** Member tables by `schema.table` key (same keys as Layout), so membership survives re-parsing. */
  tables: string[];
}

/** Positions keyed by `schema.table` (lower-case) so they survive re-parsing. */
export type Layout = Record<string, Position>;

export function emptySchema(dialect: Dialect = 'postgres'): Schema {
  return { dialect, tables: [], relations: [] };
}

export function tableKey(t: { schema: string; name: string }): string {
  return `${t.schema}.${t.name}`.toLowerCase();
}

export function qualifiedName(t: { schema: string; name: string }): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function cloneSchema(s: Schema): Schema {
  return JSON.parse(JSON.stringify(s));
}

/** Column ids that are the referencing side of a foreign key. */
export function fkColumnIds(schema: Schema): Set<string> {
  const out = new Set<string>();
  for (const r of schema.relations) for (const c of r.fromColumns) out.add(c);
  return out;
}

/** A diagram saved to share with others (`*.erd.json`). */
export interface ErdFile {
  format: 'db-designer-vs' | 'erd-viewer';
  version: 1;
  title: string;
  savedAt: string;
  /** Where the diagram originally came from (informational). */
  source?: string;
  schema: Schema;
  layout: Layout;
  hiddenSchemas?: string[];
  groups?: DiagramGroup[];
  /** Manual line routes keyed by edge id. */
  edges?: Record<string, EdgeRoute>;
}

export function isErdFile(x: unknown): x is ErdFile {
  const o = x as ErdFile;
  return !!o && (o.format === 'db-designer-vs' || o.format === 'erd-viewer') && !!o.schema && Array.isArray(o.schema.tables);
}

/** How the webview is hosted. `standalone` = exported HTML opened in a browser (view-only). */
export type ViewMode = 'extension' | 'standalone';

/** Messages exchanged between the extension host and the webview. */
export type HostToWebview =
  | {
      type: 'load';
      title: string;
      sourceLabel: string;
      baseline: Schema;
      working: Schema;
      layout: Layout;
      warnings: string[];
      readOnlySource: boolean;
      mode?: ViewMode;
      /** Source is an .erd.json file that can be saved in place. */
      canSaveFile?: boolean;
      hiddenSchemas?: string[];
      groups?: DiagramGroup[];
      edges?: Record<string, EdgeRoute>;
      aiProvider?: string;
    }
  | { type: 'exported'; path: string; note?: string }
  | { type: 'validated'; results: import('../verify/index').Verification[] }
  | { type: 'saved' }
  | { type: 'aiResult'; review: import('./ai').AiReview }
  | { type: 'aiError'; message: string }
  | { type: 'aiProvider'; label: string }
  | { type: 'openAi' }
  | { type: 'applyOps'; requestId: string; ops: import('./ops').SchemaOp[]; description?: string };

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'export';
      mode: 'full' | 'diff';
      schema: Schema;
      baseline: Schema;
      schemas?: string[];
      /** Target dialect for full-schema export (migrations are PostgreSQL). */
      target?: import('./sqlExport').ExportDialect;
    }
  | { type: 'saveState'; layout: Layout; working: Schema; dirty: boolean; groups?: DiagramGroup[]; edges?: Record<string, EdgeRoute> }
  | { type: 'reload' }
  | { type: 'discard' }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'saveImage'; format: 'png' | 'svg'; dataUrl: string }
  | { type: 'share'; kind: 'erd' | 'html'; file: ErdFile }
  | { type: 'saveFile'; file: ErdFile }
  | { type: 'aiReview'; request: import('./ai').ReviewRequest }
  | { type: 'aiCancel' }
  | { type: 'validate'; schema: Schema; schemas?: string[] }
  | { type: 'aiChooseProvider' }
  | { type: 'opsApplied'; requestId: string; errors: string[] };
