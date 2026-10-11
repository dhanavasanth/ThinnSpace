import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  createsCycle,
  emptyGraph,
  lintFlow,
  makeNode,
  nodeOutputs,
  type Flow,
  type FlowGraph,
} from '../src/shared/flows.js';
import { FLOW_TEMPLATES } from '../src/shared/flow-templates.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture() {
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
  return {
    ws,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    }),
  };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('creates, updates with revision checks, duplicates, and deletes flows', async () => {
  const { app } = fixture();
  const created = await app.request(
    'http://localhost/api/flows',
    json({ name: 'Launch', description: 'd' }),
  );
  expect(created.status).toBe(201);
  const flow = (await created.json()) as Flow;
  expect(flow.graph.nodes.map((n) => n.type)).toEqual(['start']);
  expect(flow.revision).toBe(1);
  const graph: FlowGraph = {
    ...flow.graph,
    nodes: [...flow.graph.nodes, makeNode('finish', { x: 400, y: 160 })],
  };
  const updated = await app.request(
    `http://localhost/api/flows/${flow.id}`,
    json({ graph, revision: 1 }, 'PUT'),
  );
  expect(updated.status).toBe(200);
  expect(((await updated.json()) as Flow).revision).toBe(2);
  // A stale editor cannot overwrite the newer save.
  const stale = await app.request(
    `http://localhost/api/flows/${flow.id}`,
    json({ name: 'Old name', revision: 1 }, 'PUT'),
  );
  expect(stale.status).toBe(409);
  const list = (await (
    await app.request('http://localhost/api/flows')
  ).json()) as {
    id: string;
    nodeCount: number;
    trigger: string;
  }[];
  expect(list).toHaveLength(1);
  expect(list[0].nodeCount).toBe(2);
  expect(list[0].trigger).toBe('manual');
  const copy = await app.request(
    `http://localhost/api/flows/${flow.id}/duplicate`,
    json({}),
  );
  expect(copy.status).toBe(201);
  expect(((await copy.json()) as Flow).name).toBe('Launch copy');
  const removed = await app.request(`http://localhost/api/flows/${flow.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(removed.status).toBe(200);
  expect(
    (await app.request(`http://localhost/api/flows/${flow.id}`)).status,
  ).toBe(404);
});

