import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ErdFile, HostToWebview, Layout, Schema, WebviewToHost } from './shared/model';
import { generateDiffSql, generateFullSql } from './shared/pgExport';
import { SchemaOp } from './shared/ops';
import { LoadedSource, Source, loadSource, sourceKey, sourceTitle } from './sources';
import { chooseProvider, currentProvider, providerLabel, runReview } from './ai/providers';
import { buildStandaloneHtml } from './standalone';

interface SavedState {
  layout: Layout;
  working?: Schema;
  dirty?: boolean;
}

const STATE_PREFIX = 'erdViewer.state:';

export class ErdPanel {
  private static panels = new Map<string, ErdPanel>();
  private static all = new Set<ErdPanel>();
  private static lastActive?: ErdPanel;

  /** The ERD panel the user is looking at (or used most recently). */
  static active(): ErdPanel | undefined {
    if (ErdPanel.lastActive && ErdPanel.all.has(ErdPanel.lastActive)) return ErdPanel.lastActive;
    return [...ErdPanel.all].pop();
  }

  static openPanels(): ErdPanel[] {
    return [...ErdPanel.all];
  }

  static async open(context: vscode.ExtensionContext, output: vscode.OutputChannel, source: Source) {
    const key = sourceKey(source);
    const existing = ErdPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('erdViewer', `ERD: ${sourceTitle(source)}`, vscode.ViewColumn.Active, ErdPanel.webviewOptions(context));
    ErdPanel.panels.set(key, new ErdPanel(context, output, source, key, panel));
  }

  /** Attach to a panel VS Code created for us (custom editor for *.erd.json). */
  static attach(context: vscode.ExtensionContext, output: vscode.OutputChannel, source: Source, panel: vscode.WebviewPanel) {
    panel.webview.options = ErdPanel.webviewOptions(context);
    return new ErdPanel(context, output, source, sourceKey(source), panel);
  }

