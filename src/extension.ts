import * as vscode from 'vscode';
import { ErdPanel } from './erdPanel';
import {
  RecentEntry,
  getSavedConnections,
  pickConnection,
  removeConnection,
  removeRecent,
  resolveRecent,
  saveConnections,
} from './sources';
import { ConnectionInfo } from './introspect/index';
import { ConnectionsView, DiagramsView, SqlFoldersView } from './sidebar';
import { chooseModel, chooseProvider, clearApiKeys, setApiKey } from './ai/providers';
import { registerTools } from './ai/tools';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('DB Designer');
  context.subscriptions.push(output);

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const isErdFile = (p: string) => /\.erd\.json$/i.test(p);

  reg('dbDesigner.openFromSqlFolder', async () => {
    const uris = await vscode.window.showOpenDialog({
      title: 'Choose a folder of .sql files (e.g. a migrations or db folder)',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (uris?.length) await ErdPanel.open(context, output, { kind: 'sql', paths: [uris[0].fsPath] });
  });

  reg('dbDesigner.openFromSqlFiles', async () => {
    const uris = await vscode.window.showOpenDialog({
      title: 'Choose .sql files (applied in name order)',
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: true,
      filters: { SQL: ['sql'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (uris?.length) await ErdPanel.open(context, output, { kind: 'sql', paths: uris.map((u) => u.fsPath) });
  });

  reg('dbDesigner.openErdFile', async () => {
    const uris = await vscode.window.showOpenDialog({
      title: 'Open a shared ERD diagram',
      canSelectMany: false,
      filters: { 'ERD diagram': ['erd.json', 'json'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (uris?.length) await ErdPanel.open(context, output, { kind: 'erd', path: uris[0].fsPath });
  });

  reg('dbDesigner.openFromExplorer', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
    const list = selected?.length ? selected : uri ? [uri] : [];
    if (!list.length) return vscode.commands.executeCommand('dbDesigner.openFromSqlFolder');
    if (list.length === 1 && isErdFile(list[0].fsPath)) return ErdPanel.open(context, output, { kind: 'erd', path: list[0].fsPath });
    await ErdPanel.open(context, output, { kind: 'sql', paths: list.map((u) => u.fsPath).filter((p) => !isErdFile(p)) });
  });

  reg('dbDesigner.openFromDatabase', async () => {
    const conn = await pickConnection(context.secrets);
    if (conn) await ErdPanel.open(context, output, { kind: 'db', connection: conn });
  });

  reg('dbDesigner.manageConnections', () => removeConnection(context.secrets));

  reg('dbDesigner.newBlank', () => ErdPanel.open(context, output, { kind: 'blank', id: Date.now().toString(36) }));

  reg('dbDesigner.aiReview', () => {
    const p = ErdPanel.active();
    if (!p) return vscode.window.showInformationMessage('Open an ERD diagram first, then run the AI normalisation review.');
    p.openAiPanel();
  });
  reg('dbDesigner.aiChooseProvider', () => chooseProvider(context.secrets));
  reg('dbDesigner.aiChooseModel', () => chooseModel(context.secrets));
  reg('dbDesigner.aiSetApiKey', () => setApiKey(context.secrets));
  reg('dbDesigner.aiClearApiKeys', () => clearApiKeys(context.secrets));

  // Double-clicking *.erd.json opens the diagram.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'dbDesigner.erdFile',
      {
        openCustomDocument: (uri) => ({ uri, dispose() {} }),
        resolveCustomEditor: (doc, panel) => {
          ErdPanel.attach(context, output, { kind: 'erd', path: doc.uri.fsPath }, panel);
        },
      } satisfies vscode.CustomReadonlyEditorProvider,
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  registerTools(context);

  // ---- Activity-bar sidebar ----------------------------------------------------
  const diagrams = new DiagramsView(context);
  const connections = new ConnectionsView(context.secrets, context);
  const folders = new SqlFoldersView(context);
  context.subscriptions.push(
    vscode.window.createTreeView('dbDesigner.diagrams', { treeDataProvider: diagrams }),
    vscode.window.createTreeView('dbDesigner.connections', { treeDataProvider: connections }),
    vscode.window.createTreeView('dbDesigner.sqlFolders', { treeDataProvider: folders }),
  );
  reg('dbDesigner.refreshSidebar', () => {
    diagrams.refresh();
    connections.refresh();
    folders.refresh();
  });
  reg('dbDesigner.revealDiagram', (p: ErdPanel) => p?.reveal());
  reg('dbDesigner.openRecent', async (e: RecentEntry) => {
    const source = await resolveRecent(context.secrets, e.source);
    if (!source) {
      const pick = await vscode.window.showWarningMessage(`The saved connection for "${e.title}" no longer exists.`, 'Remove from Recent');
      if (pick) await removeRecent(context, e.key);
      diagrams.refresh();
      return;
    }
    await ErdPanel.open(context, output, source);
  });
  reg('dbDesigner.removeRecent', async (node?: { entry?: RecentEntry }) => {
    if (node?.entry) await removeRecent(context, node.entry.key);
    diagrams.refresh();
  });
  reg('dbDesigner.clearRecent', async () => {
    await removeRecent(context);
    diagrams.refresh();
  });
  reg('dbDesigner.openConnection', (c: ConnectionInfo) => c && ErdPanel.open(context, output, { kind: 'db', connection: c }));
  reg('dbDesigner.removeConnectionItem', async (c: ConnectionInfo) => {
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`Remove the saved connection "${c.name}"?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    const all = await getSavedConnections(context.secrets);
    await saveConnections(context.secrets, all.filter((x) => !(x.name === c.name && x.kind === c.kind)));
    connections.refresh();
  });
}

export function deactivate() {}
