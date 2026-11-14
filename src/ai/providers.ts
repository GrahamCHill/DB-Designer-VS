import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { AiReview, REVIEW_JSON_SCHEMA, ReviewRequest, SYSTEM_PROMPT, buildUserPrompt, extractJson, toReview } from '../shared/ai';

export type AiProvider = 'vscode' | 'anthropic' | 'openai' | 'ollama';

const ANTHROPIC_KEY = 'dbDesigner.anthropicApiKey';
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/** Ready-made OpenAI-compatible endpoints. */
export const OPENAI_PRESETS = [
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', keyUrl: 'console.groq.com/keys' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyUrl: 'platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keyUrl: 'openrouter.ai/keys' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', env: '', keyUrl: '' },
] as const;

function cfg() {
  return vscode.workspace.getConfiguration('dbDesigner.ai');
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  vscode: 'VS Code language model (e.g. Copilot)',
  anthropic: 'Anthropic Claude API',
  openai: 'Groq / OpenAI-compatible API',
  ollama: 'Ollama (local)',
};

function settingsTarget(...keys: string[]): vscode.ConfigurationTarget {
  const settings = cfg();
  return keys.some((key) => settings.inspect(key)?.workspaceValue !== undefined)
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function openAiBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function openaiEndpoint(): { baseUrl: string; model: string; label: string } {
  const configured = cfg().get<string>('openaiBaseUrl') || OPENAI_PRESETS[0].baseUrl;
  const baseUrl = openAiBaseUrl(configured);
  if (!baseUrl) return { baseUrl: configured, model: '', label: 'OpenAI-compatible API' };
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === baseUrl);
  return { baseUrl, model: cfg().get<string>('openaiModel')?.trim() || '', label: preset?.label ?? new URL(baseUrl).host };
}

/** Secret Storage key for an endpoint's API key (one per host). */
function keyName(baseUrl: string): string {
  return `dbDesigner.apiKey:${new URL(baseUrl).origin}`;
}

function isLocalEndpoint(baseUrl: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
}

export function providerLabel(p: AiProvider): string {
  if (p === 'openai') {
    const e = openaiEndpoint();
    return `${e.label} (OpenAI-compatible)${e.model ? ` · ${e.model}` : ''}`;
  }
  const label = PROVIDER_LABELS[p];
  const model = cfg().get<string>(`${p}Model`)?.trim();
  return model ? `${label} · ${model}` : label;
}

export function currentProvider(): AiProvider {
  return (cfg().get<string>('provider') as AiProvider) || 'vscode';
}

