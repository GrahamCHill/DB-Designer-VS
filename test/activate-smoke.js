// Loads dist/extension.js with a stubbed `vscode` module and checks that activate() registers every
// contributed command, the .erd.json custom editor and the language model tools.
const Module = require('module');
const registered = [];
const editors = [];
const tools = [];
const stub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    registerCustomEditorProvider: (id) => (editors.push(id), { dispose() {} }),
  },
  commands: { registerCommand: (id) => (registered.push(id), { dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: () => [] }) },
  lm: { registerTool: (name) => (tools.push(name), { dispose() {} }) },
};
const orig = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? stub : orig.call(this, req, ...rest);
};
const ext = require('../dist/extension.js');
ext.activate({ subscriptions: [], secrets: {}, globalState: {}, extensionUri: {} });
const pkg = require('../package.json');
const fail = (m) => (console.error(m), process.exit(1));
const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.includes(c));
if (missing.length) fail(`commands not registered: ${missing}`);
const missingEditors = pkg.contributes.customEditors.map((e) => e.viewType).filter((v) => !editors.includes(v));
if (missingEditors.length) fail(`custom editors not registered: ${missingEditors}`);
const missingTools = pkg.contributes.languageModelTools.map((t) => t.name).filter((n) => !tools.includes(n));
if (missingTools.length) fail(`tools not registered: ${missingTools}`);
console.log(`OK: ${registered.length} commands, ${editors.length} custom editor, ${tools.length} LM tools registered`);
