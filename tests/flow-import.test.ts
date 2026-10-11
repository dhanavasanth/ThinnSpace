/**
 * Making triggers usable: the trigger-info endpoint behind the Start panel,
 * webhook token rotation, and importing an exported flow into a workspace
 * that does not have the Dots and Spaces it was drawn against.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { FlowTriggerInfo } from '../src/shared/flow-runs.js';
import { makeNode, type Flow, type FlowGraph } from '../src/shared/flows.js';

// The client module reads sessionStorage when it loads; the import helpers
// under test never call the API themselves.
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {},
}));
const { parseFlowFile, relinkGraph, countdown } =
  await import('../src/client/flows/FlowVersions');

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function fixture(options: { ownerToken?: string; origin?: string } = {}) {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  cleanup.push(() => platform.runner.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ...options,
  });
  /** Every /api request but the hook needs the owner token when there is one. */
  const owned = (init: RequestInit = {}) =>
    options.ownerToken
      ? {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            Authorization: `Bearer ${options.ownerToken}`,
          },
        }
      : init;
  const createFlow = async (graph: FlowGraph, name = 'Hooked flow') => {
    const response = await app.request(
      'http://localhost/api/flows',
      owned(json({ name, graph })),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as Flow;
  };
  /** `secrets` is what the Start panel asks for; other readers do not. */
  const triggerInfo = async (flowId: string, secrets = false) => {
    const response = await app.request(
      `http://localhost/api/flows/${flowId}/trigger-info${secrets ? '?secrets=1' : ''}`,
      owned(),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as FlowTriggerInfo;
  };
  /** What the Start panel does when a webhook has no token yet. */
  const mintToken = async (flowId: string) => {
    const response = await app.request(
      `http://localhost/api/flows/${flowId}/webhook-token`,
      owned({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  const publish = async (flow: Flow) => {
    const response = await app.request(
      `http://localhost/api/flows/${flow.id}/publish`,
      owned(json({ revision: flow.revision })),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Flow;
  };
  /** Calls a webhook Start the way an outside caller would. */
  const callHook = (url: string, token?: string) =>
    app.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Flow-Token': token } : {}),
      },
      body: JSON.stringify({ input: 'ping' }),
    });
  return {
    ws,
    app,
    owned,
    platform,
    createFlow,
    triggerInfo,
    mintToken,
    publish,
    callHook,
  };
}

/** start(webhook) -> finish: the smallest graph that publishes cleanly. */
function webhookGraph(auth: 'token' | 'none' = 'token') {
  const start = makeNode(
    'start',
    { x: 0, y: 0 },
    { trigger: 'webhook', webhookAuth: auth },
  );
  const finish = makeNode('finish', { x: 320, y: 0 }, {});
  const graph: FlowGraph = {
    schema: 1,
    nodes: [start, finish],
    edges: [
      {
        id: 'e1',
        source: start.id,
        sourceHandle: 'started',
        target: finish.id,
        targetHandle: 'value',
      },
    ],
  };
  return { graph, startId: start.id };
}

it('describes a webhook Start and refuses calls until the flow is published', async () => {
  const f = fixture();
  const { graph, startId } = webhookGraph();
  const flow = await f.createFlow(graph);

  const draft = await f.triggerInfo(flow.id);
  expect(draft.published).toBe(false);
  // A plain read hands out no secret and mints nothing: the Flows list
  // reads this route for every flow, and only the Start panel wants a token.
  expect(draft.token).toBeNull();
  expect(await f.triggerInfo(flow.id, true).then((info) => info.token)).toBe(
    null,
  );
  expect(draft.tokenHeader).toBe('X-Flow-Token');
  const start = draft.starts.find((item) => item.nodeId === startId)!;
  expect(start.trigger).toBe('webhook');
  expect(start.tokenRequired).toBe(true);
  expect(start.url).toBe(
    `http://localhost/api/flows/${flow.id}/hooks/${startId}`,
  );
  // What the panel does with a webhook that has no token yet.
  const token = await f.mintToken(flow.id);
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect((await f.triggerInfo(flow.id, true)).token).toBe(token);
  // Nothing is callable while the flow is a draft, token or no token.
  expect((await f.callHook(start.url!, token)).status).toBe(404);

  await f.publish(flow);
  const live = await f.triggerInfo(flow.id, true);
  expect(live.published).toBe(true);
  // The token survives publishing, so an example copied earlier still works.
  expect(live.token).toBe(token);
  const accepted = await f.callHook(start.url!, token);
  expect(accepted.status).toBe(202);
  const { runId } = (await accepted.json()) as { runId: string };
  await f.platform.runner.settled(runId);
});

it('reports a schedule Start in words, with its next run once published', async () => {
  const f = fixture();
  const start = makeNode(
    'start',
    { x: 0, y: 0 },
    { trigger: 'schedule', schedule: 3600 },
  );
  const finish = makeNode('finish', { x: 320, y: 0 }, {});
  const flow = await f.createFlow({
    schema: 1,
    nodes: [start, finish],
    edges: [
      {
        id: 'e1',
        source: start.id,
        sourceHandle: 'started',
        target: finish.id,
        targetHandle: 'value',
      },
    ],
  });
  const draft = await f.triggerInfo(flow.id);
  expect(draft.starts[0].schedule).toBe('Every hour');
  // Unpublished flows have no registered trigger, so no next run is known.
  expect(draft.starts[0].nextRunAt ?? null).toBeNull();
  // A flow with no webhook Start is never given a token.
  expect(draft.token).toBeNull();

  await f.publish(flow);
  const live = await f.triggerInfo(flow.id);
  expect(live.starts[0].nextRunAt).toBeGreaterThan(Date.now());
  expect(countdown(live.starts[0].nextRunAt!, Date.now())).toBe('in 1h');
});

it('regenerates the webhook token and retires the old one', async () => {
  const f = fixture();
  const { graph, startId } = webhookGraph();
  const flow = await f.createFlow(graph);
  const before = await f.mintToken(flow.id);
  await f.publish(flow);
  const url = `http://localhost/api/flows/${flow.id}/hooks/${startId}`;
  expect((await f.callHook(url, before)).status).toBe(202);

  const minted = await f.app.request(
    `http://localhost/api/flows/${flow.id}/webhook-token`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  expect(minted.status).toBe(200);
  const { token } = (await minted.json()) as { token: string };
  expect(token).not.toBe(before);
  expect((await f.triggerInfo(flow.id, true)).token).toBe(token);

  expect((await f.callHook(url, before)).status).toBe(401);
  expect((await f.callHook(url)).status).toBe(401);
  const accepted = await f.callHook(url, token);
  expect(accepted.status).toBe(202);
  const { runId } = (await accepted.json()) as { runId: string };
  await f.platform.runner.settled(runId);
  // Both endpoints are flow-scoped and say so for an id that does not exist.
  for (const [path, init] of [
    ['trigger-info', undefined],
    [
      'webhook-token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    ],
  ] as const)
    expect(
      (await f.app.request(`http://localhost/api/flows/nope/${path}`, init))
        .status,
    ).toBe(404);
});

it('reports the live webhook facts, not the draft the panel is showing', async () => {
  const f = fixture();
  // Published with no security, then the draft is switched to a token.
  const { graph, startId } = webhookGraph('none');
  const flow = await f.createFlow(graph);
  const published = await f.publish(flow);
  const tightened = structuredClone(published.graph);
  const start = tightened.nodes.find((node) => node.id === startId)!;
  start.config = { ...start.config, webhookAuth: 'token', active: false };
  const saved = await f.app.request(
    `http://localhost/api/flows/${flow.id}`,
    json({ graph: tightened, revision: published.revision }, 'PUT'),
  );
  expect(saved.status).toBe(200);

  // The hook still enforces the published trigger, so the panel must not
  // promise a token gate that is not there, nor call a live Start switched
  // off only in the draft.
  const info = await f.triggerInfo(flow.id, true);
  const live = info.starts.find((item) => item.nodeId === startId)!;
  expect(live.tokenRequired).toBe(false);
  expect(live.active).toBe(true);
  expect((await f.callHook(live.url!)).status).toBe(202);

  // Publishing the draft is what moves the live facts.
  const current = await f.app.request(`http://localhost/api/flows/${flow.id}`);
  await f.publish((await current.json()) as Flow);
  const after = await f.triggerInfo(flow.id, true);
  const now = after.starts.find((item) => item.nodeId === startId)!;
  expect(now.tokenRequired).toBe(true);
  expect(now.active).toBe(false);
});

it('lets a webhook call in without the owner token, but not without any', async () => {
  const f = fixture({ ownerToken: 'x'.repeat(32) });
  const { graph, startId } = webhookGraph();
  const flow = await f.createFlow(graph);
  const token = await f.mintToken(flow.id);
  await f.publish(flow);
  const url = `http://localhost/api/flows/${flow.id}/hooks/${startId}`;
  // An outside caller cannot have the owner token; the flow token is the
  // hook's credential, so the curl the Start panel offers has to work.
  expect((await f.callHook(url, token)).status).toBe(202);
  expect((await f.callHook(url, 'wrong')).status).toBe(401);
  expect((await f.callHook(url)).status).toBe(401);
  // Every other /api path still demands the owner token.
  expect(
    (await f.app.request(`http://localhost/api/flows/${flow.id}`)).status,
  ).toBe(401);
});

it('refuses a tokenless webhook anywhere but this machine', async () => {
  const f = fixture({ origin: 'https://flows.example.com' });
  const { graph, startId } = webhookGraph('none');
  const flow = await f.createFlow(graph);
  await f.publish(flow);
  const path = `/api/flows/${flow.id}/hooks/${startId}`;
  // Exempt from the owner token, so "security: None" would leave the hook
  // with no credential at all once it is reachable from outside.
  const remote = await f.callHook(`https://flows.example.com${path}`);
  expect(remote.status).toBe(401);
  expect(((await remote.json()) as { error: string }).error).toContain(
    'only callable on this machine',
  );
  expect((await f.callHook(`http://localhost${path}`)).status).toBe(202);
});

it('reads an exported file and refuses one that is not a flow', () => {
  const { graph } = webhookGraph();
  const parsed = parseFlowFile(
    JSON.stringify({ name: '  Weekly digest  ', description: 'd', graph }),
  );
  expect(parsed.name).toBe('Weekly digest');
  expect(parsed.graph.nodes).toHaveLength(2);
  // A file with no name still imports, under a neutral one.
  expect(parseFlowFile(JSON.stringify({ graph })).name).toBe('Imported flow');

  expect(() => parseFlowFile('not json at all')).toThrow(/not JSON/);
  expect(() => parseFlowFile(JSON.stringify({ name: 'x' }))).toThrow(
    /no flow graph/,
  );
  expect(() =>
    parseFlowFile(JSON.stringify({ graph: { ...graph, schema: 2 } })),
  ).toThrow(/schema 1/);
  expect(() =>
    parseFlowFile(
      JSON.stringify({ graph: { ...graph, nodes: [{ id: 'n1' }] } }),
    ),
  ).toThrow(/basic fields/);
  expect(() =>
    parseFlowFile(
      JSON.stringify({
        graph: {
          ...graph,
          nodes: [{ ...graph.nodes[0], type: 'teleport' }],
        },
      }),
    ),
  ).toThrow(/does not know: teleport/);
});

it('clears unknown Dot references on import so the new flow asks for one', async () => {
  const f = fixture();
  const space = f.ws.createSpace('Marketing', '');
  const dot = f.ws.createDot(space.id, 'Scout', 'Be concise', true, true);

  const known = makeNode(
    'dot-task',
    { x: 0, y: 0 },
    { dot: dot.id, task: 'Summarise the week.' },
  );
  known.label = 'Scout step';
  const missing = makeNode(
    'dot-task',
    { x: 320, y: 0 },
    { dot: 'dot_from_another_workspace', task: 'Draft the post.' },
  );
  missing.label = 'Writer';
  const strayPage = makeNode(
    'read-page',
    { x: 640, y: 0 },
    { space: 'space_elsewhere', page: 'page_elsewhere', pageName: 'Brief' },
  );
  strayPage.label = 'Brief';
  const graph: FlowGraph = {
    schema: 1,
    nodes: [
      makeNode('start', { x: -320, y: 0 }, {}),
      known,
      missing,
      strayPage,
    ],
    edges: [],
  };

  const parsed = parseFlowFile(
    JSON.stringify({ name: 'Imported digest', description: '', graph }),
  );
  const { cleared, relinked } = relinkGraph(parsed.graph, {
    dots: [{ id: dot.id, name: dot.name }],
    spaces: [{ id: space.id, name: space.name }],
  });
  expect(relinked).toEqual([]);
  expect(cleared).toEqual([
    { node: 'Writer', field: 'Dot' },
    { node: 'Brief', field: 'Space' },
  ]);
  const byLabel = new Map(parsed.graph.nodes.map((node) => [node.label, node]));
  // The Dot that exists here is kept; the one from elsewhere is gone.
  expect(byLabel.get('Scout step')!.config.dot).toBe(dot.id);
  expect(byLabel.get('Writer')!.config.dot).toBeUndefined();
  // A page id means nothing without its Space, so it goes too.
  expect(byLabel.get('Brief')!.config.page).toBeUndefined();
  expect(byLabel.get('Brief')!.config.pageName).toBeUndefined();

  const created = await f.createFlow(parsed.graph, parsed.name);
  const validated = await f.app.request(
    `http://localhost/api/flows/${created.id}/validate`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  const { problems } = (await validated.json()) as {
    problems: { level: string; code: string; message: string }[];
  };
  // The cleared field is now a visible, fixable problem rather than a
  // silent reference to a Dot this workspace has never seen.
  expect(
    problems.some(
      (problem) =>
        problem.level === 'error' &&
        problem.message.startsWith('Writer:') &&
        /Dot/.test(problem.message),
    ),
  ).toBe(true);
  expect(
    problems.some(
      (problem) =>
        problem.level === 'error' && problem.message.startsWith('Scout step:'),
    ),
  ).toBe(false);
});

it('re-links a Dot and Space by name, and drops the tools bound to them', () => {
  const f = fixture();
  const space = f.ws.createSpace('Marketing', '');
  const dot = f.ws.createDot(space.id, 'Scout', 'Be concise', true, true);

  // What another workspace exports: foreign ids, with the names beside them.
  const task = makeNode(
    'dot-task',
    { x: 0, y: 0 },
    {
      dot: 'dot_elsewhere',
      dotName: 'scout',
      task: 'Draft the post.',
      tools: ['connection:conn_elsewhere'],
    },
  );
  task.label = 'Writer';
  const page = makeNode(
    'read-page',
    { x: 320, y: 0 },
    {
      space: 'space_elsewhere',
      spaceName: 'Marketing',
      page: 'page_elsewhere',
      pageName: 'Brief',
    },
  );
  page.label = 'Brief';
  const ambiguous = makeNode(
    'dot-task',
    { x: 640, y: 0 },
    { dot: 'dot_elsewhere_2', dotName: 'Nobody here', task: 'Proofread.' },
  );
  ambiguous.label = 'Proofreader';
  const graph: FlowGraph = {
    schema: 1,
    nodes: [makeNode('start', { x: -320, y: 0 }, {}), task, page, ambiguous],
    edges: [],
  };

  const { cleared, relinked } = relinkGraph(graph, {
    dots: [{ id: dot.id, name: dot.name }],
    spaces: [{ id: space.id, name: space.name }],
  });
  // Matching is case-insensitive, and reported by the name both agree on.
  expect(relinked).toEqual([
    { node: 'Writer', field: 'Dot', name: 'scout' },
    { node: 'Brief', field: 'Space', name: 'Marketing' },
  ]);
  expect(task.config.dot).toBe(dot.id);
  expect(page.config.space).toBe(space.id);
  // A tool binding embeds the exporting workspace's connection id, so it
  // cannot survive the Dot moving: it would publish clean and fail at run
  // time. Same for a page id under a re-linked Space.
  expect(task.config.tools).toBeUndefined();
  expect(page.config.page).toBeUndefined();
  expect(cleared).toEqual([
    { node: 'Writer', field: 'Allowed tools' },
    { node: 'Proofreader', field: 'Dot', name: 'Nobody here' },
  ]);
  expect(ambiguous.config.dot).toBeUndefined();
});

it('says which half of an imported file the server refused', async () => {
  const f = fixture();
  const start = makeNode('start', { x: 0, y: 0 }, {});
  const ok: FlowGraph = { schema: 1, nodes: [start], edges: [] };
  // parseFlowFile is looser than the server schema (node ids up to 40
  // characters, no extra keys), so a hand-edited file can still be refused
  // here — and the import dialog shows this sentence verbatim.
  const longId = {
    ...ok,
    nodes: [{ ...start, id: 'n'.repeat(60) }],
  } as FlowGraph;
  const refused = await f.app.request(
    'http://localhost/api/flows',
    json({ name: 'Imported flow', graph: longId }),
  );
  expect(refused.status).toBe(400);
  const { error } = (await refused.json()) as { error: string };
  expect(error).toContain('flow graph is not valid');
  expect(error).toContain('graph.nodes.0.id');

  const unnamed = await f.app.request(
    'http://localhost/api/flows',
    json({ name: '', graph: ok }),
  );
  expect(unnamed.status).toBe(400);
  expect(((await unnamed.json()) as { error: string }).error).toBe(
    'Give the flow a name (up to 80 characters).',
  );
});
