import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { resolveModel, WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { Conversation, Dot } from '../src/shared/types.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture(overrides: Partial<PlatformConfig> = {}) {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    ...overrides,
  };
  const platform = new Platform(store, ws, config);
  const runnerConfig = { mode: 'live' as const, baseUrl: config.baseUrl };
  return {
    ws,
    platform,
    config,
    app: createApp({
      store,
      runner: new Runner(store, runnerConfig),
      config: runnerConfig,
      platform,
    }),
  };
}
const json = (body: unknown, method = 'PUT') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
/** A local endpoint with models enabled; the store decides their order. */
function ollama(ws: WorkspaceStore, models = ['qwen2.5:7b', 'llama3.2']) {
  const connection = ws.models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  ws.models.setModels(connection.id, models);
  return connection;
}
const dotBody = (dot: Dot, model?: string | null) => ({
  name: dot.name,
  instructions: dot.instructions,
  researchAllowed: dot.researchAllowed,
  memoryAllowed: dot.memoryAllowed,
  ...(model === undefined ? {} : { model }),
});

it('resolves the override, then the Dot, then what is connected, then the environment', () => {
  const { ws, config } = fixture({
    model: 'gpt-4o-mini',
    apiKey: 'env-key',
    baseUrl: 'https://env.invalid/v1',
  });
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Test');
  const resolved = () => resolveModel(ws, config, dot.id, 'thread');

  // Bottom rung: nothing is connected, so the legacy environment answers.
  expect(resolved()).toMatchObject({
    model: 'gpt-4o-mini',
    baseUrl: 'https://env.invalid/v1',
    apiKey: 'env-key',
    source: 'environment',
  });
  expect(resolved()?.specId).toBeUndefined();

  // A connection with an enabled model outranks the environment, and a
  // keyless local endpoint carries no credential.
  const local = ollama(ws, ['qwen2.5:7b']);
  expect(resolved()).toMatchObject({
    model: 'qwen2.5:7b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    source: 'enabled',
    specId: `${local.id}:qwen2.5:7b`,
  });
  expect(resolved()?.apiKey).toBeUndefined();

  // The Dot's own default outranks "whatever is connected".
  ws.models.setModels(local.id, ['qwen2.5:7b', 'llama3.2']);
  ws.updateDot(dot.id, { ...dot, model: `${local.id}:llama3.2` });
  expect(resolved()).toMatchObject({ model: 'llama3.2', source: 'dot' });

  // The conversation's override outranks everything. A model name with a
  // colon in it still round-trips through the spec id.
  ws.setConversationModel('thread', `${local.id}:qwen2.5:7b`);
  expect(resolved()).toMatchObject({
    model: 'qwen2.5:7b',
    source: 'conversation',
  });

  // Another conversation on the same Dot is unaffected by that override.
  ws.bindThread('other', dot.id, 'Other');
  expect(resolveModel(ws, config, dot.id, 'other')).toMatchObject({
    model: 'llama3.2',
    source: 'dot',
  });
});

it('falls through a spec id that no longer resolves instead of failing', () => {
  const { ws, config } = fixture({ model: 'gpt-4o-mini', apiKey: 'env-key' });
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Test');
  const local = ollama(ws);
  ws.updateDot(dot.id, { ...dot, model: `${local.id}:llama3.2` });
  ws.setConversationModel('thread', `${local.id}:qwen2.5:7b`);
  const resolved = () => resolveModel(ws, config, dot.id, 'thread');
  expect(resolved()).toMatchObject({ source: 'conversation' });

  // Unticking the overridden model drops to the Dot's default; the stale
  // override stays stored, so re-enabling the model restores it.
  ws.models.setModels(local.id, ['llama3.2']);
  expect(resolved()).toMatchObject({ model: 'llama3.2', source: 'dot' });
  expect(ws.conversations()[0].model).toBe(`${local.id}:qwen2.5:7b`);

  // Deleting the connection strands both spec ids, so the environment wins.
  ws.models.remove(local.id);
  expect(resolved()).toMatchObject({
    model: 'gpt-4o-mini',
    source: 'environment',
  });

  // With no rung left at all, nothing resolves: callers report setup
  // required rather than calling a nonexistent endpoint.
  expect(resolveModel(ws, {}, dot.id, 'thread')).toBeUndefined();
  expect(resolveModel(ws, { model: 'gpt-4o-mini' }, dot.id)).toBeUndefined();
});