  private static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
  }

  private loaded?: LoadedSource;
  private ready = false;
  private disposables: vscode.Disposable[] = [];
  private dirty = false;
  private reloadTimer?: NodeJS.Timeout;
  /** Latest working schema and layout reported by the webview. */
  private working?: Schema;
  private layout: Layout = {};
  private aiCancel?: vscode.CancellationTokenSource;
  private pendingOps = new Map<string, (errors: string[]) => void>();

  private constructor(
    private context: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private source: Source,
    private key: string,
    private panel: vscode.WebviewPanel,
  ) {
    ErdPanel.all.add(this);
    ErdPanel.lastActive = this;
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState((e) => e.webviewPanel.active && (ErdPanel.lastActive = this), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m), null, this.disposables);
    const saved = this.savedState();
    this.dirty = !!saved?.dirty;
    void this.load(false);
    this.watchSources();
  }

  get title(): string {
    return this.loaded?.title ?? sourceTitle(this.source);
  }

  /** Current diagram state as the user sees it. */
  currentSchema(): Schema | undefined {
    return this.working ?? this.loaded?.schema;
  }

  baselineSchema(): Schema | undefined {
    return this.loaded?.schema;
  }

  reveal() {
    this.panel.reveal();
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

  private send(m: HostToWebview) {
    void this.panel.webview.postMessage(m);
  }

  private post() {
    if (!this.ready || !this.loaded) return;
    const saved = this.savedState();
    const baseline = this.loaded.schema;
    const working = saved?.dirty && saved.working ? saved.working : baseline;
    this.working = working;
    const layout = saved?.layout && Object.keys(saved.layout).length ? saved.layout : (this.loaded.layout ?? {});
    this.layout = layout;
    this.send({
      type: 'load',
      title: this.loaded.title,
      sourceLabel: this.loaded.label,
      baseline,
      working,
      layout,
      warnings: this.loaded.warnings,
      readOnlySource: this.source.kind === 'db',
      mode: 'extension',
      canSaveFile: this.source.kind === 'erd',
      hiddenSchemas: this.loaded.hiddenSchemas,
      aiProvider: providerLabel(currentProvider()),
    });
  }

  private watchSources() {
    const paths = this.source.kind === 'sql' ? this.source.paths : this.source.kind === 'erd' ? [this.source.path] : [];
    for (const p of paths) {
      const isFile = /\.(sql|json)$/i.test(p);
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

  private savingFile = false;

  private sourceChanged() {
    if (this.savingFile) return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      if (!this.dirty) {
        await this.load(false);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `The source of "${sourceTitle(this.source)}" changed. Reload the diagram? Unsaved diagram edits will be discarded.`,
        'Reload',
        'Keep my edits',
      );
      if (choice === 'Reload') await this.load(true);
    }, 600);
  }

  // ---- agent / AI hooks ------------------------------------------------------

  /** Apply operations in the webview as one undoable edit; resolves with per-op errors. */
  applyOps(ops: SchemaOp[], description?: string): Promise<string[]> {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(requestId);
        resolve(['The diagram did not respond. Is the ERD panel still open?']);
      }, 15000);
      this.pendingOps.set(requestId, (errors) => {
        clearTimeout(timer);
        resolve(errors);
      });
      this.send({ type: 'applyOps', requestId, ops, description });
    });
  }

  openAiPanel() {
    this.panel.reveal();
    this.send({ type: 'openAi' });
  }

  private async runAi(request: import('./shared/ai').ReviewRequest) {
    this.aiCancel?.cancel();
    const cts = (this.aiCancel = new vscode.CancellationTokenSource());
    try {
      const review = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `ERD Viewer: AI normalisation review (${providerLabel(currentProvider())})…`, cancellable: true },
        (_p, token) => {
          token.onCancellationRequested(() => cts.cancel());
          return runReview(request, this.context.secrets, cts.token, this.output);
        },
      );
      this.send({ type: 'aiResult', review });
    } catch (e) {
      const cancelled = e instanceof vscode.CancellationError || cts.token.isCancellationRequested;
      this.send({ type: 'aiError', message: cancelled ? 'Cancelled.' : (e as Error).message ?? String(e) });
      if (!cancelled) this.output.appendLine(`[ai] error: ${(e as Error).stack ?? e}`);
    } finally {
      if (this.aiCancel === cts) this.aiCancel = undefined;
      cts.dispose();
    }
  }

  // ---- messages -----------------------------------------------------------------

  private async onMessage(m: WebviewToHost) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.post();
        return;
      case 'saveState':
        this.dirty = m.dirty;
        this.working = m.working;
        this.layout = m.layout;
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
      case 'saveImage':
        return this.saveImage(m.format, m.dataUrl);
      case 'share':
        return this.share(m.kind, m.file);
      case 'saveFile':
        return this.saveErdFile(m.file);
      case 'aiReview':
        return this.runAi(m.request);
      case 'aiCancel':
        this.aiCancel?.cancel();
        return;
      case 'aiChooseProvider': {
        const p = await chooseProvider();
        if (p) this.send({ type: 'aiProvider', label: providerLabel(p) });
        return;
      }
      case 'opsApplied': {
        const done = this.pendingOps.get(m.requestId);
        this.pendingOps.delete(m.requestId);
        done?.(m.errors);
        return;
      }
      case 'info':
        vscode.window.showInformationMessage(m.message);
        return;
      case 'error':
        vscode.window.showErrorMessage(m.message);
        return;
    }
  }

  private defaultDir(): vscode.Uri | undefined {
    if (this.source.kind === 'sql') {
      const p = this.source.paths[0];
      return vscode.Uri.file(p.toLowerCase().endsWith('.sql') ? path.dirname(p) : p);
    }
    if (this.source.kind === 'erd') return vscode.Uri.file(path.dirname(this.source.path));
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private safeName(): string {
    return this.title.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'schema';
  }

  private async pickTarget(title: string, fileName: string, filters: Record<string, string[]>) {
    const dir = this.defaultDir();
    return vscode.window.showSaveDialog({ title, defaultUri: dir ? vscode.Uri.joinPath(dir, fileName) : undefined, filters, saveLabel: 'Export' });
  }

  private async exportSql(mode: 'full' | 'diff', schema: Schema, baseline: Schema, schemas?: string[]) {
    const sql = mode === 'full' ? generateFullSql(schema, { schemas, sourceLabel: this.loaded?.label }) : generateDiffSql(baseline, schema);
    const target = await this.pickTarget(
      mode === 'full' ? 'Export PostgreSQL schema' : 'Export PostgreSQL migration (changes only)',
      `${this.safeName()}.${mode === 'full' ? 'schema' : 'migration'}.sql`,
      { SQL: ['sql'] },
    );
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(sql, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    this.send({ type: 'exported', path: target.fsPath });
  }

  private async saveImage(format: 'png' | 'svg', dataUrl: string) {
    const target = await this.pickTarget(
      format === 'png' ? 'Export diagram as PNG' : 'Export diagram as SVG',
      `${this.safeName()}.erd.${format}`,
      format === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
    );
    if (!target) return;
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const bytes = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    await vscode.workspace.fs.writeFile(target, bytes);
    this.send({ type: 'exported', path: target.fsPath });
    const open = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)} (${(bytes.length / 1048576).toFixed(1)} MB).`, 'Open');
    if (open) await vscode.env.openExternal(target);
  }

  private async share(kind: 'erd' | 'html', file: ErdFile) {
    file.source = file.source ?? this.loaded?.label;
    if (kind === 'erd') {
      const target = await this.pickTarget('Save shareable diagram', `${this.safeName()}.erd.json`, { 'ERD diagram': ['erd.json', 'json'] });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(file, null, 2), 'utf8'));
      this.send({ type: 'exported', path: target.fsPath });
      vscode.window.showInformationMessage(
        `Saved ${path.basename(target.fsPath)}. Anyone with ERD Viewer can open it (double-click in VS Code) and keep editing.`,
      );
      return;
    }
    const target = await this.pickTarget('Save standalone HTML viewer', `${this.safeName()}.erd.html`, { HTML: ['html'] });
    if (!target) return;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const [js, css] = await Promise.all([
      fs.readFile(vscode.Uri.joinPath(dist, 'webview.js').fsPath, 'utf8'),
      fs.readFile(vscode.Uri.joinPath(dist, 'webview.css').fsPath, 'utf8'),
    ]);
    const html = buildStandaloneHtml(file, js, css);
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    this.send({ type: 'exported', path: target.fsPath });
    const open = await vscode.window.showInformationMessage(
      `Saved ${path.basename(target.fsPath)} (${(html.length / 1048576).toFixed(1)} MB). It opens in any browser — no install needed.`,
      'Open in browser',
    );
    if (open) await vscode.env.openExternal(target);
  }

  private async saveErdFile(file: ErdFile) {
    if (this.source.kind !== 'erd') return;
    this.savingFile = true;
    try {
      await fs.writeFile(this.source.path, JSON.stringify(file, null, 2), 'utf8');
      await this.saveState({ layout: file.layout });
      this.dirty = false;
      await this.load(false);
      this.send({ type: 'saved' });
    } finally {
      setTimeout(() => (this.savingFile = false), 1500);
    }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} data:;" />
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
    this.aiCancel?.cancel();
    if (ErdPanel.panels.get(this.key) === this) ErdPanel.panels.delete(this.key);
    ErdPanel.all.delete(this);
    if (ErdPanel.lastActive === this) ErdPanel.lastActive = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