it('rejects graphs that reference unknown nodes or types', async () => {
  const { app } = fixture();
  const bad = await app.request(
    'http://localhost/api/flows',
    json({
      name: 'Bad',
      graph: {
        schema: 1,
        nodes: [
          {
            id: 'a',
            type: 'nope',
            typeVersion: 1,
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [],
      },
    }),
  );
  expect(bad.status).toBe(400);
  const dangling = await app.request(
    'http://localhost/api/flows',
    json({
      name: 'Bad',
      graph: {
        schema: 1,
        nodes: [
          {
            id: 'a',
            type: 'start',
            typeVersion: 1,
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [
          {
            id: 'e',
            source: 'a',
            sourceHandle: 'started',
            target: 'zz',
            targetHandle: 'value',
          },
        ],
      },
    }),
  );
  expect(dangling.status).toBe(400);
});

it('builds every template as a storable graph that lints without errors given its Dots', async () => {
  const { app, ws } = fixture();
  const dot = ws.dots()[0];
  const space = ws.spaces()[0];
  for (const template of FLOW_TEMPLATES) {
    const created = await app.request(
      'http://localhost/api/flows',
      json({ name: template.name, templateId: template.id }),
    );
    expect(created.status).toBe(201);
    const flow = (await created.json()) as Flow;
    expect(flow.graph.nodes.length).toBeGreaterThan(3);
    // Fill in the choices a user makes after picking a template.
    for (const node of flow.graph.nodes) {
      if (['dot-task', 'dot-decide', 'mcp-tool'].includes(node.type))
        node.config.dot = dot.id;
      if (node.type === 'start' && node.config.trigger === 'slack')
        node.config.slackDot = dot.id;
      if (['read-page', 'save-page'].includes(node.type)) {
        node.config.space = space.id;
        if (node.config.mode !== 'all' && node.config.mode !== 'create')
          node.config.page = 'p1';
      }
    }
    const errors = lintFlow(flow.graph, {
      dots: [dot],
      spaces: [space],
    }).filter((p) => p.level === 'error');
    expect(errors, `${template.name}: ${JSON.stringify(errors)}`).toEqual([]);
  }
});

it('keeps versions and restores them as a new revision', async () => {
  const { app } = fixture();
  const flow = (await (
    await app.request('http://localhost/api/flows', json({ name: 'V' }))
  ).json()) as Flow;
  const named = await app.request(
    `http://localhost/api/flows/${flow.id}/versions`,
    json({ label: 'Before edits' }),
  );
  expect(named.status).toBe(201);
  const version = (await named.json()) as { id: string };
  const graph: FlowGraph = {
    ...flow.graph,
    nodes: [...flow.graph.nodes, makeNode('note', { x: 0, y: 0 })],
  };
  await app.request(
    `http://localhost/api/flows/${flow.id}`,
    json({ graph, revision: 1 }, 'PUT'),
  );
  expect(
    (
      (await (
        await app.request(`http://localhost/api/flows/${flow.id}`)
      ).json()) as Flow
    ).graph.nodes,
  ).toHaveLength(2);
  const restored = await app.request(
    `http://localhost/api/flows/${flow.id}/versions/${version.id}/restore`,
    json({ revision: 2 }),
  );
  expect(restored.status).toBe(200);
  const after = (await restored.json()) as Flow;
  expect(after.graph.nodes).toHaveLength(1);
  expect(after.revision).toBe(3);
  const versions = (await (
    await app.request(`http://localhost/api/flows/${flow.id}/versions`)
  ).json()) as { source: string }[];
  expect(versions.map((v) => v.source).sort()).toEqual([
    'autosave',
    'named',
    'restore',
  ]);
});

it('publishes only clean flows and tracks unpublished changes', async () => {
  const { app, ws } = fixture();
  const flow = (await (
    await app.request('http://localhost/api/flows', json({ name: 'P' }))
  ).json()) as Flow;
  // A lone Start has warnings but no errors, so it can publish.
  const published = await app.request(
    `http://localhost/api/flows/${flow.id}/publish`,
    json({ revision: 1 }),
  );
  expect(published.status).toBe(200);
  const after = (await published.json()) as Flow;
  expect(after.publishedVersionId).toBeTruthy();
  expect(after.publishedRevision).toBe(1);
  let list = (await (
    await app.request('http://localhost/api/flows')
  ).json()) as { status: string }[];
  expect(list[0].status).toBe('published');
  // Editing creates unpublished changes; an invalid graph cannot be published.
  const broken: FlowGraph = {
    ...after.graph,
    nodes: [...after.graph.nodes, makeNode('dot-task', { x: 1, y: 1 }, {})],
  };
  await app.request(
    `http://localhost/api/flows/${flow.id}`,
    json({ graph: broken, revision: 1 }, 'PUT'),
  );
  list = (await (await app.request('http://localhost/api/flows')).json()) as {
    status: string;
  }[];
  expect(list[0].status).toBe('changed');
  const rejected = await app.request(
    `http://localhost/api/flows/${flow.id}/publish`,
    json({ revision: 2 }),
  );
  expect(rejected.status).toBe(400);
  expect(
    ((await rejected.json()) as { problems: unknown[] }).problems.length,
  ).toBeGreaterThan(0);
  expect(ws.flows.get(flow.id)?.publishedRevision).toBe(1);
  const unpublished = await app.request(
    `http://localhost/api/flows/${flow.id}/unpublish`,
    json({}),
  );
  expect(((await unpublished.json()) as Flow).publishedVersionId).toBeNull();
});

it('lints missing Start, required fields, port mismatches, fan-in limits, and cycles', () => {
  const dots = [{ id: 'd1' }];
  const spaces = [{ id: 's1' }];
  expect(
    lintFlow({ schema: 1, nodes: [], edges: [] }, { dots, spaces }).map(
      (p) => p.code,
    ),
  ).toContain('no-start');
  const graph = emptyGraph();
  const task = makeNode('dot-task', { x: 1, y: 1 }, {});
  const review = makeNode('human-review', { x: 2, y: 2 }, { message: 'look' });
  const finish = makeNode('finish', { x: 3, y: 3 });
  graph.nodes.push(task, review, finish);
  const start = graph.nodes[0];
  graph.edges.push(
    {
      id: 'e1',
      source: start.id,
      sourceHandle: 'started',
      target: task.id,
      targetHandle: 'context',
    },
    {
      id: 'e2',
      source: task.id,
      sourceHandle: 'result',
      target: review.id,
      targetHandle: 'draft',
    },
    {
      id: 'e3',
      source: review.id,
      sourceHandle: 'approved',
      target: finish.id,
      targetHandle: 'value',
    },
  );
  let codes = lintFlow(graph, { dots, spaces }).map((p) => p.code);
  expect(codes).toContain('missing-config'); // dot and task missing
  expect(codes).not.toContain('kind-mismatch');
  task.config = { dot: 'gone', task: 'write' };
  expect(lintFlow(graph, { dots, spaces }).map((p) => p.code)).toContain(
    'missing-dot',
  );
  task.config = { dot: 'd1', task: 'write' };
  codes = lintFlow(graph, { dots, spaces }).map((p) => p.code);
  expect(codes.filter((c) => c === 'missing-config')).toEqual([]);
  // A trigger into a text input is a mismatch; a second edge into a single input is too many.
  const save = makeNode(
    'save-page',
    { x: 4, y: 4 },
    { space: 's1', mode: 'create', title: 't' },
  );
  const gate = makeNode(
    'branch',
    { x: 5, y: 5 },
    { field: 'x', operator: 'empty' },
  );
  graph.nodes.push(save, gate);
  graph.edges.push(
    {
      id: 'e4',
      source: start.id,
      sourceHandle: 'started',
      target: save.id,
      targetHandle: 'content',
    },
    {
      id: 'e5',
      source: start.id,
      sourceHandle: 'started',
      target: gate.id,
      targetHandle: 'input',
    },
    {
      id: 'e6',
      source: task.id,
      sourceHandle: 'result',
      target: gate.id,
      targetHandle: 'input',
    },
  );
  codes = lintFlow(graph, { dots, spaces }).map((p) => p.code);
  expect(codes).toContain('kind-mismatch');
  expect(codes).toContain('too-many-inputs');
  // Dynamic outputs follow configuration, and a fresh card shows the
  // catalog default (three buttons) so card, panel and engine agree.
  expect(nodeOutputs(review).map((p) => p.id)).toEqual([
    'approved',
    'changes',
    'declined',
  ]);
  review.config.actions = 'approve-decline';
  expect(nodeOutputs(review).map((p) => p.id)).toEqual([
    'approved',
    'declined',
  ]);
  const decide = makeNode(
    'dot-decide',
    { x: 0, y: 0 },
    { branches: 'Bug, Question', otherwise: false },
  );
  expect(nodeOutputs(decide).map((p) => p.label)).toEqual(['Bug', 'Question']);
  // Cycles.
  expect(createsCycle(graph.edges, finish.id, start.id)).toBe(true);
  expect(createsCycle(graph.edges, start.id, finish.id)).toBe(false);
  graph.edges.push({
    id: 'e7',
    source: finish.id,
    sourceHandle: 'x',
    target: start.id,
    targetHandle: 'y',
  });
  expect(lintFlow(graph, { dots, spaces }).map((p) => p.code)).toContain(
    'cycle',
  );
});

it('warns about Slack delivery and blocks per-item steps that ask first', () => {
  const dots = [{ id: 'd1' }];
  const spaces = [{ id: 's1' }];
  const codes = (graph: FlowGraph) =>
    lintFlow(graph, { dots, spaces }).map((p) => `${p.level}:${p.code}`);
  const graph = emptyGraph();
  const send = makeNode(
    'send-message',
    { x: 1, y: 1 },
    { destination: 'slack', slackChannel: '#x', message: 'hi' },
  );
  const review = makeNode(
    'human-review',
    { x: 2, y: 2 },
    { message: 'look', notify: 'both' },
  );
  const save = makeNode(
    'save-page',
    { x: 3, y: 3 },
    { space: 's1', mode: 'create', title: 't', perItem: true },
  );
  const task = makeNode(
    'dot-task',
    { x: 4, y: 4 },
    { dot: 'd1', task: 'write', perItem: true, reviewBeforeSave: true },
  );
  graph.nodes.push(send, review, save, task);
  let found = codes(graph);
  // Slack is not wired up: a warning, never a blocker.
  expect(
    found.filter((c) => c === 'warning:slack-proactive-unavailable'),
  ).toHaveLength(2);
  // Asking first and running per item cannot both be on.
  expect(found.filter((c) => c === 'error:per-item-review')).toHaveLength(2);
  send.config.destination = 'inbox';
  review.config.notify = 'app';
  save.config.review = false;
  task.config.reviewBeforeSave = false;
  found = codes(graph);
  expect(found).not.toContain('warning:slack-proactive-unavailable');
  expect(found).not.toContain('error:per-item-review');
});
