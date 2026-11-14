import * as assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { CancellationToken, OutputChannel, SecretStorage } from 'vscode';
import { emptySchema } from '../src/shared/model';

const groqUrl = 'https://api.groq.com/openai/v1';
const groqSecret = 'dbDesigner.apiKey:https://api.groq.com';
const exampleKey = 'gsk_example_for_test';
const Global = 1;
const Workspace = 2;

function providerHarness() {
  const globalSettings = new Map<string, string>();
  const workspaceSettings = new Map<string, string>();
  const storedSecrets = new Map<string, string>();
  const secrets: SecretStorage = {
    get: async (key: string) => storedSecrets.get(key),
    store: async (key: string, value: string) => { storedSecrets.set(key, value); },
    delete: async (key: string) => { storedSecrets.delete(key); },
    onDidChange: () => ({ dispose() {} }),
  };
  const window = {
    showQuickPick: async (_items: { label: string }[], _options: { title: string }) => undefined as { label: string } | undefined,
    showInputBox: async (_options: { password?: boolean }) => undefined as string | undefined,
    showWarningMessage: async (_message: string, _action: string) => undefined as string | undefined,
    showInformationMessage: () => undefined,
    showErrorMessage: () => undefined,
    withProgress: async <T>(_options: unknown, run: () => Promise<T>) => run(),
  };
  const vscode = {
    window,
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global, Workspace },
    lm: {
      selectChatModels: async () => [
        { id: 'vendor-one/model', name: 'Chat model', vendor: 'vendor-one', family: 'shared-family' },
        { id: 'vendor-two/model', name: 'Chat model', vendor: 'vendor-two', family: 'shared-family' },
      ],
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => workspaceSettings.get(key) ?? globalSettings.get(key),
        inspect: (key: string) => ({ workspaceValue: workspaceSettings.get(key) }),
        update: async (key: string, value: string, target: number) => {
          (target === Workspace ? workspaceSettings : globalSettings).set(key, value);
        },
      }),
    },
  };
  // The provider bundle treats VS Code as an external module, as the extension build does.
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (id: string, ...args: unknown[]) {
    return id === 'vscode' ? vscode : load.call(this, id, ...args);
  };
  const importProviders = async () => {
    try {
      return await import('../src/ai/providers');
    } finally {
      Module._load = load;
    }
  };
  return { globalSettings, workspaceSettings, storedSecrets, secrets, window, importProviders };
}

const harness = providerHarness();

beforeEach(() => {
  harness.globalSettings.clear();
  harness.workspaceSettings.clear();
  harness.storedSecrets.clear();
});

