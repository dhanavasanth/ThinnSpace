import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ConnectionTestError, ModelStore } from '../src/server/model-store.js';
import {
  ANTHROPIC_VERSION,
  APP_IDENTITY,
  looksLikeChatModel,
  requestHeaders,
  sortModelNames,
} from '../src/shared/providers.js';
import {
  MODEL_FALLBACK,
  modelDefaults,
  normalizeModelName,
} from '../src/shared/models.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

type Call = { url: string; headers: Record<string, string>; body: unknown };

/**
 * A store over an in-memory database with fetch injected, so the request
 * shape and the failure classification can be exercised without a network.
 */
function fixture(responder: (call: Call, index: number) => Response) {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { models: new ModelStore(db, fetchImpl), calls };
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const completion = (content: string) =>
  reply({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  });

it('builds the headers each provider actually needs', () => {
  expect(requestHeaders({ providerId: 'openai', apiKey: 'sk-test' })).toEqual({
    Authorization: 'Bearer sk-test',
  });
  expect(requestHeaders({ providerId: 'groq', apiKey: 'gsk' })).toEqual({
    Authorization: 'Bearer gsk',
  });
  expect(requestHeaders({ providerId: 'together', apiKey: 't' })).toEqual({
    Authorization: 'Bearer t',
  });
  expect(requestHeaders({ providerId: 'gemini', apiKey: 'g' })).toEqual({
    Authorization: 'Bearer g',
  });
  // Local servers take no credential, so one typed anyway is not sent.
  expect(requestHeaders({ providerId: 'ollama', apiKey: 'leaked' })).toEqual(
    {},
  );
  expect(requestHeaders({ providerId: 'lmstudio' })).toEqual({});
  // OpenRouter attributes traffic to the app, with a stable identity.
  expect(requestHeaders({ providerId: 'openrouter', apiKey: 'or' })).toEqual({
    Authorization: 'Bearer or',
    'HTTP-Referer': APP_IDENTITY.url,
    'X-Title': APP_IDENTITY.title,
  });
  // Anthropic wants its API version, until it says otherwise.
  expect(requestHeaders({ providerId: 'anthropic', apiKey: 'ak' })).toEqual({
    Authorization: 'Bearer ak',
    'anthropic-version': ANTHROPIC_VERSION,
  });
  expect(
    requestHeaders({ providerId: 'anthropic', apiKey: 'ak', mode: 'minimal' }),
  ).toEqual({ Authorization: 'Bearer ak' });
  // A self-hosted endpoint behind no auth gets no Authorization header.
  expect(requestHeaders({ providerId: 'custom' })).toEqual({});
  expect(
    requestHeaders({ providerId: 'custom', apiKey: 'x', json: true }),
  ).toEqual({ Authorization: 'Bearer x', 'Content-Type': 'application/json' });
});

it('discovery filters embedding models, sorts, and keeps what the owner enabled', async () => {
  const { models, calls } = fixture(() =>
    reply({
      object: 'list',
      data: [
        { id: 'qwen2.5:7b' },
        { id: 'nomic-embed-text:latest' },
        { id: 'llama3.2:3b' },
      ],
    }),
  );
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  // The owner already picked a model the endpoint is about to stop offering.
  models.setModels(connection.id, ['qwen2.5:7b', 'mistral:7b']);

  const found = await models.discoverDetailed(connection.id);
  expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/models');
  expect(calls[0].headers.Authorization).toBeUndefined();
  expect(found.models).toEqual(['llama3.2:3b', 'mistral:7b', 'qwen2.5:7b']);
  expect(found.missing).toEqual(['mistral:7b']);
  // The raw list keeps the embedding model, so the UI can show everything.
  expect(found.all).toContain('nomic-embed-text:latest');
  expect(looksLikeChatModel('nomic-embed-text:latest')).toBe(false);

  const stored = models.get(connection.id);
  expect(stored?.models).toEqual(['mistral:7b', 'qwen2.5:7b']);
  expect(stored?.missingModels).toEqual(['mistral:7b']);
  expect(stored?.allModels).toContain('nomic-embed-text:latest');
  expect(stored?.error).toBeNull();
  // `discover` keeps its old shape for the route that already calls it.
  expect(await models.discover(connection.id)).toEqual(found.models);
});

it('sorts model names the way a person reads them', () => {
  expect(sortModelNames(['qwen2.5:14b', 'qwen2.5:7b', 'llama3.2:3b'])).toEqual([
    'llama3.2:3b',
    'qwen2.5:7b',
    'qwen2.5:14b',
  ]);
});

it('matches capabilities through provider prefixes and tags', () => {
  expect(normalizeModelName('openai/gpt-4o')).toBe('gpt-4o');
  expect(normalizeModelName('qwen2.5:7b')).toBe('qwen2.5-7b');

  // An Ollama tag is still the family it came from.
  const qwen = modelDefaults('qwen2.5:7b');
  expect(qwen.known).toBe(true);
  expect(qwen.contextWindow).toBe(32_768);
  expect(qwen.tools).toBe(true);
  expect(qwen.vision).toBe(false);

  // A gateway prefix is not part of the model's name.
  const gpt = modelDefaults('openai/gpt-4o');
  expect(gpt.known).toBe(true);
  expect(gpt.contextWindow).toBe(128_000);
  expect(gpt.vision).toBe(true);
  expect(modelDefaults('openai/gpt-4o-2024-11-20').contextWindow).toBe(128_000);
  expect(
    modelDefaults('meta-llama/Llama-3.3-70B-Instruct-Turbo').contextWindow,
  ).toBe(128_000);

  // Gemma has no function-calling slot, whatever a gateway lists.
  expect(modelDefaults('gemma3:4b').tools).toBe(false);
  expect(modelDefaults('deepseek-r1:8b').tools).toBe(false);

  // Anything unrecognised still works, conservatively and honestly.
  const unknown = modelDefaults('acme-megabrain-v9');
  expect(unknown.known).toBe(false);
  expect(unknown.contextWindow).toBe(MODEL_FALLBACK.contextWindow);
  expect(unknown.maxOutput).toBe(MODEL_FALLBACK.maxOutput);
});

it('resolves a spec id to its connection and refuses a model that is not enabled', () => {
  const { models } = fixture(() => reply({}));
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1/',
  });
  models.setModels(connection.id, ['qwen2.5:7b']);

  const specs = models.specs();
  expect(specs).toHaveLength(1);
  expect(specs[0].id).toBe(`${connection.id}:qwen2.5:7b`);
  expect(specs[0].known).toBe(true);
  expect(specs[0].baseUrl).toBe('http://127.0.0.1:11434/v1');

  const resolved = models.resolve(specs[0].id);
  expect(resolved?.model).toBe('qwen2.5:7b');
  expect(resolved?.providerId).toBe('ollama');
  expect(resolved?.baseUrl).toBe('http://127.0.0.1:11434/v1');
  expect(resolved?.apiKey).toBeUndefined();
  expect(resolved?.headers).toEqual({ 'Content-Type': 'application/json' });

  // A model nobody enabled is not callable, even on a real connection.
  expect(models.resolve(`${connection.id}:gpt-4o`)).toBeUndefined();
  expect(models.resolve('no-such-connection:qwen2.5:7b')).toBeUndefined();
});

