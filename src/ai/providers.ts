import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { AiReview, REVIEW_JSON_SCHEMA, ReviewRequest, SYSTEM_PROMPT, buildUserPrompt, extractJson, toReview } from '../shared/ai';

export type AiProvider = 'vscode' | 'anthropic' | 'openai' | 'ollama';

const ANTHROPIC_KEY = 'dbDesigner.anthropicApiKey';
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/** Ready-made OpenAI-compatible endpoints. */
export const OPENAI_PRESETS = [
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', env: 'GROQ_API_KEY', keyUrl: 'console.groq.com/keys' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', env: 'OPENAI_API_KEY', keyUrl: 'platform.openai.com/api-keys' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct', env: 'OPENROUTER_API_KEY', keyUrl: 'openrouter.ai/keys' },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '', env: '', keyUrl: '' },
] as const;

function cfg() {
  return vscode.workspace.getConfiguration('dbDesigner.ai');
}

function openaiEndpoint(): { baseUrl: string; model: string; label: string } {
  const baseUrl = (cfg().get<string>('openaiBaseUrl') || OPENAI_PRESETS[0].baseUrl).replace(/\/+$/, '');
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === baseUrl);
  return { baseUrl, model: cfg().get<string>('openaiModel')?.trim() || preset?.model || '', label: preset?.label ?? new URL(baseUrl).host };
}

/** Secret Storage key for an endpoint's API key (one per host). */
function keyName(baseUrl: string): string {
  return `dbDesigner.apiKey:${new URL(baseUrl).origin}`;
}

export function providerLabel(p: AiProvider): string {
  if (p === 'openai') {
    const e = openaiEndpoint();
    return `${e.label} (OpenAI-compatible)${e.model ? ` · ${e.model}` : ''}`;
  }
  return { vscode: 'VS Code language model (e.g. Copilot)', anthropic: 'Anthropic Claude API', ollama: 'Ollama (local)' }[p];
}

export function currentProvider(): AiProvider {
  return (cfg().get<string>('provider') as AiProvider) || 'vscode';
}

export async function chooseProvider(secrets?: vscode.SecretStorage): Promise<AiProvider | undefined> {
  const items = (['vscode', 'anthropic', 'openai', 'ollama'] as AiProvider[]).map((p) => ({
    label: p === 'openai' ? 'Groq / OpenAI-compatible API' : providerLabel(p),
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
  if (pick.p === 'openai' && !(await configureOpenAi(secrets))) return undefined;
  await cfg().update('provider', pick.p, vscode.ConfigurationTarget.Global);
  return pick.p;
}

/** Pick an OpenAI-compatible endpoint and model, and make sure there is a key for it. */
async function configureOpenAi(secrets?: vscode.SecretStorage): Promise<boolean> {
  const current = openaiEndpoint();
  const presetPick = await vscode.window.showQuickPick(
    [
      ...OPENAI_PRESETS.map((x) => ({ label: x.label, description: x.baseUrl, detail: x.model ? `Default model: ${x.model}` : 'Uses the model loaded in LM Studio', preset: x as (typeof OPENAI_PRESETS)[number] | undefined })),
      { label: 'Custom endpoint…', description: 'Any OpenAI-compatible /v1 URL', detail: undefined, preset: undefined },
    ],
    { title: 'OpenAI-compatible endpoint', placeHolder: `Current: ${current.baseUrl}` },
  );
  if (!presetPick) return false;
  let baseUrl: string | undefined = presetPick.preset?.baseUrl;
  if (!baseUrl) {
    baseUrl = await vscode.window.showInputBox({
      title: 'OpenAI-compatible base URL',
      value: current.baseUrl,
      prompt: 'The URL that ends before /chat/completions, e.g. https://api.together.xyz/v1',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
    });
    if (!baseUrl) return false;
  }
  baseUrl = baseUrl.trim().replace(/\/+$/, '');
  const needsKey = !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
  if (needsKey && secrets && !(await secrets.get(keyName(baseUrl))) && !envKey(baseUrl)) {
    if (!(await setApiKeyFor(secrets, baseUrl, presetPick.preset?.label ?? new URL(baseUrl).host, presetPick.preset?.keyUrl))) return false;
  }
  // Model: offer the endpoint's model list when it can be fetched.
  let models: string[] = [];
  try {
    const key = secrets ? await getOpenAiKey(secrets, baseUrl) : undefined;
    const res = await fetch(`${baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (res.ok) models = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id).sort();
  } catch {
    /* model list is optional */
  }
  const preferred = presetPick.preset?.model || cfg().get<string>('openaiModel') || '';
  let model: string | undefined;
  if (models.length) {
    const mp = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m, description: m === preferred ? 'recommended' : undefined })).sort((a, b) => (b.description ? 1 : 0) - (a.description ? 1 : 0)),
      { title: 'Model', placeHolder: 'Choose the model to use for reviews' },
    );
    model = mp?.label;
  } else {
    model = await vscode.window.showInputBox({ title: 'Model name', value: preferred, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Required') });
  }
  if (!model) return false;
  await cfg().update('openaiBaseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await cfg().update('openaiModel', model.trim(), vscode.ConfigurationTarget.Global);
  return true;
}

function envKey(baseUrl: string): string | undefined {
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === baseUrl);
  return preset?.env ? process.env[preset.env] : undefined;
}

async function getOpenAiKey(secrets: vscode.SecretStorage, baseUrl: string): Promise<string | undefined> {
  return (await secrets.get(keyName(baseUrl))) || envKey(baseUrl);
}

async function setApiKeyFor(secrets: vscode.SecretStorage, baseUrl: string, label: string, keyUrl?: string): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: `${label} API key`,
    prompt: `Stored encrypted in VS Code Secret Storage (your OS keychain), never in settings.${keyUrl ? ` Get a key at ${keyUrl}.` : ''}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length >= 8 ? undefined : 'That does not look like an API key'),
  });
  if (!key) return false;
  await secrets.store(keyName(baseUrl), key.trim());
  vscode.window.showInformationMessage(`${label} API key saved (encrypted).`);
  return true;
}

/** "AI: Set API Key…": Anthropic or the configured OpenAI-compatible endpoint. */
export async function setApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const e = openaiEndpoint();
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic', description: 'console.anthropic.com', id: 'anthropic' },
      { label: `${e.label}`, description: e.baseUrl, id: 'openai' },
    ],
    { title: 'Which API key do you want to save (encrypted)?' },
  );
  if (!pick) return false;
  if (pick.id === 'anthropic') return setAnthropicKey(secrets);
  const preset = OPENAI_PRESETS.find((x) => x.baseUrl === e.baseUrl);
  return setApiKeyFor(secrets, e.baseUrl, e.label, preset?.keyUrl);
}