export async function chooseProvider(secrets: vscode.SecretStorage): Promise<AiProvider | undefined> {
  const items = (['vscode', 'anthropic', 'openai', 'ollama'] as AiProvider[]).map((p) => ({
    label: PROVIDER_LABELS[p],
    description: p === currentProvider() ? 'current' : undefined,
    detail: {
      vscode: 'Uses a chat model already available in VS Code (GitHub Copilot or another installed provider). No API key needed.',
      anthropic: 'Calls Claude directly with your Anthropic API key (stored encrypted in VS Code Secret Storage).',
      openai: 'Groq, OpenAI, OpenRouter, LM Studio or any OpenAI-compatible endpoint. The API key is stored encrypted in VS Code Secret Storage.',
      ollama: 'Runs against a local Ollama server, so the schema never leaves your machine.',
    }[p],
    p,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'AI provider for normalisation reviews' });
  if (!pick) return undefined;
  if (!(await (pick.p === 'openai' ? configureOpenAi(secrets) : chooseModel(secrets, pick.p)))) return undefined;
  await cfg().update('provider', pick.p, settingsTarget('provider'));
  return pick.p;
}

export async function chooseModel(secrets: vscode.SecretStorage, provider = currentProvider()): Promise<string | undefined> {
  const setting = `${provider}Model`;
  const current = cfg().get<string>(setting)?.trim();
  let model: string | undefined;
  if (provider === 'openai') {
    const endpoint = openaiEndpoint();
    if (!openAiBaseUrl(endpoint.baseUrl)) return configureOpenAi(secrets);
    model = await pickOpenAiModel(secrets, endpoint.baseUrl, endpoint.model);
  } else if (provider === 'anthropic') {
    model = await pickAnthropicModel(secrets, current);
  } else if (provider === 'ollama') {
    let models: ModelChoice[];
    try {
      const baseUrl = ollamaUrl();
      models = await loadModels('Ollama', (signal) => listOllamaModels(baseUrl, signal));
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
      return undefined;
    }
    model = (await modelPicker('Ollama', models, current))?.model.id;
  } else {
    model = (await pickVscodeModel(await vscode.lm.selectChatModels(), current))?.id;
  }
  if (model) {
    const keys = provider === 'openai' ? [setting, 'openaiBaseUrl'] : provider === 'ollama' ? [setting, 'ollamaUrl'] : [setting];
    await cfg().update(setting, model, settingsTarget(...keys));
  }
  return model;
}

async function configureOpenAi(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const current = openaiEndpoint();
  const presetPick = await vscode.window.showQuickPick(
    [
      ...OPENAI_PRESETS.map((x) => ({ label: x.label, description: x.baseUrl, baseUrl: x.baseUrl as string | undefined })),
      { label: 'Custom endpoint…', description: 'Any OpenAI-compatible /v1 URL', baseUrl: undefined },
    ],
    { title: 'OpenAI-compatible endpoint', placeHolder: `Current: ${current.baseUrl}` },
  );
  if (!presetPick) return undefined;
  let baseUrl = presetPick.baseUrl;
  if (!baseUrl) {
    const input = await vscode.window.showInputBox({
      title: 'OpenAI-compatible base URL',
      value: current.baseUrl,
      prompt: 'The URL that ends before /chat/completions, e.g. https://api.together.xyz/v1',
      ignoreFocusOut: true,
      validateInput: (v) => openAiBaseUrl(v) ? undefined : 'Enter an HTTP or HTTPS URL without credentials, a query string or a fragment.',
    });
    baseUrl = input && openAiBaseUrl(input);
    if (!baseUrl) return undefined;
  }
  const model = await pickOpenAiModel(secrets, baseUrl, baseUrl === current.baseUrl ? current.model : undefined);
  if (model) {
    const target = settingsTarget('openaiBaseUrl', 'openaiModel');
    await cfg().update('openaiBaseUrl', baseUrl, target);
    await cfg().update('openaiModel', model, target);
  }
  return model;
}

interface ModelChoice {
  id: string;
  name?: string;
  detail?: string;
}

function modelPicker<T extends ModelChoice>(label: string, models: T[], current?: string) {
  const items = models.map((model) => ({
    label: model.name || model.id,
    description: [model.name && model.id, model.id === current && 'current'].filter(Boolean).join(' · '),
    detail: model.detail,
    model,
  }));
  return vscode.window.showQuickPick(items, {
    title: `${label} model`,
    placeHolder: 'Choose the model to save for normalisation reviews',
    matchOnDescription: true,
  });
}

function loadModels<T>(label: string, load: (signal: AbortSignal) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DB Designer: Loading ${label} models…` },
    () => load(AbortSignal.timeout(15000)),
  );
}

async function listOpenAiModels(baseUrl: string, label: string, key?: string) {
  try {
    return await loadModels(label, async (signal) => {
      const response = await fetch(`${baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal });
      if (!response.ok) return { status: response.status, models: [] };
      const body = (await response.json()) as { data?: { id?: string; active?: boolean }[] } | null;
      const ids = Array.isArray(body?.data) ? body.data.flatMap((model) =>
        model?.active !== false && typeof model?.id === 'string' && model.id.trim() ? [model.id] : [],
      ) : [];
      return { status: response.status, models: [...new Set(ids)].sort() };
    });
  } catch {
    return undefined;
  }
}

async function pickOpenAiModel(secrets: vscode.SecretStorage, baseUrl: string, current?: string): Promise<string | undefined> {
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === baseUrl);
  const label = preset?.label ?? new URL(baseUrl).host;
  let key = await getOpenAiKey(secrets, baseUrl);
  if (!key && !isLocalEndpoint(baseUrl)) {
    key = await setApiKeyFor(secrets, baseUrl, label, preset?.keyUrl);
    if (!key) return undefined;
  }
  let result = await listOpenAiModels(baseUrl, label, key);
  if (result?.status === 401 || result?.status === 403) {
    const action = await vscode.window.showWarningMessage(`${label} refused access to the model list (HTTP ${result.status}).`, 'Set API Key');
    if (action !== 'Set API Key') return undefined;
    key = await setApiKeyFor(secrets, baseUrl, label, preset?.keyUrl);
    if (!key) return undefined;
    result = await listOpenAiModels(baseUrl, label, key);
    if (result?.status === 401 || result?.status === 403) {
      void vscode.window.showErrorMessage(`${label} still refuses access to the model list (HTTP ${result.status}). Check the API key and its permissions.`);
      return undefined;
    }
  }
  if (result?.models.length) {
    const items = result.models.map((id) => ({ id }));
    return (await modelPicker(label, items, current))?.model.id;
  }
  let problem = `Could not load models from ${label}. Check the endpoint and try again.`;
  if (result) {
    problem = result.status < 300 ? `${label} returned no available models.` : `${label} could not list models (HTTP ${result.status}).`;
  }
  const manual = await vscode.window.showWarningMessage(problem, 'Enter Model ID');
  if (manual !== 'Enter Model ID') return undefined;
  const input = await vscode.window.showInputBox({
    title: `${label} model ID`,
    prompt: 'Enter the model ID to save for normalisation reviews',
    value: current,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter a model ID.',
  });
  return input?.trim();
}

