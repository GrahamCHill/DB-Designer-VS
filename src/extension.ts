import * as vscode from 'vscode';
import { ErdPanel } from './erdPanel';
import { pickConnection, removeConnection } from './sources';
import { chooseProvider, clearAnthropicKey, setAnthropicKey } from './ai/providers';
import { registerTools } from './ai/tools';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ERD Viewer');
  context.subscriptions.push(output);

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const isErdFile = (p: string) => /\.erd\.json$/i.test(p);

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

  reg('erdViewer.openErdFile', async () => {
    const uris = await vscode.window.showOpenDialog({
      title: 'Open a shared ERD diagram',
      canSelectMany: false,
      filters: { 'ERD diagram': ['erd.json', 'json'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (uris?.length) await ErdPanel.open(context, output, { kind: 'erd', path: uris[0].fsPath });
  });

  reg('erdViewer.openFromExplorer', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
    const list = selected?.length ? selected : uri ? [uri] : [];
    if (!list.length) return vscode.commands.executeCommand('erdViewer.openFromSqlFolder');
    if (list.length === 1 && isErdFile(list[0].fsPath)) return ErdPanel.open(context, output, { kind: 'erd', path: list[0].fsPath });
    await ErdPanel.open(context, output, { kind: 'sql', paths: list.map((u) => u.fsPath).filter((p) => !isErdFile(p)) });
  });

  reg('erdViewer.openFromDatabase', async () => {
    const conn = await pickConnection(context.secrets);
    if (conn) await ErdPanel.open(context, output, { kind: 'db', connection: conn });
  });

  reg('erdViewer.manageConnections', () => removeConnection(context.secrets));

  reg('erdViewer.newBlank', () => ErdPanel.open(context, output, { kind: 'blank', id: Date.now().toString(36) }));

  reg('erdViewer.aiReview', () => {
    const p = ErdPanel.active();
    if (!p) return vscode.window.showInformationMessage('Open an ERD diagram first, then run the AI normalisation review.');
    p.openAiPanel();
  });
  reg('erdViewer.aiChooseProvider', () => chooseProvider());
  reg('erdViewer.aiSetAnthropicKey', () => setAnthropicKey(context.secrets));
  reg('erdViewer.aiClearAnthropicKey', () => clearAnthropicKey(context.secrets));

  // Double-clicking *.erd.json opens the diagram.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'erdViewer.erdFile',
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
}

export function deactivate() {}