it('reports a working connection with the reply and the token usage', async () => {
  const { models, calls } = fixture(() => completion('ready'));
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  models.setModels(connection.id, ['qwen2.5:7b']);

  const result = await models.test(connection.id);
  expect(result.ok).toBe(true);
  expect(result.model).toBe('qwen2.5:7b');
  expect(result.reply).toBe('ready');
  expect(result.usage?.totalTokens).toBe(14);
  expect(typeof result.latencyMs).toBe('number');
  expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  expect(calls[0].headers['Content-Type']).toBe('application/json');
  expect((calls[0].body as { model: string }).model).toBe('qwen2.5:7b');
  // The outcome is on the connection, so the UI need not probe again.
  expect(models.get(connection.id)?.lastTest?.ok).toBe(true);
  expect(models.get(connection.id)?.error).toBeNull();
});

it('names what went wrong rather than reporting one failure for everything', async () => {
  const cases: {
    response: Response | 'throw';
    kind: string;
    matches: RegExp;
    /**
     * Whether the verdict is about the endpoint, and so belongs in the
     * connection's own `error` — which the composer turns into an
     * "Offline" badge on every one of that connection's models. A verdict
     * about the model that was asked must not brand its siblings.
     */
    banner: boolean;
  }[] = [
    {
      response: reply({ error: { message: 'Invalid API key' } }, 401),
      kind: 'refused',
      matches: /refused that key/i,
      banner: true,
    },
    {
      response: reply({ error: { message: 'model not found' } }, 404),
      kind: 'missing-model',
      matches: /no model called/i,
      banner: false,
    },
    {
      response: reply({ choices: [] }),
      kind: 'malformed',
      matches: /without a message/i,
      banner: false,
    },
    {
      response: 'throw',
      kind: 'unreachable',
      matches: /could not reach/i,
      banner: true,
    },
  ];
  for (const scenario of cases) {
    const { models } = fixture(() => {
      if (scenario.response === 'throw') throw new TypeError('fetch failed');
      return scenario.response;
    });
    const connection = models.add({
      providerId: 'ollama',
      label: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    models.setModels(connection.id, ['qwen2.5:7b']);
    await expect(models.test(connection.id)).rejects.toThrow(scenario.matches);
    const stored = models.get(connection.id);
    expect(stored?.lastTest?.ok).toBe(false);
    expect(stored?.lastTest?.kind).toBe(scenario.kind);
    expect(stored?.lastTest?.error).toMatch(scenario.matches);
    if (scenario.banner) expect(stored?.error).toMatch(scenario.matches);
    else expect(stored?.error).toBeNull();
  }
});

it('keeps a provider’s own words, and its echo of the key, out of what it stores', async () => {
  // A dev proxy or an upstream-error passthrough echoing the request it
  // received is ordinary behaviour, and the body it echoes carries the
  // Authorization header.
  const { models } = fixture(() =>
    reply(
      {
        error: {
          message:
            'upstream rejected request: headers={"authorization":"Bearer sk-live-REAL-KEY"}',
        },
      },
      502,
    ),
  );
  const connection = models.add({
    providerId: 'openai',
    label: 'Cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-live-REAL-KEY',
  });
  models.setModels(connection.id, ['gpt-4o']);

  await expect(models.test(connection.id)).rejects.toThrow(/502/);
  const stored = models.get(connection.id);
  expect(stored?.lastTest?.error).toContain('[key redacted]');
  expect(JSON.stringify(stored)).not.toContain('sk-live-REAL-KEY');
});

it('reads a 404 for what the body says it is', async () => {
  // A base URL saved without its /v1 is the common setup mistake, and
  // this is the body Ollama answers it with.
  const { models } = fixture(
    () => new Response('404 page not found', { status: 404 }),
  );
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434',
  });
  models.setModels(connection.id, ['qwen2.5:7b']);
  await expect(models.test(connection.id)).rejects.toThrow(/\/v1 suffix/);
  expect(models.get(connection.id)?.lastTest?.kind).toBe('error');
});

