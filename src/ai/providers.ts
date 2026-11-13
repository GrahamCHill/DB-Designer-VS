import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { AiReview, REVIEW_JSON_SCHEMA, ReviewRequest, SYSTEM_PROMPT, buildUserPrompt, extractJson, toReview } from '../shared/ai';

export type AiProvider = 'vscode' | 'anthropic' | 'ollama';

const ANTHROPIC_KEY = 'erdViewer.anthropicApiKey';
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

function cfg() {
  return vscode.workspace.getConfiguration('erdViewer.ai');
}

export function providerLabel(p: AiProvider): string {
  return { vscode: 'VS Code language model (e.g. Copilot)', anthropic: 'Anthropic Claude API', ollama: 'Ollama (local)' }[p];
}

export function currentProvider(): AiProvider {
  return (cfg().get<string>('provider') as AiProvider) || 'vscode';
}

export async function chooseProvider(): Promise<AiProvider | undefined> {
  const items = (['vscode', 'anthropic', 'ollama'] as AiProvider[]).map((p) => ({
    label: providerLabel(p),
    description: p === currentProvider() ? 'current' : undefined,
    detail: {
      vscode: 'Uses a chat model already available in VS Code (GitHub Copilot or another installed provider). No API key needed.',
      anthropic: 'Calls Claude directly with your Anthropic API key (stored in VS Code Secret Storage).',
      ollama: 'Runs against a local Ollama server, so the schema never leaves your machine.',
    }[p],
    p,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'AI provider for normalisation reviews' });
  if (!pick) return undefined;
  await cfg().update('provider', pick.p, vscode.ConfigurationTarget.Global);
  return pick.p;
}

export async function setAnthropicKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: 'Anthropic API key',
    prompt: 'Stored in VS Code Secret Storage. Create one at console.anthropic.com.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().startsWith('sk-ant-') ? undefined : 'Expected a key starting with sk-ant-'),
  });
  if (!key) return false;
  await secrets.store(ANTHROPIC_KEY, key.trim());
  vscode.window.showInformationMessage('Anthropic API key saved.');
  return true;
}

export async function clearAnthropicKey(secrets: vscode.SecretStorage) {
  await secrets.delete(ANTHROPIC_KEY);
  vscode.window.showInformationMessage('Anthropic API key removed.');
}

// ---------------------------------------------------------------------------

async function runVscodeLm(user: string, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
  const wanted = cfg().get<string>('vscodeModel')?.trim();
  let models = await vscode.lm.selectChatModels(wanted ? { family: wanted } : undefined);
  if (!models.length && wanted) models = await vscode.lm.selectChatModels({ id: wanted });
  if (!models.length && wanted) models = await vscode.lm.selectChatModels();
  if (!models.length)
    throw new Error(
      'No VS Code language model is available. Sign in to GitHub Copilot (or install another model provider), or switch the ERD Viewer AI provider to Anthropic or Ollama.',
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
    { justification: 'ERD Viewer sends the diagram schema (table and column definitions, no data) for a normalisation review.' },
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
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Run "ERD Viewer: Set Anthropic API Key".');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached. Try again in a moment.');
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Model "${model}" was not found. Check the erdViewer.ai.anthropicModel setting.`);
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
      : provider === 'ollama'
        ? await runOllama(user, token)
        : await runVscodeLm(user, token);
  try {
    const review = toReview(extractJson(text), model);
    output.appendLine(`[ai] ${model}: ${review.suggestions.length} suggestion(s)`);
    return review;
  } catch (e) {
    output.appendLine(`[ai] could not parse reply from ${model}:\n${text.slice(0, 4000)}`);
    throw new Error(`${(e as Error).message} (the raw reply is in the "ERD Viewer" output channel)`);
  }
}
