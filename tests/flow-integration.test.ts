/**
 * Seams between the container model, the engine, the triggers and the
 * stores: the things each piece gets right on its own and only break where
 * they meet. Everything here runs without Intelligence, Slack or OpenBot.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  FlowTriggerBridge,
  matchingPageStarts,
  matchingSlackStarts,
  publishedFlows,
} from '../src/server/flow-triggers.js';
import {
  absolutePosition,
  bodyNodes,
  canContain,
  lintFlow,
  makeNode,
  type FlowGraph,
  type FlowNode,
} from '../src/shared/flows.js';
import type { Flow } from '../src/shared/flows.js';
import type { FlowRun } from '../src/shared/flow-runs.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

/** A platform over the given paths; reopening the same paths is a restart. */
function platformAt(storePath: string, workspacePath: string) {
  const store = new Store(storePath);
  const ws = new WorkspaceStore(workspacePath, 'owner');
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    platform.runner.stop();
    store.close();
    ws.close();
  };
  return { store, ws, platform, app, close };
}
function fixture() {
  const made = platformAt(':memory:', ':memory:');
  cleanup.push(made.close);
  return made;
}
/** A throwaway directory for the two databases a restart has to survive. */
function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'thinnspace-flows-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { store: join(dir, 'store.db'), workspace: join(dir, 'workspace.db') };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function until<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const lintArgs = () => ({ dots: [], spaces: [] });

/* ---------- the container model through save and reload ---------- */