async function getAnthropicKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return (await secrets.get(ANTHROPIC_KEY)) || process.env.ANTHROPIC_API_KEY;
}

async function pickAnthropicModel(secrets: vscode.SecretStorage, current?: string): Promise<string | undefined> {
  let apiKey = await getAnthropicKey(secrets);
  if (!apiKey) {
    apiKey = await setAnthropicKey(secrets);
    if (!apiKey) return undefined;
  }
  let models: ModelChoice[];
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    models = await loadModels('Anthropic', async (signal) => {
      const choices: ModelChoice[] = [];
      for await (const model of client.models.list({}, { signal })) {
        const capabilities = model.capabilities;
        if (capabilities?.structured_outputs?.supported === false || capabilities?.effort?.high?.supported === false) continue;
        choices.push({ id: model.id, name: model.display_name });
      }
      return choices;
    });
  } catch (e) {
    const warning = e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError
      ? 'Anthropic refused access to the model list. Run “DB Designer: AI: Set API Key” to update the key.'
      : 'Could not load Anthropic models. Check your connection and try again.';
    void vscode.window.showErrorMessage(warning);
    return undefined;
  }
  if (models.length) return (await modelPicker('Anthropic', models, current))?.model.id;
  void vscode.window.showWarningMessage('Anthropic returned no models compatible with normalisation reviews.');
}

async function pickVscodeModel(models: vscode.LanguageModelChat[], current?: string): Promise<vscode.LanguageModelChat | undefined> {
  if (!models.length) {
    void vscode.window.showWarningMessage('No VS Code chat models are available. Sign in to GitHub Copilot or install a language model provider.');
    return undefined;
  }
  const selected = models.find((m) => m.id === current) ?? models.find((m) => m.family === current);
  const choices = models.map((chat) => ({ id: chat.id, name: chat.name, detail: `${chat.vendor} · ${chat.family}`, chat }));
  return (await modelPicker('VS Code', choices, selected?.id))?.model.chat;
}

function ollamaUrl(): string {
  return (cfg().get<string>('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '');
}

async function listOllamaModels(baseUrl: string, signal: AbortSignal): Promise<ModelChoice[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, { signal });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new Error('Could not connect to Ollama. Check the configured URL and whether the server is running.', { cause: e });
  }
  if (!response.ok) throw new Error(`Ollama could not list models (HTTP ${response.status}).`);
  const tags = (await response.json()) as { models?: { name: string }[] };
  const models = tags.models ?? [];
  if (!models.length) throw new Error(`No models found in Ollama at ${baseUrl}. Pull one first, e.g. "ollama pull qwen2.5-coder".`);
  return models.map(({ name }) => ({ id: name }));
}

function envKey(baseUrl: string): string | undefined {
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === baseUrl);
  return preset?.env ? process.env[preset.env] : undefined;
}

async function getOpenAiKey(secrets: vscode.SecretStorage, baseUrl: string): Promise<string | undefined> {
  return (await secrets.get(keyName(baseUrl))) || envKey(baseUrl);
}

