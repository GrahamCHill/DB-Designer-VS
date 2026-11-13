import * as vscode from 'vscode';
import { ErdPanel } from './erdPanel';
import { pickConnection, removeConnection } from './sources';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ERD Viewer');
  context.subscriptions.push(output);

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('erdViewer.openFromSqlFolder', async () => {
    const uris = await vscode.window.showOpenDialog({
      title: 'Choose a folder of .sql files (e.g. a migrations or db folder)',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (uris?.length) await ErdPanel.open(context, output, { kind: 'sql', paths: [uris[0].fsPath] });
  });

  reg('erdViewer.openFromSqlFiles', async () => {
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

  reg('erdViewer.openFromExplorer', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
    const list = selected?.length ? selected : uri ? [uri] : [];
    if (!list.length) return vscode.commands.executeCommand('erdViewer.openFromSqlFolder');
    await ErdPanel.open(context, output, { kind: 'sql', paths: list.map((u) => u.fsPath) });
  });

  reg('erdViewer.openFromDatabase', async () => {
    const conn = await pickConnection(context.secrets);
    if (conn) await ErdPanel.open(context, output, { kind: 'db', connection: conn });
  });

  reg('erdViewer.manageConnections', () => removeConnection(context.secrets));

  reg('erdViewer.newBlank', () => ErdPanel.open(context, output, { kind: 'blank', id: Date.now().toString(36) }));
}

export function deactivate() {}