it('keeps For each membership, relative positions and size through the API', async () => {
  const f = fixture();
  const loop = makeNode('for-each', { x: 400, y: 120 }, {});
  loop.width = 520;
  loop.height = 340;
  // Inside a container a position is relative to the container's top-left.
  const inner = makeNode('combine', { x: 40, y: 70 }, { template: 'x' });
  inner.parentId = loop.id;
  const outer = makeNode('combine', { x: 900, y: 120 }, { template: 'y' });
  const graph: FlowGraph = {
    schema: 1,
    nodes: [loop, inner, outer],
    edges: [],
  };
  const created = await f.app.request(
    'http://localhost/api/flows',
    json({ name: 'Container flow', graph }),
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const reloaded = (await (
    await f.app.request(`http://localhost/api/flows/${id}`)
  ).json()) as Flow;
  const byId = new Map(reloaded.graph.nodes.map((node) => [node.id, node]));
  const savedInner = byId.get(inner.id)!;
  const savedLoop = byId.get(loop.id)!;
  // Storage is relative: the child's own position is untouched by the move.
  expect(savedInner.parentId).toBe(loop.id);
  expect(savedInner.position).toEqual({ x: 40, y: 70 });
  // The container's box survives, so reopening the editor draws it as drawn.
  expect({ width: savedLoop.width, height: savedLoop.height }).toEqual({
    width: 520,
    height: 340,
  });
  // ...and absolute is what the canvas and layout actually work in.
  expect(absolutePosition(reloaded.graph, savedInner)).toEqual({
    x: 440,
    y: 190,
  });
  expect(absolutePosition(reloaded.graph, byId.get(outer.id)!)).toEqual({
    x: 900,
    y: 120,
  });
  expect(bodyNodes(reloaded.graph, loop.id).map((node) => node.id)).toEqual([
    inner.id,
  ]);
  expect(canContain(reloaded.graph, loop.id)).toBe(true);
  expect(canContain(reloaded.graph, outer.id)).toBe(false);
});

it('never leaves a body step the outer pass could neither run nor settle', () => {
  // A parentId that does not name a usable container would be skipped by the
  // pump and driven by nobody. Every arrangement that could still receive
  // input has to be an error, or the step would vanish from the run.
  const start = makeNode('start', { x: 0, y: 0 }, { trigger: 'manual' });
  const host = makeNode('combine', { x: 300, y: 0 }, { template: 'a' });
  const orphan = makeNode('combine', { x: 600, y: 0 }, { template: 'b' });
  orphan.parentId = host.id; // not a For each at all
  const graph: FlowGraph = {
    schema: 1,
    nodes: [start, host, orphan],
    edges: [
      {
        id: 'e0',
        source: start.id,
        sourceHandle: 'started',
        target: host.id,
        targetHandle: 'values',
      },
      {
        id: 'e1',
        source: host.id,
        sourceHandle: 'text',
        target: orphan.id,
        targetHandle: 'values',
      },
    ],
  };
  const codes = lintFlow(graph, lintArgs())
    .filter((problem) => problem.level === 'error')
    .map((problem) => problem.code);
  expect(codes).toContain('container-boundary');
  // The same node with no way in is merely unreachable, never a silent skip.
  const lonely: FlowGraph = { ...graph, edges: [graph.edges[0]] };
  const lonelyProblems = lintFlow(lonely, lintArgs());
  expect(lonelyProblems.some((problem) => problem.code === 'unreachable')).toBe(
    true,
  );
});

/* ---------- a Wait outlives the process it was parked by ---------- */

it('resumes a Wait parked before a restart, and interrupts only running runs', async () => {
  const where = paths();
  const first = platformAt(where.store, where.workspace);
  cleanup.push(first.close);
  const start = makeNode('start', { x: 0, y: 0 }, { trigger: 'manual' });
  const pause = makeNode('wait', { x: 300, y: 0 }, { minutes: 30 });
  const after = makeNode(
    'combine',
    { x: 600, y: 0 },
    { template: 'resumed with {{start.input}}' },
  );
  const graph: FlowGraph = {
    schema: 1,
    nodes: [start, pause, after],
    edges: [
      {
        id: 'e0',
        source: start.id,
        sourceHandle: 'started',
        target: pause.id,
        targetHandle: 'input',
      },
      {
        id: 'e1',
        source: pause.id,
        sourceHandle: 'output',
        target: after.id,
        targetHandle: 'values',
      },
    ],
  };
  const made = await first.app.request(
    'http://localhost/api/flows',
    json({ name: 'Waiting flow', graph }),
  );
  const { id: flowId } = (await made.json()) as { id: string };
  const started = await first.app.request(
    `http://localhost/api/flows/${flowId}/runs`,
    json({ input: 'hello' }),
  );
  expect(started.status).toBe(201);
  const { id: runId } = (await started.json()) as FlowRun;
  // The run parks: no worker and no step in flight while it waits.
  await until(() => {
    const run = first.ws.runs.get(runId);
    return run?.status === 'waiting' ? run : undefined;
  });
  expect(first.ws.runs.waitAt(runId, pause.id)).toBeGreaterThan(Date.now());
  first.close();

  // Restart: a new process over the same files.
  const second = platformAt(where.store, where.workspace);
  cleanup.push(second.close);
  const recovered = second.ws.runs.get(runId)!;
  expect(recovered.status).toBe('waiting');
  expect(second.ws.runs.waitAt(runId, pause.id)).toBeGreaterThan(0);

  // Nothing is due yet, so the scheduler leaves it alone.
  await second.platform.runner.wakeDue(Date.now());
  expect(second.ws.runs.get(runId)!.status).toBe('waiting');

  // Once the wake time passes it carries on, with the value it was holding.
  await second.platform.runner.wakeDue(Date.now() + 31 * 60_000);
  const done = await until(() => {
    const run = second.ws.runs.get(runId);
    return run && run.status !== 'waiting' && run.status !== 'running'
      ? run
      : undefined;
  });
  expect(done.status).toBe('completed');
  const resumed = second.ws.runs
    .get(runId)!
    .steps.find((step) => step.nodeId === after.id);
  expect(String(resumed?.output?.text.value)).toBe('resumed with hello');
  // The wait row is spent, so a later tick cannot resume it twice.
  expect(second.ws.runs.waitAt(runId, pause.id)).toBe(undefined);
});

/* ---------- triggers only ever start a published, unpaused flow ---------- */

function slackStart(config: Record<string, unknown> = {}): FlowGraph {
  const start = makeNode(
    'start',
    { x: 0, y: 0 },
    { trigger: 'slack', ...config },
  );
  return { schema: 1, nodes: [start], edges: [] };
}
function pageStart(config: Record<string, unknown>): FlowGraph {
  const start = makeNode(
    'start',
    { x: 0, y: 0 },
    { trigger: 'page', ...config },
  );
  return { schema: 1, nodes: [start], edges: [] };
}
/** Records what the bridge tried to start. */
function bridgeOver(
  flows: { flowId: string; graph: FlowGraph }[],
  options: { paused?: boolean; busy?: string[] } = {},
) {
  const fired: string[] = [];
  const bridge = new FlowTriggerBridge({
    published: () => flows,
    paused: () => options.paused ?? false,
    busyFlows: () => options.busy ?? [],
    fire: (flowId) => {
      fired.push(flowId);
      return { id: `run_${fired.length}` };
    },
    report: () => {},
  });
  return { bridge, fired };
}

it('starts nothing from a draft: only a published version is a trigger', () => {
  const f = fixture();
  const graph = slackStart();
  f.ws.flows.create('Draft flow', '', graph);
  // Published-ness is the whole gate, and it is read per event.
  expect(publishedFlows(f.ws.flows)).toEqual([]);
  const { bridge, fired } = bridgeOver(
    publishedFlows(f.ws.flows).map((flow) => ({
      flowId: flow.flowId,
      graph: flow.graph,
    })),
  );
  void bridge.slackMention({ text: 'please run', channel: 'support' });
  expect(fired).toEqual([]);
});

it('starts nothing while the workspace is paused, by either trigger', async () => {
  const graph = slackStart();
  const pages = pageStart({ watchSpace: 'space_1', pageEvent: 'created' });
  const flows = [
    { flowId: 'f1', graph },
    { flowId: 'f2', graph: pages },
  ];
  const paused = bridgeOver(flows, { paused: true });
  expect(await paused.bridge.slackMention({ text: 'go', channel: 'any' })).toBe(
    false,
  );
  paused.bridge.pageWritten({
    spaceId: 'space_1',
    pageId: 'p1',
    title: 'New',
    event: 'created',
  });
  expect(paused.fired).toEqual([]);
  // The same events, unpaused, do start their flows: the pause is the reason.
  // The mention's return value is about who answers in Slack, not about
  // whether the flow ran — this fixture's flow has no step that replies in
  // the thread, so the Dot still answers it — hence `fired` below.
  const live = bridgeOver(flows);
  await live.bridge.slackMention({ text: 'go', channel: 'any' });
  live.bridge.pageWritten({
    spaceId: 'space_1',
    pageId: 'p1',
    title: 'New',
    event: 'created',
  });
  expect(live.fired).toEqual(['f1', 'f2']);
});

it('leaves a paused Start out while its siblings still fire', () => {
  const off = pageStart({
    watchSpace: 'space_1',
    pageEvent: 'created',
    active: false,
  });
  const on = pageStart({ watchSpace: 'space_1', pageEvent: 'created' });
  const write = {
    spaceId: 'space_1',
    pageId: 'p1',
    title: 'New',
    event: 'created' as const,
  };
  expect(matchingPageStarts([{ flowId: 'f1', graph: off }], write)).toEqual([]);
  expect(
    matchingPageStarts([{ flowId: 'f2', graph: on }], write).map(
      (match) => match.flowId,
    ),
  ).toEqual(['f2']);
  const slackOff = slackStart({ active: false });
  expect(
    matchingSlackStarts([{ flowId: 'f3', graph: slackOff }], {
      text: 'hello',
      channel: 'support',
    }),
  ).toEqual([]);
});

/* ---------- a flow cannot run itself, statically or at runtime ---------- */

it('refuses to publish or run a flow whose Run flow step loops back', async () => {
  const f = fixture();
  const blank: FlowGraph = {
    schema: 1,
    nodes: [makeNode('start', { x: 0, y: 0 }, { trigger: 'manual' })],
    edges: [],
  };
  const other = f.ws.flows.create('Callee', '', blank);
  const selfCaller = (target: string): FlowGraph => {
    const start = makeNode('start', { x: 0, y: 0 }, { trigger: 'manual' });
    const call = makeNode('run-flow', { x: 300, y: 0 }, { flow: target });
    return {
      schema: 1,
      nodes: [start, call],
      edges: [
        {
          id: 'e0',
          source: start.id,
          sourceHandle: 'started',
          target: call.id,
          targetHandle: 'input',
        },
      ],
    };
  };
  const mine = f.ws.flows.create('Caller', '', blank);
  // Direct: the flow points at itself.
  f.ws.flows.update(mine.id, { graph: selfCaller(mine.id) }, mine.revision);
  const direct = await f.app.request(
    `http://localhost/api/flows/${mine.id}/validate`,
    json({}),
  );
  const directProblems = (await direct.json()) as {
    problems: { code: string }[];
  };
  expect(directProblems.problems.map((p) => p.code)).toContain('flow-cycle');

  // Indirect: Caller -> Callee -> Caller. Arming this needs every graph,
  // which is why the route passes them.
  f.ws.flows.update(
    mine.id,
    { graph: selfCaller(other.id) },
    f.ws.flows.get(mine.id)!.revision,
  );
  f.ws.flows.update(other.id, { graph: selfCaller(mine.id) }, other.revision);
  const indirect = (await (
    await f.app.request(
      `http://localhost/api/flows/${mine.id}/validate`,
      json({}),
    )
  ).json()) as { problems: { code: string; message: string }[] };
  expect(indirect.problems.map((p) => p.code)).toContain('flow-cycle');

  // And the two gates that matter refuse it rather than discovering it mid-run.
  const current = f.ws.flows.get(mine.id)!;
  const published = await f.app.request(
    `http://localhost/api/flows/${mine.id}/publish`,
    json({ revision: current.revision }),
  );
  expect(published.status).toBe(400);
  const ran = await f.app.request(
    `http://localhost/api/flows/${mine.id}/runs`,
    json({ input: '' }),
  );
  expect(ran.status).toBe(400);
});

it('points a Run flow step at a flow that is gone', async () => {
  const f = fixture();
  const start = makeNode('start', { x: 0, y: 0 }, { trigger: 'manual' });
  const call = makeNode('run-flow', { x: 300, y: 0 }, { flow: 'flow_gone' });
  const graph: FlowGraph = {
    schema: 1,
    nodes: [start, call],
    edges: [
      {
        id: 'e0',
        source: start.id,
        sourceHandle: 'started',
        target: call.id,
        targetHandle: 'input',
      },
    ],
  };
  const made = f.ws.flows.create('Dangling', '', graph);
  const problems = (await (
    await f.app.request(
      `http://localhost/api/flows/${made.id}/validate`,
      json({}),
    )
  ).json()) as { problems: { code: string }[] };
  expect(problems.problems.map((p) => p.code)).toContain('missing-flow');
});

/* ---------- the catalog is the single source of what is unavailable ---------- */

it('flags no catalog node as coming soon and refuses none at runtime', async () => {
  const { NODE_SPECS, NODE_CATALOG } = await import('../src/shared/flows.js');
  const { executorFor } = await import('../src/server/flow-executors.js');
  const soon = Object.values(NODE_SPECS)
    .filter((spec) => spec.comingSoon)
    .map((spec) => spec.type);
  expect(soon).toEqual([]);
  // Every executable node in the catalog has a real executor behind it, so
  // nothing the palette offers can fail with "not available yet".
  for (const category of NODE_CATALOG)
    for (const spec of category.nodes) {
      if (spec.decorative) continue;
      const executor = executorFor(spec.type);
      expect(executor, `${spec.type} has no executor`).toBeDefined();
      const graph: FlowGraph = {
        schema: 1,
        nodes: [makeNode(spec.type, { x: 0, y: 0 }, {}) as FlowNode],
        edges: [],
      };
      expect(
        lintFlow(graph, lintArgs()).some(
          (problem) => problem.code === 'coming-soon',
        ),
        `${spec.type} still lints as coming soon`,
      ).toBe(false);
    }
});