it('prefers a model that can answer over whichever connection is oldest', () => {
  const { ws, config } = fixture();
  const dot = ws.dots()[0];
  // An older connection that failed its last probe, still with a model
  // ticked, and a newer one that works.
  const stale = ollama(ws, ['llama3.2']);
  ws.models.setError(stale.id, 'Could not reach it.');
  const live = ws.models.add({
    providerId: 'ollama',
    label: 'Live',
    baseUrl: 'http://127.0.0.1:11435/v1',
  });
  ws.models.setModels(live.id, ['qwen2.5:7b']);

  expect(resolveModel(ws, config, dot.id)).toMatchObject({
    specId: `${live.id}:qwen2.5:7b`,
    source: 'enabled',
  });

  // With nothing healthy left, an unproved connection still beats none.
  ws.models.remove(live.id);
  expect(resolveModel(ws, config, dot.id)).toMatchObject({
    specId: `${stale.id}:llama3.2`,
  });
});

it('carries the request shape and the capabilities the caller has to respect', () => {
  const { ws, config } = fixture();
  const dot = ws.dots()[0];
  const local = ws.models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  // Gemma has no function-calling slot, whatever a gateway lists.
  ws.models.setModels(local.id, ['gemma3:4b']);
  expect(resolveModel(ws, config, dot.id)).toMatchObject({
    model: 'gemma3:4b',
    tokenField: 'max_tokens',
    tools: false,
    vision: true,
    maxOutput: 8192,
  });
});

it('sets and clears a conversation override over the routes', async () => {
  const { ws, app } = fixture();
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Test');
  const local = ollama(ws);

  const dotSaved = await app.request(
    `http://localhost/api/dots/${dot.id}`,
    json(dotBody(dot, `${local.id}:llama3.2`)),
  );
  expect(dotSaved.status).toBe(200);
  expect(((await dotSaved.json()) as Dot).model).toBe(`${local.id}:llama3.2`);

  const set = await app.request(
    'http://localhost/api/conversations/thread/model',
    json({ model: `${local.id}:qwen2.5:7b` }),
  );
  expect(set.status).toBe(200);
  expect(((await set.json()) as Conversation).model).toBe(
    `${local.id}:qwen2.5:7b`,
  );
  const chosen = await (
    await app.request('http://localhost/api/conversations/thread/model')
  ).json();
  expect(chosen).toMatchObject({
    override: `${local.id}:qwen2.5:7b`,
    dotDefault: `${local.id}:llama3.2`,
    resolved: { model: 'qwen2.5:7b', source: 'conversation' },
  });

  // Clearing with null returns the conversation to the Dot's default.
  const cleared = await app.request(
    'http://localhost/api/conversations/thread/model',
    json({ model: null }),
  );
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as Conversation).model).toBeNull();
  expect(
    await (
      await app.request('http://localhost/api/conversations/thread/model')
    ).json(),
  ).toMatchObject({
    override: null,
    resolved: { model: 'llama3.2', source: 'dot' },
  });
});

it('rejects a model id that does not resolve, and never returns a key', async () => {
  const { ws, app } = fixture({ apiKey: 'env-key', model: 'gpt-4o-mini' });
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Test');
  const local = ws.models.add({
    providerId: 'openai',
    label: 'Cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret-key',
  });

  // Enabled on no connection: a known connection with an unticked model.
  for (const model of [
    `${local.id}:gpt-4o`,
    'missing-connection:gpt-4o',
    'nonsense',
  ]) {
    expect(
      (
        await app.request(
          'http://localhost/api/conversations/thread/model',
          json({ model }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `http://localhost/api/dots/${dot.id}`,
          json(dotBody(dot, model)),
        )
      ).status,
    ).toBe(400);
  }
  expect(ws.conversations()[0].model ?? null).toBeNull();
  expect(ws.dot(dot.id)?.model ?? null).toBeNull();

  // The reported resolution never carries the stored credential.
  ws.models.setModels(local.id, ['gpt-4o']);
  const body = (await (
    await app.request('http://localhost/api/conversations/thread/model')
  ).json()) as { resolved: Record<string, unknown> };
  expect(body.resolved).toEqual({
    specId: `${local.id}:gpt-4o`,
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    source: 'enabled',
  });
  expect(JSON.stringify(body)).not.toContain('secret-key');
});
