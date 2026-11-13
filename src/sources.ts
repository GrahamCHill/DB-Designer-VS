import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionInfo, DbKind, introspect } from './introspect/index';
import { Layout, Schema, emptySchema, isErdFile } from './shared/model';
import { parseSql } from './shared/sqlParser';

export type Source =
  | { kind: 'sql'; paths: string[] }
  | { kind: 'db'; connection: ConnectionInfo }
  | { kind: 'blank'; id: string }
  | { kind: 'erd'; path: string };

export interface LoadedSource {
  schema: Schema;
  warnings: string[];
  label: string;
  title: string;
  files?: string[];
  /** Layout stored in an .erd.json file. */
  layout?: Layout;
  hiddenSchemas?: string[];
  groups?: import('./shared/model').DiagramGroup[];
}

export function sourceKey(s: Source): string {
  switch (s.kind) {
    case 'sql':
      return 'sql:' + [...s.paths].map((p) => path.resolve(p).toLowerCase()).sort().join('|');
    case 'db':
      return `db:${s.connection.kind}:${s.connection.name}`;
    case 'blank':
      return `blank:${s.id}`;
    case 'erd':
      return `erd:${path.resolve(s.path).toLowerCase()}`;
  }
}

export function sourceTitle(s: Source): string {
  switch (s.kind) {
    case 'sql': {
      if (s.paths.length === 1) {
        const p = s.paths[0];
        return `${path.basename(path.dirname(p))}/${path.basename(p)}`;
      }
      return `${s.paths.length} SQL files`;
    }
    case 'db':
      return s.connection.name;
    case 'blank':
      return 'New diagram';
    case 'erd':
      return path.basename(s.path).replace(/.erd.json$/i, '');
  }
}

async function walk(dir: string, exclude: Set<string>, out: string[]) {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || exclude.has(e.name)) continue;
      await walk(full, exclude, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.sql')) {
      out.push(full);
    }
  }
}

export async function collectSqlFiles(paths: string[]): Promise<string[]> {
  const exclude = new Set(vscode.workspace.getConfiguration('dbDesigner').get<string[]>('excludeFolders') ?? []);
  const files: string[] = [];
  for (const p of paths) {
    const st = await fs.stat(p).catch(() => undefined);
    if (!st) continue;
    if (st.isDirectory()) {
      const found: string[] = [];
      await walk(p, exclude, found);
      // Migration order: natural sort on the path relative to the chosen folder.
      found.sort((a, b) => path.relative(p, a).localeCompare(path.relative(p, b), undefined, { numeric: true, sensitivity: 'base' }));
      files.push(...found);
    } else {
      files.push(p);
    }
  }
  // Explicitly selected files: order them naturally by name too.
  if (paths.every((p) => p.toLowerCase().endsWith('.sql'))) {
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' }));
  }
  return [...new Set(files)];
}