export async function clearApiKeys(secrets: vscode.SecretStorage) {
  const e = openaiEndpoint();
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic', id: 'anthropic' },
      { label: e.label, description: e.baseUrl, id: 'openai' },
    ],
    { title: 'Remove which saved API key?', canPickMany: true },
  );
  if (!pick?.length) return;
  for (const x of pick) await secrets.delete(x.id === 'anthropic' ? ANTHROPIC_KEY : keyName(e.baseUrl));
  vscode.window.showInformationMessage(`Removed ${pick.length} API key(s).`);
}

export async function setAnthropicKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: 'Anthropic API key',
    prompt: 'Stored encrypted in VS Code Secret Storage (your OS keychain). Create one at console.anthropic.com.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().startsWith('sk-ant-') ? undefined : 'Expected a key starting with sk-ant-'),
  });
  if (!key) return false;
  await secrets.store(ANTHROPIC_KEY, key.trim());
  vscode.window.showInformationMessage('Anthropic API key saved (encrypted).');
  return true;
}

export async function clearAnthropicKey(secrets: vscode.SecretStorage) {
  await secrets.delete(ANTHROPIC_KEY);
  vscode.window.showInformationMessage('Anthropic API key removed.');
}

/** OpenAI-compatible chat completions (Groq, OpenAI, OpenRouter, LM Studio, …). */
async function runOpenAi(user: string, secrets: vscode.SecretStorage, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
  let { baseUrl, model, label } = openaiEndpoint();
  if (!model) {
    if (!(await configureOpenAi(secrets))) throw new vscode.CancellationError();
    ({ baseUrl, model, label } = openaiEndpoint());
  }
  let key = await getOpenAiKey(secrets, baseUrl);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
  if (!key && !local) {
    if (!(await setApiKeyFor(secrets, baseUrl, label))) throw new vscode.CancellationError();
    key = await getOpenAiKey(secrets, baseUrl);
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
  let models = await vscode.lm.selectChatModels(wanted ? { family: wanted } : undefined);
  if (!models.length && wanted) models = await vscode.lm.selectChatModels({ id: wanted });
  if (!models.length && wanted) models = await vscode.lm.selectChatModels();
  if (!models.length)
    throw new Error(
      'No VS Code language model is available. Sign in to GitHub Copilot (or install another model provider), or switch the DB Designer AI provider to Anthropic or Ollama.',
    );
  let model = models[0];
  if (!wanted && models.length > 1) {
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: `${m.vendor} · ${m.family}`, m })),
      { title: 'Choose a language model for the normalisation review' },
    );
    if (!pick) throw new vscode.CancellationError();
    model = pick.m;
    await cfg().update('vscodeModel', model.family, vscode.ConfigurationTarget.Global);
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
  let apiKey = (await secrets.get(ANTHROPIC_KEY)) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (!(await setAnthropicKey(secrets))) throw new vscode.CancellationError();
    apiKey = await secrets.get(ANTHROPIC_KEY);
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
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Run "DB Designer: Set Anthropic API Key".');
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
  const base = (cfg().get<string>('ollamaUrl') || 'http://localhost:11434').replace(/\/+$/, '');
  let model = cfg().get<string>('ollamaModel')?.trim();
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  try {
    if (!model) {
      const tags = (await (await fetch(`${base}/api/tags`, { signal: abort.signal })).json()) as { models?: { name: string }[] };
      const names = (tags.models ?? []).map((m) => m.name);
      if (!names.length) throw new Error(`No models found in Ollama at ${base}. Pull one first, e.g. "ollama pull qwen2.5-coder".`);
      const pick = await vscode.window.showQuickPick(names, { title: 'Choose an Ollama model for the normalisation review' });
      if (!pick) throw new vscode.CancellationError();
      model = pick;
      await cfg().update('ollamaModel', model, vscode.ConfigurationTarget.Global);
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
