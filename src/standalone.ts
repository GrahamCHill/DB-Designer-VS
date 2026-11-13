// Builds a single self-contained HTML file that shows a diagram in any browser (no VS Code needed).
// The same webview bundle runs with a tiny stand-in for the VS Code messaging API.

import { ErdFile, HostToWebview } from './shared/model';

/** Theme variables used by the webview when it is not running inside VS Code. */
const THEME_CSS = `
:root {
  --vscode-font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --vscode-editor-background: #ffffff;
  --vscode-foreground: #1f2328;
  --vscode-descriptionForeground: #656d76;
  --vscode-panel-border: #d0d7de;
  --vscode-editorWidget-background: #f6f8fa;
  --vscode-sideBarSectionHeader-background: #eaeef2;
  --vscode-list-hoverBackground: rgba(175, 184, 193, 0.2);
  --vscode-focusBorder: #0969da;
  --vscode-textLink-foreground: #0969da;
  --vscode-charts-yellow: #9a6700;
  --vscode-charts-blue: #0969da;
  --vscode-charts-green: #1a7f37;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #1f2328;
  --vscode-input-border: #d0d7de;
  --vscode-button-secondaryBackground: #eaeef2;
  --vscode-button-secondaryForeground: #1f2328;
  --vscode-button-secondaryHoverBackground: #dde3e9;
  --vscode-button-background: #0969da;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0860ca;
}
@media (prefers-color-scheme: dark) {
  :root {
    --vscode-editor-background: #0d1117;
    --vscode-foreground: #e6edf3;
    --vscode-descriptionForeground: #8d96a0;
    --vscode-panel-border: #30363d;
    --vscode-editorWidget-background: #161b22;
    --vscode-sideBarSectionHeader-background: #1c2129;
    --vscode-list-hoverBackground: rgba(110, 118, 129, 0.2);
    --vscode-focusBorder: #2f81f7;
    --vscode-textLink-foreground: #4493f8;
    --vscode-charts-yellow: #d29922;
    --vscode-charts-blue: #4493f8;
    --vscode-charts-green: #3fb950;
    --vscode-input-background: #0d1117;
    --vscode-input-foreground: #e6edf3;
    --vscode-input-border: #30363d;
    --vscode-button-secondaryBackground: #21262d;
    --vscode-button-secondaryForeground: #e6edf3;
    --vscode-button-secondaryHoverBackground: #30363d;
    --vscode-button-background: #1f6feb;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #388bfd;
  }
}`;

/** The browser-side "host": answers the webview's messages without VS Code. */
const HOST_SCRIPT = `
(function () {
  function download(name, href) {
    var a = document.createElement('a');
    a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function safe(s) { return (s || 'diagram').replace(/[^A-Za-z0-9_.-]+/g, '_'); }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        var load = window.__ERD_LOAD__;
        if (m.type === 'ready') setTimeout(function () { window.postMessage(load, '*'); }, 0);
        else if (m.type === 'saveImage') download(safe(load.title) + '.erd.' + m.format, m.dataUrl);
        else if (m.type === 'share' && m.kind === 'erd') {
          var blob = new Blob([JSON.stringify(m.file, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          download(safe(load.title) + '.erd.json', url);
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        }
      },
    };
  };
})();`;

/** Make text safe to embed inside a <script> or <style> element. */
function escapeForTag(text: string, tag: 'script' | 'style'): string {
  return text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

export function buildStandaloneHtml(file: ErdFile, webviewJs: string, webviewCss: string): string {
  const load: HostToWebview = {
    type: 'load',
    title: file.title,
    sourceLabel: `Shared ${new Date(file.savedAt).toLocaleString()}${file.source ? ` · ${file.source}` : ''}`,
    baseline: file.schema,
    working: file.schema,
    layout: file.layout,
    warnings: [],
    readOnlySource: true,
    mode: 'standalone',
    hiddenSchemas: file.hiddenSchemas,
    groups: file.groups,
  };
  // JSON is valid JS; escaping "<" keeps "</script>" and HTML comments from ending the element early.
  const data = JSON.stringify(load).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const title = file.title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="generator" content="DB Designer" />
<title>${title} · ERD</title>
<style>${escapeForTag(THEME_CSS, 'style')}</style>
<style>${escapeForTag(webviewCss, 'style')}</style>
<script>window.__ERD_LOAD__ = ${data};</script>
<script>${HOST_SCRIPT}</script>
</head>
<body>
<div id="root"></div>
<script>${escapeForTag(webviewJs, 'script')}</script>
</body>
</html>
`;
}
