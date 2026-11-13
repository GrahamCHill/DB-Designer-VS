// Activity-bar views: open/recent diagrams, saved database connections, and SQL folders found in the workspace.

import * as path from 'path';
import * as vscode from 'vscode';
import { ErdPanel } from './erdPanel';
import { ConnectionInfo } from './introspect/index';
import { RecentEntry, getRecent, getSavedConnections, kindLabel, redact, sourceKey } from './sources';

type Node =
  | { type: 'group'; id: 'open' | 'recent'; label: string }
  | { type: 'panel'; panel: ErdPanel }
  | { type: 'recent'; entry: RecentEntry };

const SOURCE_ICON: Record<string, string> = { sql: 'file-code', db: 'database', dbref: 'database', erd: 'type-hierarchy', blank: 'new-file' };

export class DiagramsView implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private context: vscode.ExtensionContext) {
    context.subscriptions.push(ErdPanel.changed.event(() => this.refresh()));
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const open = ErdPanel.openPanels();
    const openKeys = new Set(open.map((p) => sourceKey(p.sourceRef)));
    const recent = getRecent(this.context).filter((e) => !openKeys.has(e.key));
    if (!node) {
      const groups: Node[] = [];
      if (open.length) groups.push({ type: 'group', id: 'open', label: 'Open' });
      if (recent.length) groups.push({ type: 'group', id: 'recent', label: 'Recent' });
      return groups;
    }
    if (node.type === 'group' && node.id === 'open') return open.map((panel) => ({ type: 'panel', panel }));
    if (node.type === 'group' && node.id === 'recent') return recent.map((entry) => ({ type: 'recent', entry }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `group-${node.id}`;
      return item;
    }
    if (node.type === 'panel') {
      const p = node.panel;
      const item = new vscode.TreeItem(p.title, vscode.TreeItemCollapsibleState.None);
      item.description = p.isDirty ? '● edited' : undefined;
      item.tooltip = p.label;
      item.iconPath = new vscode.ThemeIcon(SOURCE_ICON[p.sourceRef.kind] ?? 'type-hierarchy', new vscode.ThemeColor('charts.blue'));
      item.command = { command: 'dbDesigner.revealDiagram', title: 'Show', arguments: [p] };
      item.contextValue = 'openDiagram';
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.title, vscode.TreeItemCollapsibleState.None);
    const s = e.source;
    item.description =
      s.kind === 'sql'
        ? s.paths.length === 1
          ? vscode.workspace.asRelativePath(s.paths[0])
          : `${s.paths.length} files`
        : s.kind === 'dbref'
          ? kindLabel(s.dbKind)
          : s.kind === 'erd'
            ? vscode.workspace.asRelativePath(s.path)
            : '';
    item.tooltip = `${e.title}\nLast opened ${new Date(e.at).toLocaleString()}`;
    item.iconPath = new vscode.ThemeIcon(SOURCE_ICON[s.kind] ?? 'history');
    item.command = { command: 'dbDesigner.openRecent', title: 'Open', arguments: [e] };
    item.contextValue = 'recentDiagram';
    return item;
  }
}

export class ConnectionsView implements vscode.TreeDataProvider<ConnectionInfo> {
  private emitter = new vscode.EventEmitter<ConnectionInfo | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private secrets: vscode.SecretStorage, context: vscode.ExtensionContext) {
    context.subscriptions.push(secrets.onDidChange(() => this.refresh()));
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  async getChildren(node?: ConnectionInfo): Promise<ConnectionInfo[]> {
    if (node) return [];
    return (await getSavedConnections(this.secrets)).sort((a, b) => a.name.localeCompare(b.name));
  }

  getTreeItem(c: ConnectionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.description = kindLabel(c.kind);
    item.tooltip = `${kindLabel(c.kind)}\n${redact(c.connection)}`;
    item.iconPath = new vscode.ThemeIcon('database');
    item.command = { command: 'dbDesigner.openConnection', title: 'Open ERD', arguments: [c] };
    item.contextValue = 'connection';
    return item;
  }
}

interface FolderNode {
  dir: string;
  count: number;
}

export class SqlFoldersView implements vscode.TreeDataProvider<FolderNode> {
  private emitter = new vscode.EventEmitter<FolderNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.sql');
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1500);
    };
    w.onDidCreate(later);
    w.onDidDelete(later);
    context.subscriptions.push(w, vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  async getChildren(node?: FolderNode): Promise<FolderNode[]> {
    if (node || !vscode.workspace.workspaceFolders?.length) return [];
    const exclude = vscode.workspace.getConfiguration('dbDesigner').get<string[]>('excludeFolders') ?? [];
    const pattern = `{${['**/.*/**', ...exclude.map((e) => `**/${e}/**`)].join(',')}}`;
    const files = await vscode.workspace.findFiles('**/*.sql', pattern, 5000);
    const depth = (d: string) => vscode.workspace.asRelativePath(d).split(/[\\/]/).length;
    const counts = new Map<string, number>();
    for (const f of files) {
      const dir = path.dirname(f.fsPath);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => depth(a.dir) - depth(b.dir) || b.count - a.count || a.dir.localeCompare(b.dir));
  }

  getTreeItem(n: FolderNode): vscode.TreeItem {
    const rel = vscode.workspace.asRelativePath(n.dir);
    const item = new vscode.TreeItem(path.basename(n.dir), vscode.TreeItemCollapsibleState.None);
    item.description = `${n.count} file${n.count === 1 ? '' : 's'} · ${rel === n.dir ? path.dirname(n.dir) : path.dirname(rel) === '.' ? '' : path.dirname(rel)}`.replace(/ · $/, '');
    item.tooltip = `${n.dir}\nClick to open as an ER diagram`;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.resourceUri = vscode.Uri.file(n.dir);
    item.command = { command: 'dbDesigner.openFromExplorer', title: 'Open ERD', arguments: [vscode.Uri.file(n.dir)] };
    item.contextValue = 'sqlFolder';
    return item;
  }
}