export async function loadSource(s: Source): Promise<LoadedSource> {
  const title = sourceTitle(s);
  switch (s.kind) {
    case 'sql': {
      const files = await collectSqlFiles(s.paths);
      if (!files.length) throw new Error('No .sql files found in the selection.');
      const contents = await Promise.all(files.map(async (f) => ({ name: path.basename(f), content: await fs.readFile(f, 'utf8') })));
      const res = parseSql(contents);
      const base = s.paths.length === 1 ? s.paths[0] : path.dirname(files[0]);
      return {
        schema: res.schema,
        warnings: res.warnings,
        title,
        label: `${files.length} SQL file${files.length === 1 ? '' : 's'} · ${base} · ${res.dialect}`,
        files,
      };
    }
    case 'db': {
      const schema = await introspect(s.connection);
      return { schema, warnings: [], title, label: `${kindLabel(s.connection.kind)} · ${redact(s.connection.connection)}` };
    }
    case 'blank':
      return { schema: emptySchema('postgres'), warnings: [], title, label: 'Blank diagram (PostgreSQL)' };
    case 'erd': {
      const raw = JSON.parse(await fs.readFile(s.path, 'utf8'));
      if (!isErdFile(raw)) throw new Error(`${path.basename(s.path)} is not an DB Designer diagram file.`);
      return {
        schema: raw.schema,
        warnings: [],
        title: raw.title || title,
        label: `Shared diagram · ${s.path}${raw.source ? ` · from ${raw.source}` : ''}`,
        layout: raw.layout,
        hiddenSchemas: raw.hiddenSchemas,
        groups: raw.groups,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Saved connections (kept in VS Code Secret Storage because they hold passwords)
// ---------------------------------------------------------------------------

const SECRET_KEY = 'dbDesigner.connections';

export function kindLabel(k: DbKind): string {
  return { postgres: 'PostgreSQL', mssql: 'SQL Server', mysql: 'MySQL / MariaDB', sqlite: 'SQLite' }[k];
}

/** Hide the password part of a connection string for display. */
export function redact(conn: string): string {
  return conn
    .replace(/(\/\/[^:/@]+:)[^@]*@/, '$1•••@')
    .replace(/((?:password|pwd)\s*=\s*)[^;]*/gi, '$1•••');
}

export async function getSavedConnections(secrets: vscode.SecretStorage): Promise<ConnectionInfo[]> {
  try {
    return JSON.parse((await secrets.get(SECRET_KEY)) ?? '[]');
  } catch {
    return [];
  }
}

export async function saveConnections(secrets: vscode.SecretStorage, list: ConnectionInfo[]) {
  await secrets.store(SECRET_KEY, JSON.stringify(list));
}

const PLACEHOLDERS: Record<Exclude<DbKind, 'sqlite'>, string> = {
  postgres: 'postgres://user:password@localhost:5432/mydb  (add ?sslmode=require for hosted DBs)',
  mssql: 'Server=localhost,1433;Database=mydb;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true',
  mysql: 'mysql://user:password@localhost:3306/mydb',
};

export async function pickConnection(secrets: vscode.SecretStorage): Promise<ConnectionInfo | undefined> {
  const saved = await getSavedConnections(secrets);
  type Item = vscode.QuickPickItem & { conn?: ConnectionInfo };
  const items: Item[] = [
    { label: '$(add) New connection…' },
    ...saved.map((c) => ({ label: `$(database) ${c.name}`, description: kindLabel(c.kind), detail: redact(c.connection), conn: c })),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Open ERD from database', placeHolder: 'Choose a connection' });
  if (!picked) return undefined;
  if (picked.conn) return picked.conn;

  const kindPick = await vscode.window.showQuickPick(
    (['postgres', 'mssql', 'mysql', 'sqlite'] as DbKind[]).map((k) => ({ label: kindLabel(k), dbKind: k })),
    { title: 'Database type' },
  );
  if (!kindPick) return undefined;
  const kind = kindPick.dbKind;
  let connection: string | undefined;
  let defaultName: string;
  if (kind === 'sqlite') {
    const uris = await vscode.window.showOpenDialog({
      title: 'Choose a SQLite database file',
      canSelectMany: false,
      filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] },
    });
    if (!uris?.length) return undefined;
    connection = uris[0].fsPath;
    defaultName = path.basename(connection);
  } else {
    connection = await vscode.window.showInputBox({
      title: `${kindLabel(kind)} connection string`,
      prompt: 'Stored in VS Code Secret Storage.',
      placeHolder: PLACEHOLDERS[kind],
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (!connection) return undefined;
    connection = connection.trim();
    defaultName = guessName(connection, kind);
  }
  const name = await vscode.window.showInputBox({
    title: 'Name this connection',
    value: defaultName,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Required'),
  });
  if (!name) return undefined;
  const info: ConnectionInfo = { name: name.trim(), kind, connection };
  await saveConnections(secrets, [...saved.filter((c) => !(c.name === info.name && c.kind === info.kind)), info]);
  return info;
}

function guessName(conn: string, kind: DbKind): string {
  try {
    if (/^[a-z]+:\/\//i.test(conn)) {
      const u = new URL(conn);
      return `${u.pathname.replace(/^\//, '') || kind}@${u.hostname}`;
    }
  } catch {
    /* fall through */
  }
  const db = /(?:database|initial catalog)\s*=\s*([^;]+)/i.exec(conn)?.[1];
  const server = /(?:server|data source)\s*=\s*([^;]+)/i.exec(conn)?.[1];
  return [db, server].filter(Boolean).join('@') || kindLabel(kind);
}

export async function removeConnection(secrets: vscode.SecretStorage) {
  const saved = await getSavedConnections(secrets);
  if (!saved.length) {
    vscode.window.showInformationMessage('No saved DB Designer connections.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    saved.map((c) => ({ label: c.name, description: kindLabel(c.kind), detail: redact(c.connection), c })),
    { title: 'Remove saved connection', canPickMany: true },
  );
  if (!pick?.length) return;
  const remove = new Set(pick.map((p) => p.c));
  await saveConnections(secrets, saved.filter((c) => !remove.has(c)));
  vscode.window.showInformationMessage(`Removed ${pick.length} connection(s).`);
}

// ---------------------------------------------------------------------------
// Recently opened diagrams (for the sidebar)
// ---------------------------------------------------------------------------

export type RecentSource = Exclude<Source, { kind: 'db' }> | { kind: 'dbref'; name: string; dbKind: DbKind };

export interface RecentEntry {
  key: string;
  title: string;
  source: RecentSource;
  at: number;
}

const RECENT_KEY = 'dbDesigner.recent';

export function getRecent(context: vscode.ExtensionContext): RecentEntry[] {
  return context.globalState.get<RecentEntry[]>(RECENT_KEY, []);
}

export async function addRecent(context: vscode.ExtensionContext, source: Source, title: string) {
  if (source.kind === 'blank') return;
  const recent: RecentSource = source.kind === 'db' ? { kind: 'dbref', name: source.connection.name, dbKind: source.connection.kind } : source;
  const key = sourceKey(source);
  const list = getRecent(context).filter((e) => e.key !== key);
  list.unshift({ key, title, source: recent, at: Date.now() });
  await context.globalState.update(RECENT_KEY, list.slice(0, 15));
}

export async function removeRecent(context: vscode.ExtensionContext, key?: string) {
  await context.globalState.update(RECENT_KEY, key ? getRecent(context).filter((e) => e.key !== key) : []);
}

/** Turn a recent entry back into an openable source (looks up the saved connection for databases). */
export async function resolveRecent(secrets: vscode.SecretStorage, r: RecentSource): Promise<Source | undefined> {
  if (r.kind !== 'dbref') return r;
  const conn = (await getSavedConnections(secrets)).find((c) => c.name === r.name && c.kind === r.dbKind);
  return conn ? { kind: 'db', connection: conn } : undefined;
}