it('refuses an address no request could be built from', () => {
  const { models } = fixture(() => reply({}));
  for (const baseUrl of [
    'file:///etc/passwd',
    'not a url at all',
    'http://host/v1?key=1',
  ])
    expect(() =>
      models.add({ providerId: 'custom', label: 'Custom', baseUrl }),
    ).toThrow(/http or https/);
  expect(models.list()).toHaveLength(0);
});

it('does not clear a reachability failure because a checkbox was ticked', async () => {
  const { models } = fixture(() => {
    throw new TypeError('fetch failed');
  });
  const connection = models.add({
    providerId: 'custom',
    label: 'Custom',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  await expect(models.discoverDetailed(connection.id)).rejects.toThrow();
  expect(models.get(connection.id)?.error).toMatch(/could not reach/i);
  // Enabling a model is not evidence the endpoint came back.
  models.setModels(connection.id, ['gpt-4o']);
  expect(models.get(connection.id)?.error).toMatch(/could not reach/i);
});

it('sends the output cap under the field the test proved', async () => {
  const { models, calls } = fixture((call, index) => {
    if (index === 0) {
      expect((call.body as Record<string, unknown>).max_tokens).toBe(32);
      return reply(
        {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported.",
          },
        },
        400,
      );
    }
    return completion('ready');
  });
  const connection = models.add({
    providerId: 'openai',
    label: 'Cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
  });
  models.setModels(connection.id, ['gpt-5']);

  expect((await models.test(connection.id)).ok).toBe(true);
  expect(calls).toHaveLength(2);
  expect((calls[1].body as Record<string, unknown>).max_completion_tokens).toBe(
    32,
  );
  // OpenAI declares no negotiable headers, so nothing was learned about
  // them and the real chat path keeps the full set.
  const resolved = models.resolve(`${connection.id}:gpt-5`);
  expect(resolved?.tokenField).toBe('max_completion_tokens');
  expect(models.get(connection.id)?.headerMode).toBe('default');
});

it('flags every enabled model when an endpoint has stopped offering any', async () => {
  const { models } = fixture(() => reply({ object: 'list', data: [] }));
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  models.setModels(connection.id, ['qwen2.5:7b']);
  // Before any probe nothing is known, so nothing is missing.
  expect(models.get(connection.id)?.missingModels).toEqual([]);

  const found = await models.discoverDetailed(connection.id);
  expect(found.missing).toEqual(['qwen2.5:7b']);
  expect(models.get(connection.id)?.missingModels).toEqual(['qwen2.5:7b']);
  expect(models.specs()[0].missing).toBe(true);
});

it('reads a catalog listed as bare strings', async () => {
  const { models } = fixture(() =>
    reply({ models: ['qwen2.5:7b', 'llama3.2'] }),
  );
  const connection = models.add({
    providerId: 'custom',
    label: 'Shim',
    baseUrl: 'http://127.0.0.1:8080/v1',
  });
  expect((await models.discoverDetailed(connection.id)).models).toEqual([
    'llama3.2',
    'qwen2.5:7b',
  ]);
});

it('refuses a provider body too large to hold in memory', async () => {
  const huge = JSON.stringify({
    data: Array.from({ length: 60_000 }, (_, index) => ({
      id: `model-${index}-${'x'.repeat(40)}`,
    })),
  });
  const { models } = fixture(
    () =>
      new Response(huge, { headers: { 'Content-Type': 'application/json' } }),
  );
  const connection = models.add({
    providerId: 'custom',
    label: 'Firehose',
    baseUrl: 'http://127.0.0.1:8080/v1',
  });
  await expect(models.discoverDetailed(connection.id)).rejects.toThrow(
    /more data/i,
  );
  expect(models.get(connection.id)?.allModels).toEqual([]);
});

it('asks for a model before pretending to test one', async () => {
  const { models, calls } = fixture(() => completion('ready'));
  const connection = models.add({
    providerId: 'ollama',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  await expect(models.test(connection.id)).rejects.toBeInstanceOf(
    ConnectionTestError,
  );
  expect(calls).toHaveLength(0);
  // An explicit model needs no enabled list, which is what discovery uses.
  expect((await models.test(connection.id, 'llama3.2:3b')).model).toBe(
    'llama3.2:3b',
  );
});

it('retries Anthropic without the version header when it objects to one', async () => {
  const { models, calls } = fixture((call, index) => {
    if (index === 0) {
      expect(call.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
      return reply(
        {
          error: { message: 'anthropic-version header is not supported here' },
        },
        400,
      );
    }
    expect(call.headers['anthropic-version']).toBeUndefined();
    return completion('ready');
  });
  const connection = models.add({
    providerId: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
  });
  models.setModels(connection.id, ['claude-sonnet-4']);

  const result = await models.test(connection.id);
  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(2);
  // What worked is remembered, so the next call starts there.
  expect(models.get(connection.id)?.headerMode).toBe('minimal');
  expect(models.get(connection.id)?.hasKey).toBe(true);
});
