import * as path from 'path';
import * as vscode from 'vscode';
import { HostToWebview, Layout, Schema, WebviewToHost } from './shared/model';
import { generateDiffSql, generateFullSql } from './shared/pgExport';
import { LoadedSource, Source, loadSource, sourceKey, sourceTitle } from './sources';

interface SavedState {
  layout: Layout;
  working?: Schema;
  dirty?: boolean;
}

const STATE_PREFIX = 'erdViewer.state:';

export class ErdPanel {
  private static panels = new Map<string, ErdPanel>();

  static async open(context: vscode.ExtensionContext, output: vscode.OutputChannel, source: Source) {
    const key = sourceKey(source);
    const existing = ErdPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('erdViewer', `ERD: ${sourceTitle(source)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    const p = new ErdPanel(context, output, source, key, panel);
    ErdPanel.panels.set(key, p);
  }

  private loaded?: LoadedSource;
  private ready = false;
  private disposables: vscode.Disposable[] = [];
  private dirty = false;
  private reloadTimer?: NodeJS.Timeout;

  private constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private source: Source,
    private key: string,
    private panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m), null, this.disposables);
    const saved = this.savedState();
    this.dirty = !!saved?.dirty;
    void this.load(false);
    this.watchSources();
  }

  private savedState(): SavedState | undefined {
    return this.context.globalState.get<SavedState>(STATE_PREFIX + this.key);
  }

  private async saveState(s: SavedState) {
    await this.context.globalState.update(STATE_PREFIX + this.key, s);
  }

  private async load(discardDraft: boolean) {
    try {
      this.loaded = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading schema: ${sourceTitle(this.source)}…` },
        () => loadSource(this.source),
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      vscode.window.showErrorMessage(`ERD Viewer: ${msg}`);
      this.output.appendLine(`[error] ${sourceTitle(this.source)}: ${msg}`);
      if (!this.loaded) this.panel.dispose();
      return;
    }
    if (this.loaded.files?.length) {
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${this.loaded.label}`);
      for (const f of this.loaded.files) this.output.appendLine(`  ${f}`);
    }
    if (this.loaded.warnings.length) {
      this.output.appendLine(`${this.loaded.warnings.length} parser warning(s):`);
      for (const w of this.loaded.warnings) this.output.appendLine(`  ⚠ ${w}`);
    }
    if (discardDraft) {
      const s = this.savedState();
      await this.saveState({ layout: s?.layout ?? {} });
      this.dirty = false;
    }
    this.post();
  }

  private post() {
    if (!this.ready || !this.loaded) return;
    const saved = this.savedState();
    const baseline = this.loaded.schema;
    const working = saved?.dirty && saved.working ? saved.working : baseline;
    const msg: HostToWebview = {
      type: 'load',
      title: this.loaded.title,
      sourceLabel: this.loaded.label,
      baseline,
      working,
      layout: saved?.layout ?? {},
      warnings: this.loaded.warnings,
      readOnlySource: this.source.kind === 'db',
    };
    void this.panel.webview.postMessage(msg);
  }

  private watchSources() {
    if (this.source.kind !== 'sql') return;
    for (const p of this.source.paths) {
      const isFile = p.toLowerCase().endsWith('.sql');
      const pattern = isFile
        ? new vscode.RelativePattern(vscode.Uri.file(path.dirname(p)), path.basename(p))
        : new vscode.RelativePattern(vscode.Uri.file(p), '**/*.sql');
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = () => this.sourceChanged();
      w.onDidChange(onChange, null, this.disposables);
      w.onDidCreate(onChange, null, this.disposables);
      w.onDidDelete(onChange, null, this.disposables);
      this.disposables.push(w);
    }
  }

  private sourceChanged() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      if (!this.dirty) {
        await this.load(false);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `SQL files for "${sourceTitle(this.source)}" changed. Reload the diagram? Unsaved diagram edits will be discarded.`,
        'Reload',
        'Keep my edits',
      );
      if (choice === 'Reload') await this.load(true);
    }, 600);
  }

  private async onMessage(m: WebviewToHost) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.post();
        return;
      case 'saveState':
        this.dirty = m.dirty;
        await this.saveState({ layout: m.layout, working: m.dirty ? m.working : undefined, dirty: m.dirty });
        return;
      case 'reload': {
        if (this.dirty) {
          const ok = await vscode.window.showWarningMessage(
            'Reload from source? Your unsaved diagram edits will be discarded (positions are kept).',
            { modal: true },
            'Reload',
          );
          if (ok !== 'Reload') return;
        }
        await this.load(true);
        return;
      }
      case 'discard': {
        const ok = await vscode.window.showWarningMessage('Discard all edits made in the diagram?', { modal: true }, 'Discard');
        if (ok !== 'Discard') return;
        const s = this.savedState();
        await this.saveState({ layout: s?.layout ?? {} });
        this.dirty = false;
        this.post();
        return;
      }
      case 'export':
        return this.exportSql(m.mode, m.schema, m.baseline, m.schemas);
      case 'info':
        vscode.window.showInformationMessage(m.message);
        return;
      case 'error':
        vscode.window.showErrorMessage(m.message);
        return;
    }
  }

  private defaultExportDir(): vscode.Uri | undefined {
    if (this.source.kind === 'sql') {
      const p = this.source.paths[0];
      return vscode.Uri.file(p.toLowerCase().endsWith('.sql') ? path.dirname(p) : p);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async exportSql(mode: 'full' | 'diff', schema: Schema, baseline: Schema, schemas?: string[]) {
    const sql =
      mode === 'full'
        ? generateFullSql(schema, { schemas, sourceLabel: this.loaded?.label })
        : generateDiffSql(baseline, schema);
    const safe = sourceTitle(this.source).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'schema';
    const fileName = mode === 'full' ? `${safe}.schema.sql` : `${safe}.migration.sql`;
    const dir = this.defaultExportDir();
    const target = await vscode.window.showSaveDialog({
      title: mode === 'full' ? 'Export PostgreSQL schema' : 'Export PostgreSQL migration (changes only)',
      defaultUri: dir ? vscode.Uri.joinPath(dir, fileName) : undefined,
      filters: { SQL: ['sql'] },
      saveLabel: 'Export',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(sql, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    void this.panel.webview.postMessage({ type: 'exported', path: target.fsPath } satisfies HostToWebview);
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>ERD</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose() {
    clearTimeout(this.reloadTimer);
    ErdPanel.panels.delete(this.key);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
