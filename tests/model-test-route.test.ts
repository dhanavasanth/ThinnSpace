import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type {
  ConnectionTest,
  ModelConnection,
} from '../src/shared/providers.js';

/**
 * The connection test endpoint.
 *
 * `ModelStore.test` is covered directly in model-connections.test.ts; what
 * is checked here is the route's own contract, which the Settings panel
 * depends on: a verdict always arrives as a `ConnectionTest`, whether the
 * connection answered or refused, so one renderer handles both a fresh
 * result and the one remembered on the connection. Statuses are reserved
 * for the test not running at all.
 *
 * No network: the endpoint is stubbed, so this stays green whether or not
 * a local model server happens to be up.
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});

function fixture() {
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
  };
  const platform = new Platform(store, ws, config);
  const runnerConfig = { mode: 'live' as const, baseUrl: config.baseUrl };
  const connection = ws.models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  ws.models.setModels(connection.id, ['qwen2.5:7b']);
  return {
    ws,
    connection,
    app: createApp({
      store,
      runner: new Runner(store, runnerConfig),
      config: runnerConfig,
      platform,
    }),
  };
}

/** A reply in the shape every provider here agrees on. */
const completion = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 36, completion_tokens: 2, total_tokens: 38 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const post = (app: ReturnType<typeof fixture>['app'], id: string, body = {}) =>
  app.request(`http://localhost/api/model-connections/${id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const lastTest = async (
  app: ReturnType<typeof fixture>['app'],
  id: string,
): Promise<ConnectionTest | null> => {
  const body = (await (
    await app.request('http://localhost/api/model-connections')
  ).json()) as { connections: ModelConnection[] };
  return body.connections.find((item) => item.id === id)?.lastTest ?? null;
};

it('reports a completion, and remembers it on the connection', async () => {
  const { app, connection } = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => completion('Ready')),
  );

  const response = await post(app, connection.id);
  expect(response.status).toBe(200);
  const result = (await response.json()) as ConnectionTest;
  expect(result).toMatchObject({
    ok: true,
    model: 'qwen2.5:7b',
    reply: 'Ready',
    usage: { totalTokens: 38 },
  });
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);

  // The panel reads this back when it is reopened, so it has to match.
  expect(await lastTest(app, connection.id)).toMatchObject({
    ok: true,
    reply: 'Ready',
  });
});

it('tests the model that was named rather than the first enabled one', async () => {
  const { app, ws, connection } = fixture();
  ws.models.setModels(connection.id, ['llama3.2', 'qwen2.5:7b']);
  const sent: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return completion('Ready');
    }),
  );

  const result = (await (
    await post(app, connection.id, { model: 'qwen2.5:7b' })
  ).json()) as ConnectionTest;
  expect(result.model).toBe('qwen2.5:7b');
  // A model name carrying a colon has to survive the round trip intact.
  expect(sent[0]).toMatchObject({ model: 'qwen2.5:7b' });
});

it('answers a refusal as a verdict, not an error status', async () => {
  const { app, connection } = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Bad key.' } }), {
          status: 401,
        }),
    ),
  );

  const response = await post(app, connection.id);
  // 200: the test ran and reached a conclusion. The conclusion is a failure.
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: false,
    kind: 'refused',
    model: 'qwen2.5:7b',
  });
  expect(await lastTest(app, connection.id)).toMatchObject({
    ok: false,
    kind: 'refused',
  });
});

it('says a dead endpoint is unreachable', async () => {
  const { app, connection } = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('fetch failed');
    }),
  );

  const result = (await (await post(app, connection.id)).json()) as {
    ok: boolean;
    kind: string;
    error: string;
  };
  expect(result).toMatchObject({ ok: false, kind: 'unreachable' });
  expect(result.error).toContain('http://127.0.0.1:11434/v1');
});

it('never resurfaces an older result when there is nothing to test', async () => {
  const { app, ws, connection } = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => completion('Ready')),
  );
  expect(
    ((await (await post(app, connection.id)).json()) as ConnectionTest).ok,
  ).toBe(true);

  // Untick everything: the connection still carries that green result, but
  // there is no longer a model to test, and reporting the old pass here
  // would be a tick for something that is no longer selected.
  ws.models.setModels(connection.id, []);
  const result = (await (await post(app, connection.id)).json()) as {
    ok: boolean;
    model: string;
    error: string;
  };
  expect(result.ok).toBe(false);
  expect(result.model).toBe('');
  expect(result.error).toMatch(/Enable a model/);
});

it('separates a connection that is gone from a body it cannot read', async () => {
  const { app, connection } = fixture();
  expect((await post(app, 'no-such-connection')).status).toBe(404);
  expect(
    (await post(app, connection.id, { model: 123, junk: true })).status,
  ).toBe(400);
});