async function setApiKeyFor(secrets: vscode.SecretStorage, baseUrl: string, label: string, keyUrl?: string): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: `${label} API key`,
    prompt: `Stored encrypted in VS Code Secret Storage (your OS keychain), never in settings.${keyUrl ? ` Get a key at ${keyUrl}.` : ''}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length >= 8 ? undefined : 'That does not look like an API key'),
  });
  if (!key) return undefined;
  const apiKey = key.trim();
  await secrets.store(keyName(baseUrl), apiKey);
  vscode.window.showInformationMessage(`${label} API key saved (encrypted).`);
  return apiKey;
}

/** "AI: Set API Key…": Anthropic or the configured OpenAI-compatible endpoint. */
export async function setApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const e = openaiEndpoint();
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic', description: 'console.anthropic.com', id: 'anthropic' },
      ...(openAiBaseUrl(e.baseUrl) ? [{ label: e.label, description: e.baseUrl, id: 'openai' }] : []),
    ],
    { title: 'Which API key do you want to save (encrypted)?' },
  );
  if (!pick) return false;
  if (pick.id === 'anthropic') return !!(await setAnthropicKey(secrets));
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === e.baseUrl);
  return !!(await setApiKeyFor(secrets, e.baseUrl, e.label, preset?.keyUrl));
}

export async function clearApiKeys(secrets: vscode.SecretStorage) {
  const e = openaiEndpoint();
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic', id: 'anthropic' },
      ...(openAiBaseUrl(e.baseUrl) ? [{ label: e.label, description: e.baseUrl, id: 'openai' }] : []),
    ],
    { title: 'Remove which saved API key?', canPickMany: true },
  );
  if (!pick?.length) return;
  for (const x of pick) await secrets.delete(x.id === 'anthropic' ? ANTHROPIC_KEY : keyName(e.baseUrl));
  vscode.window.showInformationMessage(`Removed ${pick.length} API key(s).`);
}

async function setAnthropicKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Anthropic API key',
    prompt: 'Stored encrypted in VS Code Secret Storage (your OS keychain). Create one at console.anthropic.com.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().startsWith('sk-ant-') ? undefined : 'Expected a key starting with sk-ant-'),
  });
  if (!key) return undefined;
  const apiKey = key.trim();
  await secrets.store(ANTHROPIC_KEY, apiKey);
  vscode.window.showInformationMessage('Anthropic API key saved (encrypted).');
  return apiKey;
}

export async function clearAnthropicKey(secrets: vscode.SecretStorage) {
  await secrets.delete(ANTHROPIC_KEY);
  vscode.window.showInformationMessage('Anthropic API key removed.');
}

/** OpenAI-compatible chat completions (Groq, OpenAI, OpenRouter, LM Studio, …). */
async function runOpenAi(user: string, secrets: vscode.SecretStorage, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
  let { baseUrl, model, label } = openaiEndpoint();
  if (!model) {
    if (!(await chooseModel(secrets, 'openai'))) throw new vscode.CancellationError();
    ({ baseUrl, model, label } = openaiEndpoint());
  }
  let key = await getOpenAiKey(secrets, baseUrl);
  if (!key && !isLocalEndpoint(baseUrl)) {
    key = await setApiKeyFor(secrets, baseUrl, label);
    if (!key) throw new vscode.CancellationError();
  }
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  const call = async (format: 'schema' | 'json' | 'none') =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        ...(format === 'schema'
          ? { response_format: { type: 'json_schema', json_schema: { name: 'normalisation_review', schema: REVIEW_JSON_SCHEMA, strict: false } } }
          : format === 'json'
            ? { response_format: { type: 'json_object' } }
            : {}),
      }),
    });
  try {
    // Prefer schema-constrained output; fall back for servers/models without it (the prompt asks for JSON anyway).
    let res = await call('schema');
    for (const next of ['json', 'none'] as const) {
      if (res.status !== 400 && res.status !== 422) break;
      const body = await res.text();
      if (!/response_format|json|schema|format/i.test(body)) throw new Error(`${label} returned ${res.status}: ${body.slice(0, 300)}`);
      res = await call(next);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${label} rejected the API key. Run "DB Designer: AI: Set API Key…".`);
    if (res.status === 404) throw new Error(`${label}: model "${model}" or the endpoint was not found (${baseUrl}).`);
    if (res.status === 429) throw new Error(`${label} rate limit reached. Try again in a moment.`);
    if (!res.ok) throw new Error(`${label} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; model?: string };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('The review was cut off by the model\'s output limit. Try narrowing it to fewer tables.');
    return { text: choice?.message?.content ?? '', model: `${body.model ?? model} (${label})` };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new vscode.CancellationError();
    if ((e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') throw new Error(`Could not reach ${baseUrl}. Is the server running?`);
    throw e;
  } finally {
    sub.dispose();
  }
}

// ---------------------------------------------------------------------------

async function runVscodeLm(user: string, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
  const wanted = cfg().get<string>('vscodeModel')?.trim();
  let models = wanted ? await vscode.lm.selectChatModels({ id: wanted }) : [];
  if (!models.length && wanted) models = await vscode.lm.selectChatModels({ family: wanted });
  const foundSavedModel = models.length > 0;
  if (!foundSavedModel) models = await vscode.lm.selectChatModels();
  if (!models.length)
    throw new Error(
      'No VS Code language model is available. Sign in to GitHub Copilot (or install another model provider), or switch the DB Designer AI provider to Anthropic or Ollama.',
    );
  let model = models[0];
  if (!foundSavedModel) {
    const pick = models.length === 1 && !wanted ? model : await pickVscodeModel(models, wanted);
    if (!pick) throw new vscode.CancellationError();
    model = pick;
    await cfg().update('vscodeModel', model.id, settingsTarget('vscodeModel'));
  }
  // The VS Code LM API has no system role: send the instructions as the first user message.
  const resp = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT), vscode.LanguageModelChatMessage.User(user)],
    { justification: 'DB Designer sends the diagram schema (table and column definitions, no data) for a normalisation review.' },
    token,
  );
  let text = '';
  for await (const chunk of resp.text) text += chunk;
  return { text, model: `${model.name} (${model.vendor})` };
}

async function runAnthropic(
  user: string,
  secrets: vscode.SecretStorage,
  token: vscode.CancellationToken,
): Promise<{ text: string; model: string }> {
  let apiKey = await getAnthropicKey(secrets);
  if (!apiKey) {
    apiKey = await setAnthropicKey(secrets);
    if (!apiKey) throw new vscode.CancellationError();
  }
  const model = cfg().get<string>('anthropicModel')?.trim() || 'claude-opus-5-5';
  const client = new Anthropic({ apiKey });
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    const useFallbacks = FALLBACK_MODELS.has(model);
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'high', format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown> } },
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: abort.signal },
    );
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('The model declined to review this schema.');
    if (msg.stop_reason === 'max_tokens') throw new Error('The review was cut off (max_tokens). Try narrowing it to fewer tables.');
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, model: msg.model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Run "DB Designer: AI: Set API Key…".');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached. Try again in a moment.');
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Model "${model}" was not found. Check the dbDesigner.ai.anthropicModel setting.`);
    if (e instanceof Anthropic.APIUserAbortError) throw new vscode.CancellationError();
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  } finally {
    sub.dispose();
  }
}