test('Groq setup discovers models with the secret key and later reviews use the saved model', async (t) => {
  const { globalSettings, storedSecrets, secrets, window, importProviders } = harness;
  const { chooseProvider, runReview } = await importProviders();
  t.mock.method(window, 'showInputBox', async ({ password }: { password?: boolean }) => {
    assert.equal(password, true);
    return `  ${exampleKey}  `;
  });
  t.mock.method(window, 'showQuickPick', async (items: { label: string }[], { title }: { title: string }) => {
    if (title === 'AI provider for normalisation reviews') return items.find(({ label }) => label.startsWith('Groq'));
    if (title === 'OpenAI-compatible endpoint') return items.find(({ label }) => label === 'Groq');
    assert.equal(title, 'Groq model');
    assert.deepEqual(items.map(({ label }) => label), ['model-a', 'model-b']);
    return items.find(({ label }) => label === 'model-b');
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${exampleKey}`);
    if (url === `${groqUrl}/models`) {
      assert.equal(storedSecrets.get(groqSecret), exampleKey);
      return Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }, { id: 'inactive', active: false }] });
    }
    assert.equal(url, `${groqUrl}/chat/completions`);
    assert.equal(JSON.parse(init.body as string).model, 'model-b');
    return Response.json({ choices: [{ message: { content: '{"summary":"Reviewed","suggestions":[]}' } }] });
  });
  const env = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  t.after(() => { if (env !== undefined) process.env.GROQ_API_KEY = env; });
  assert.equal(await chooseProvider(secrets), 'openai');
  assert.deepEqual(Object.fromEntries(globalSettings), { openaiBaseUrl: groqUrl, openaiModel: 'model-b', provider: 'openai' });
  const token = { onCancellationRequested: () => ({ dispose() {} }) } as unknown as CancellationToken;
  const output = { appendLine() {} } as unknown as OutputChannel;
  assert.equal((await runReview({ schema: emptySchema() }, secrets, token, output)).model, 'model-b (Groq)');
  assert.equal(fetch.mock.callCount(), 2);
});

test('Groq model discovery retries a rejected key and saves the model at the effective settings scope', async (t) => {
  const { workspaceSettings, storedSecrets, secrets, window, importProviders } = harness;
  const { chooseModel } = await importProviders();
  workspaceSettings.set('openaiModel', 'old-model');
  storedSecrets.set(groqSecret, 'rejected-test-key');
  t.mock.method(window, 'showWarningMessage', async (message: string, action: string) => {
    assert.match(message, /HTTP 401/);
    assert.equal(action, 'Set API Key');
    return action;
  });
  t.mock.method(window, 'showInputBox', async () => exampleKey);
  t.mock.method(window, 'showQuickPick', async (items: { label: string }[]) => items[0]);
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${groqUrl}/models`);
    const authorization = new Headers(init.headers).get('authorization');
    if (authorization === 'Bearer rejected-test-key') return new Response(null, { status: 401 });
    assert.equal(authorization, `Bearer ${exampleKey}`);
    return Response.json({ data: [{ id: 'new-model' }] });
  });
  assert.equal(await chooseModel(secrets, 'openai'), 'new-model');
  assert.equal(workspaceSettings.get('openaiModel'), 'new-model');
  assert.equal(storedSecrets.get(groqSecret), exampleKey);
  assert.equal(fetch.mock.callCount(), 2);
});

test('cancelling the Groq picker leaves the saved model intact', async (t) => {
  const { workspaceSettings, storedSecrets, secrets, window, importProviders } = harness;
  const { chooseModel } = await importProviders();
  workspaceSettings.set('openaiModel', 'keep-this-model');
  storedSecrets.set(groqSecret, exampleKey);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'different-model' }] }));
  t.mock.method(window, 'showQuickPick', async () => undefined);
  assert.equal(await chooseModel(secrets, 'openai'), undefined);
  assert.equal(workspaceSettings.get('openaiModel'), 'keep-this-model');
});

test('Ollama saves a discovered tag for the configured server', async (t) => {
  const { workspaceSettings, secrets, window, importProviders } = harness;
  const { chooseModel } = await importProviders();
  workspaceSettings.set('ollamaUrl', 'http://localhost:11434/');
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'http://localhost:11434/api/tags');
    return Response.json({ models: [{ name: 'qwen:latest' }, { name: 'another:latest' }] });
  });
  t.mock.method(window, 'showQuickPick', async (items: { label: string }[]) => items[0]);
  assert.equal(await chooseModel(secrets, 'ollama'), 'qwen:latest');
  assert.equal(workspaceSettings.get('ollamaModel'), 'qwen:latest');
});

test('VS Code saves the exact model ID when two models share a family', async (t) => {
  const { globalSettings, secrets, window, importProviders } = harness;
  const { chooseModel } = await importProviders();
  t.mock.method(window, 'showQuickPick', async (items: { label: string }[]) => items[1]);
  assert.equal(await chooseModel(secrets, 'vscode'), 'vendor-two/model');
  assert.equal(globalSettings.get('vscodeModel'), 'vendor-two/model');
});

test('Anthropic discovers models using the encrypted-storage credential', async (t) => {
  const { globalSettings, storedSecrets, secrets, window, importProviders } = harness;
  const { chooseModel } = await importProviders();
  storedSecrets.set('dbDesigner.anthropicApiKey', 'sk-ant-example-for-test');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, '/v1/models');
    assert.equal(request.headers.get('authorization'), 'Bearer sk-ant-example-for-test');
    return Response.json({ data: [{ id: 'claude-discovered', display_name: 'Discovered Claude' }], has_more: false });
  });
  t.mock.method(window, 'showQuickPick', async (items: { label: string }[]) => items.find(({ label }) => label === 'Discovered Claude'));
  assert.equal(await chooseModel(secrets, 'anthropic'), 'claude-discovered');
  assert.equal(globalSettings.get('anthropicModel'), 'claude-discovered');
});