async function runOllama(user: string, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
  const base = ollamaUrl();
  let model = cfg().get<string>('ollamaModel')?.trim();
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    if (!model) {
      const models = await listOllamaModels(base, abort.signal);
      model = (await modelPicker('Ollama', models))?.model.id;
      if (!model) throw new vscode.CancellationError();
      await cfg().update('ollamaModel', model, settingsTarget('ollamaUrl', 'ollamaModel'));
    }
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: REVIEW_JSON_SCHEMA,
        options: { temperature: 0.2, num_ctx: 32768 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return { text: body.message?.content ?? '', model: `${model} (Ollama)` };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new vscode.CancellationError();
    if ((e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED')
      throw new Error(`Could not reach Ollama at ${base}. Is "ollama serve" running?`);
    throw e;
  } finally {
    sub.dispose();
  }
}

export async function runReview(
  req: ReviewRequest,
  secrets: vscode.SecretStorage,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<AiReview> {
  const provider = currentProvider();
  const user = buildUserPrompt(req);
  output.appendLine(`[ai] ${providerLabel(provider)}: reviewing ${req.tableIds?.length ? `${req.tableIds.length} selected table(s)` : 'schema'} (${user.length} chars)`);
  const { text, model } =
    provider === 'anthropic'
      ? await runAnthropic(user, secrets, token)
      : provider === 'openai'
        ? await runOpenAi(user, secrets, token)
      : provider === 'ollama'
        ? await runOllama(user, token)
        : await runVscodeLm(user, token);
  try {
    const review = toReview(extractJson(text), model);
    output.appendLine(`[ai] ${model}: ${review.suggestions.length} suggestion(s)`);
    return review;
  } catch (e) {
    output.appendLine(`[ai] could not parse reply from ${model}:\n${text.slice(0, 4000)}`);
    throw new Error(`${(e as Error).message} (the raw reply is in the "DB Designer" output channel)`);
  }
}
