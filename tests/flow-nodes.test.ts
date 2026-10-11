/**
 * The five steps that used to be "coming soon": Wait, Run flow, For each,
 * Dot team and Computer task. Everything here goes through the real
 * FlowRunner and the real tables, like tests/flow-runner.test.ts, so a run
 * that parks, wakes, loops or starts a child run is exercised end to end.
 */
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { CANCELLED_MESSAGE } from '../src/server/flow-runner.js';
import {
  COMPUTER_UNAVAILABLE_MESSAGE,
  SETUP_REQUIRED_MESSAGE,
} from '../src/server/flow-executors.js';
import {
  WAIT_MAX_MINUTES,
  lintFlow,
  makeNode,
  type FlowGraph,
  type FlowNode,
} from '../src/shared/flows.js';
import type { FlowRun } from '../src/shared/flow-runs.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const platform = new Platform(store, ws, {
    baseUrl: 'https://example.com',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  cleanup.push(() => platform.runner.stop());
  const run = (graph: FlowGraph, name = 'Test flow', input = '') => {
    const flow = ws.flows.create(name, '', graph);
    const start = graph.nodes.find((node) => node.type === 'start')!;
    const record = platform.runner.create(flow, graph, null, {
      source: 'manual',
      nodeId: start.id,
      input,
    });
    platform.runner.start(record.id);
    return { flow, runId: record.id };
  };
  const get = (runId: string) => ws.runs.get(runId)!;
  const finished = async (runId: string) => {
    await platform.runner.settled(runId);
    return get(runId);
  };
  const waiting = (runId: string) =>
    until(() => {
      const current = get(runId);
      return current.status === 'waiting' ? current : undefined;
    });
  return { store, ws, platform, run, get, finished, waiting };
}
async function until<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/**
 * Builds a graph from labelled nodes; labels double as token slugs and a
 * fourth entry puts the node inside that container's body (`parentId`).
 */
function graph(
  nodes: [
    label: string,
    type: string,
    config?: Record<string, unknown>,
    parent?: string,
  ][],
  edges: [from: string, port: string, to: string, input: string][],
): FlowGraph {
  const built = new Map<string, FlowNode>();
  for (const [index, [label, type, config]] of nodes.entries()) {
    const node = makeNode(type, { x: index * 300, y: 100 }, config ?? {});
    node.label = label;
    built.set(label, node);
  }
  for (const [label, , , parent] of nodes)
    if (parent) built.get(label)!.parentId = built.get(parent)!.id;
  return {
    schema: 1,
    nodes: [...built.values()],
    edges: edges.map(([from, port, to, input], index) => ({
      id: `e${index}`,
      source: built.get(from)!.id,
      sourceHandle: port,
      target: built.get(to)!.id,
      targetHandle: input,
    })),
  };
}
const stepsByLabel = (run: FlowRun) =>
  Object.fromEntries(
    run.steps
      .filter((step) => step.iterationKey === '')
      .map((step) => [step.label, step]),
  );
const itemSteps = (run: FlowRun, label: string) =>
  run.steps
    .filter((step) => step.label === label && step.iterationKey !== '')
    .sort((a, b) => Number(a.iterationKey) - Number(b.iterationKey));
const lintContext = () => ({ dots: [], spaces: [] });

/* ---------- Wait ---------- */

it('parks a Wait without holding the run and resumes it when it is due', async () => {
  const f = fixture();
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Pause', 'wait', { minutes: 1 }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Pause', 'input'],
      ['Pause', 'output', 'Finish', 'value'],
    ],
  );
  const { runId } = f.run(g, 'Waiting flow', 'later');
  const parked = await f.waiting(runId);
  const pause = g.nodes[1];
  expect(parked.waitingNodeId).toBe(pause.id);
  expect(stepsByLabel(parked).Pause.status).toBe('waiting');
  expect(stepsByLabel(parked).Pause.input).toEqual({ minutes: 1 });
  const wakeAt = f.ws.runs.waitAt(runId, pause.id);
  expect(wakeAt).toBeGreaterThan(Date.now());

  // A tick before the wake time leaves it parked: nothing is held open.
  await f.platform.runner.wakeDue(Date.now());
  expect(f.get(runId).status).toBe('waiting');

  await f.platform.runner.wakeDue(Date.now() + 61_000);
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('later');
  expect(stepsByLabel(done).Pause.status).toBe('completed');
  // A Wait only delays what arrived: the trigger leaves again untouched.
  expect(stepsByLabel(done).Pause.output?.output.kind).toBe('trigger');
  expect(f.ws.runs.waitAt(runId, pause.id)).toBeUndefined();
  expect(f.get(runId).waitingNodeId).toBeNull();
});

it('resumes a parked Wait on a run the engine no longer holds in memory', async () => {
  const f = fixture();
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Pause', 'wait', { minutes: 5 }],
      ['Say', 'combine', { template: 'done with {{start.input}}' }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Pause', 'input'],
      ['Pause', 'output', 'Say', 'values'],
      ['Say', 'text', 'Finish', 'value'],
    ],
  );
  const { runId } = f.run(g, 'Surviving wait', 'monday');
  await f.waiting(runId);
  // Nothing is in flight, so a shutdown drops the run from memory and
  // leaves it waiting in the tables, exactly as a restart would.
  f.platform.runner.stop();
  expect(f.get(runId).status).toBe('waiting');
  await f.platform.runner.wakeDue(Date.now() + 6 * 60_000);
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('done with monday');
});

it('cancels a run parked on a Wait and forgets the wake time', async () => {
  const f = fixture();
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Pause', 'wait', { minutes: 60 }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Pause', 'input'],
      ['Pause', 'output', 'Finish', 'value'],
    ],
  );
  const { runId } = f.run(g, 'Long wait');
  await f.waiting(runId);
  const cancelled = f.platform.runner.cancel(runId)!;
  expect(cancelled.status).toBe('cancelled');
  expect(stepsByLabel(cancelled).Pause.status).toBe('skipped');
  expect(stepsByLabel(cancelled).Pause.error).toBe(CANCELLED_MESSAGE);
  expect(f.ws.runs.waitAt(runId, g.nodes[1].id)).toBeUndefined();
  expect(f.ws.runs.dueWaits(Date.now() + 3_600_000)).toEqual([]);
  // Waking after a cancellation is a no-op rather than a resurrection.
  await f.platform.runner.wakeDue(Date.now() + 3_600_000);
  expect(f.get(runId).status).toBe('cancelled');
});

it('lints a Wait that asks for longer than the cap', () => {
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Pause', 'wait', { minutes: WAIT_MAX_MINUTES + 1 }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Pause', 'input'],
      ['Pause', 'output', 'Finish', 'value'],
    ],
  );
  const problems = lintFlow(g, lintContext());
  expect(
    problems.find((problem) => problem.code === 'wait-too-long'),
  ).toMatchObject({ level: 'error' });
  const fine = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Pause', 'wait', { minutes: WAIT_MAX_MINUTES }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Pause', 'input'],
      ['Pause', 'output', 'Finish', 'value'],
    ],
  );
  expect(
    lintFlow(fine, lintContext()).some(
      (problem) => problem.code === 'wait-too-long',
    ),
  ).toBe(false);
});

/* ---------- Run flow ---------- */

const childGraph = (template: string) =>
  graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Answer', 'combine', { template }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Answer', 'values'],
      ['Answer', 'text', 'Finish', 'value'],
    ],
  );
const callerGraph = (flowId: string) =>
  graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Sub', 'run-flow', { flow: flowId }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Sub', 'input'],
      ['Sub', 'result', 'Finish', 'value'],
    ],
  );

it('runs another flow as a step and records the child run under its parent', async () => {
  const f = fixture();
  const child = f.ws.flows.create(
    'Child',
    '',
    childGraph('draft says {{start.input}}'),
  );
  const { runId } = f.run(callerGraph(child.id), 'Caller', 'hello');
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('draft says hello');
  expect(stepsByLabel(done).Sub.output?.result.value).toBe('draft says hello');
  const runs = f.ws.runs.list(child.id);
  expect(runs).toHaveLength(1);
  expect(f.ws.runs.run(runs[0].id)?.parentRunId).toBe(runId);
  expect(f.ws.runs.ancestry(runs[0].id).map((entry) => entry.flowId)).toEqual([
    child.id,
    f.ws.flows.get(done.flowId)!.id,
  ]);
});

it('prefers the published version of a sub-flow over its draft', async () => {
  const f = fixture();
  const child = f.ws.flows.create(
    'Child',
    '',
    childGraph('published says {{start.input}}'),
  );
  const published = f.ws.flows.publish(child.id, 'v1', child.revision);
  f.ws.flows.update(
    child.id,
    { graph: childGraph('draft says {{start.input}}') },
    published.revision,
  );
  const { runId } = f.run(callerGraph(child.id), 'Caller', 'hello');
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('published says hello');
  expect(f.ws.runs.list(child.id)[0].versionId).toBe(
    published.publishedVersionId,
  );
});

it('hands the Run flow input mapping to the child as run-form fields', async () => {
  const f = fixture();
  const child = f.ws.flows.create(
    'Child',
    '',
    childGraph('{{start.topic}} for {{start.input}}'),
  );
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      [
        'Sub',
        'run-flow',
        {
          flow: child.id,
          inputMapping: '{ "topic": "launch", "input": "{{start.input}}" }',
        },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Sub', 'input'],
      ['Sub', 'result', 'Finish', 'value'],
    ],
  );
  const { runId } = f.run(g, 'Caller', 'friday');
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('launch for friday');
});

it('refuses a flow that would run itself, directly or further up the chain', async () => {
  const f = fixture();
  // Direct: the step points at its own flow.
  const direct = f.ws.flows.create('Loop', '', emptyCaller());
  const selfCalling = callerGraph(direct.id);
  f.ws.flows.update(direct.id, { graph: selfCalling }, direct.revision);
  const own = f.platform.runner.create(
    { id: direct.id, name: 'Loop' },
    selfCalling,
    null,
    {
      source: 'manual',
      nodeId: selfCalling.nodes[0].id,
      input: 'x',
    },
  );
  f.platform.runner.start(own.id);
  const looped = await f.finished(own.id);
  expect(looped.status).toBe('failed');
  expect(stepsByLabel(looped).Sub.error).toBe('"Loop" cannot run itself.');
  expect(f.ws.runs.list(direct.id)).toHaveLength(1);

  // Transitive: A runs B, and B runs A again.
  const a = f.ws.flows.create('A', '', emptyCaller());
  const b = f.ws.flows.create('B', '', callerGraph(a.id));
  const aCallsB = callerGraph(b.id);
  f.ws.flows.update(a.id, { graph: aCallsB }, a.revision);
  const first = f.platform.runner.create(
    { id: a.id, name: 'A' },
    aCallsB,
    null,
    { source: 'manual', nodeId: aCallsB.nodes[0].id, input: 'x' },
  );
  f.platform.runner.start(first.id);
  const chained = await f.finished(first.id);
  expect(chained.status).toBe('failed');
  expect(stepsByLabel(chained).Sub.error).toContain('"B" failed');
  const childRun = f.ws.runs.list(b.id)[0];
  expect(f.ws.runs.get(childRun.id)?.error).toContain(
    'is already running further up this chain',
  );
});

function emptyCaller(): FlowGraph {
  return graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Finish', 'finish', {}],
    ],
    [['Start', 'started', 'Finish', 'value']],
  );
}

it('lints a static Run flow cycle when the other flows are in context', () => {
  const a = { id: 'a', graph: callerGraph('b') };
  const b = { id: 'b', graph: callerGraph('a') };
  expect(
    lintFlow(a.graph, { ...lintContext(), flowId: 'a', flows: [a, b] }).some(
      (problem) => problem.code === 'flow-cycle',
    ),
  ).toBe(true);
  // Pointing at itself needs no catalog of flows at all.
  const own = callerGraph('a');
  expect(
    lintFlow(own, { ...lintContext(), flowId: 'a' }).some(
      (problem) => problem.code === 'flow-cycle',
    ),
  ).toBe(true);
  // A flow that only calls a leaf is fine.
  const leaf = { id: 'b', graph: emptyCaller() };
  expect(
    lintFlow(a.graph, { ...lintContext(), flowId: 'a', flows: [a, leaf] }).some(
      (problem) => problem.code === 'flow-cycle',
    ),
  ).toBe(false);
});

/* ---------- For each ---------- */

/** Three pages, so a Read page step can hand the container a real list. */
function listOf(ws: WorkspaceStore, titles: string[]) {
  const space = ws.spaces()[0];
  for (const title of titles)
    ws.pages.create(space.id, { title, content: title, parentId: null });
  return space;
}
function loopGraph(
  spaceId: string,
  loop: Record<string, unknown>,
  second: Record<string, unknown>,
  secondType = 'combine',
): FlowGraph {
  return graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Read', 'read-page', { space: spaceId, mode: 'all' }],
      ['Loop', 'for-each', loop],
      ['First', 'combine', { template: 'Item: {{loop.item.title}}' }, 'Loop'],
      ['Second', secondType, second, 'Loop'],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Read', 'context'],
      ['Read', 'page', 'Loop', 'list'],
      ['Loop', 'item', 'First', 'values'],
      [
        'First',
        'text',
        'Second',
        secondType === 'combine' ? 'values' : 'input',
      ],
      ['Loop', 'results', 'Finish', 'value'],
    ],
  );
}

it('runs a two-step body once per item and collects the results', async () => {
  const f = fixture();
  const space = listOf(f.ws, ['A', 'B', 'C']);
  const g = loopGraph(space.id, {}, { template: 'Seen {{first.text}}' });
  const { runId } = f.run(g, 'Looping flow');
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  const steps = stepsByLabel(done);
  expect(steps.Loop.status).toBe('completed');
  expect(steps.Loop.input).toEqual({ items: 3 });
  expect([...(steps.Loop.output?.results.value as string[])].sort()).toEqual([
    'Seen Item: A',
    'Seen Item: B',
    'Seen Item: C',
  ]);
  // One row per item per body step, grouped by the same iteration key.
  for (const label of ['First', 'Second']) {
    const items = itemSteps(done, label);
    expect(items.map((step) => step.iterationKey)).toEqual(['0', '1', '2']);
    expect(items.every((step) => step.status === 'completed')).toBe(true);
  }
  expect(
    itemSteps(done, 'First')
      .map((step) => String(step.output?.text.value))
      .sort(),
  ).toEqual(['Item: A', 'Item: B', 'Item: C']);
  // The ordinary rows of the body hold every item's output as a list.
  expect(steps.First.status).toBe('completed');
  expect((steps.Second.output?.text.value as string[]).length).toBe(3);
  expect(
    done.events.some((event) =>
      event.text.startsWith('Loop runs 2 steps for each of 3 items'),
    ),
  ).toBe(true);
});

it('caps a For each at its Max items', async () => {
  const f = fixture();
  const space = listOf(f.ws, ['A', 'B', 'C']);
  const g = loopGraph(
    space.id,
    { maxItems: 2 },
    { template: 'Seen {{first.text}}' },
  );
  const { runId } = f.run(g, 'Capped flow');
  const done = await f.finished(runId);
  expect(done.status).toBe('completed');
  expect(
    (stepsByLabel(done).Loop.output?.results.value as unknown[]).length,
  ).toBe(2);
  expect(
    done.events.some(
      (event) => event.text === 'Loop: only the first 2 of 3 items run.',
    ),
  ).toBe(true);
});

it('skips a failing item by default and stops the loop when asked to', async () => {
  const f = fixture();
  // "(" is not a valid pattern, so the Branch inside the body throws for
  // exactly one item.
  const space = listOf(f.ws, ['a', '(', 'b']);
  const build = (onItemError: string) =>
    loopGraph(
      space.id,
      { onItemError },
      {
        field: 'x',
        operator: 'matches',
        value: '{{loop.item.title}}',
      },
      'branch',
    );
  const skipped = await f.finished(f.run(build('skip'), 'Skipping').runId);
  expect(skipped.status).toBe('completed');
  const results = stepsByLabel(skipped).Loop.output?.results.value as unknown[];
  expect(results).toHaveLength(3);
  expect(results.filter((value) => value === null)).toHaveLength(1);
  expect([...results].sort()).toEqual(['Item: a', 'Item: b', null]);
  const failures = itemSteps(skipped, 'Second').filter(
    (step) => step.status === 'failed',
  );
  expect(failures).toHaveLength(1);
  expect(failures[0].error).toContain('is not a valid pattern');
  expect(
    skipped.events.some((event) => /^Loop: item \d failed/.test(event.text)),
  ).toBe(true);

  const stopped = await f.finished(f.run(build('stop'), 'Stopping').runId);
  expect(stopped.status).toBe('failed');
  expect(stepsByLabel(stopped).Loop.status).toBe('failed');
  expect(stepsByLabel(stopped).Loop.error).toContain('is not a valid pattern');
  expect(stepsByLabel(stopped).Finish.status).toBe('skipped');
});

it('lints a container with no body, a crossing edge, and parking inside', () => {
  // The shape the engine tests run has nothing to report about its body.
  const sound = loopGraph('space', {}, { template: 'Seen {{first.text}}' });
  expect(
    lintFlow(sound, { dots: [], spaces: [{ id: 'space' }] })
      .filter((problem) => problem.level === 'error')
      .map((problem) => problem.code),
  ).toEqual([]);

  const empty = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Loop', 'for-each', {}],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Loop', 'list'],
      ['Loop', 'results', 'Finish', 'value'],
    ],
  );
  expect(
    lintFlow(empty, lintContext()).some(
      (problem) => problem.code === 'empty-body',
    ),
  ).toBe(true);

  const crossing = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Loop', 'for-each', {}],
      ['Inner', 'combine', { template: 'x' }, 'Loop'],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Loop', 'list'],
      ['Loop', 'item', 'Inner', 'values'],
      // The body may not reach out of the container itself.
      ['Inner', 'text', 'Finish', 'value'],
    ],
  );
  expect(
    lintFlow(crossing, lintContext()).some(
      (problem) => problem.code === 'container-boundary',
    ),
  ).toBe(true);

  const parking = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Loop', 'for-each', {}],
      ['Review', 'human-review', { message: 'Look' }, 'Loop'],
      ['Inner', 'for-each', {}, 'Loop'],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Loop', 'list'],
      ['Loop', 'item', 'Review', 'draft'],
      ['Loop', 'results', 'Finish', 'value'],
    ],
  );
  const problems = lintFlow(parking, lintContext());
  expect(
    problems.filter((problem) => problem.code === 'body-not-supported'),
  ).toHaveLength(2);
  expect(problems.some((problem) => problem.code === 'nested-container')).toBe(
    true,
  );
});

it('refuses every body step the engine could not run, not just a review', () => {
  // The engine refuses ANY pausing outcome inside a body, so the linter has
  // to name them all: "For each -> Dot task -> Save page" is the most
  // natural loop there is, and Save page asks first by default.
  const body = (label: string, type: string, config: Record<string, unknown>) =>
    lintFlow(
      graph(
        [
          ['Start', 'start', { trigger: 'manual' }],
          ['Loop', 'for-each', {}],
          [label, type, config, 'Loop'],
          ['Finish', 'finish', {}],
        ],
        [
          ['Start', 'started', 'Loop', 'list'],
          ['Loop', 'results', 'Finish', 'value'],
        ],
      ),
      lintContext(),
    ).filter((problem) => problem.code === 'body-not-supported');
  // Save page's "Ask me before saving" defaults to on, so an empty config is
  // already a body that would silently save nothing.
  expect(body('Save', 'save-page', { space: 's1' })).toHaveLength(1);
  expect(body('Save', 'save-page', { space: 's1', review: false })).toEqual([]);
  expect(body('Pause', 'wait', { minutes: 5 })).toHaveLength(1);
  expect(body('Task', 'dot-task', { dot: 'd1', task: 'x' })).toEqual([]);
  expect(
    body('Task', 'dot-task', { dot: 'd1', task: 'x', reviewBeforeSave: true }),
  ).toHaveLength(1);
  // An approval-gated Connected app is an error; "inherit" is a warning,
  // because only the server knows whether that tool asks.
  const always = body('Tool', 'mcp-tool', {
    connection: 'c1',
    tool: 't1',
    approval: 'always',
  });
  expect(always.map((problem) => problem.level)).toEqual(['error']);
  const inherit = body('Tool', 'mcp-tool', {
    connection: 'c1',
    tool: 't1',
    approval: 'inherit',
  });
  expect(inherit.map((problem) => problem.level)).toEqual(['warning']);
  // Control flow belongs to the outer graph.
  expect(body('Inner', 'finish', {})).toHaveLength(1);
  // A step in a loop already runs once per item.
  expect(
    body('Save', 'save-page', { space: 's1', review: false, perItem: true }),
  ).toHaveLength(1);
});

it('refuses a parentId that names something which cannot hold steps', () => {
  const bad = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Host', 'combine', { template: 'a' }],
      ['Orphan', 'combine', { template: 'b' }, 'Host'],
    ],
    [['Start', 'started', 'Host', 'values']],
  );
  // Wired to nothing outside, the only other signal is an `unreachable`
  // warning, which does not block publish — so this has to be an error.
  expect(
    lintFlow(bad, lintContext()).filter(
      (problem) =>
        problem.code === 'invalid-container' && problem.level === 'error',
    ),
  ).toHaveLength(1);
});

/* ---------- Dot team and Computer task ---------- */

it('fails a Dot team step with the setup message when Intelligence is missing', async () => {
  const f = fixture();
  const [manager, ...rest] = f.ws.dots();
  const worker = rest[0] ?? manager;
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      [
        'Team',
        'dot-team',
        {
          manager: manager.id,
          goal: 'Write the digest',
          workers: JSON.stringify([
            { dotId: worker.id, when: 'Checks the numbers' },
          ]),
        },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Team', 'context'],
      ['Team', 'result', 'Finish', 'value'],
    ],
  );
  const done = await f.finished(f.run(g, 'Team flow').runId);
  expect(done.status).toBe('failed');
  expect(stepsByLabel(done).Team.error).toBe(SETUP_REQUIRED_MESSAGE);
  expect(done.error).toContain(SETUP_REQUIRED_MESSAGE);
});

it('fails a Computer task step with the unconfigured computer message', async () => {
  const f = fixture();
  const dot = f.ws.dots()[0];
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      [
        'Browse',
        'computer-task',
        { dot: dot.id, task: 'Open the dashboard', startUrl: 'https://x.test' },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Browse', 'context'],
      ['Browse', 'result', 'Finish', 'value'],
    ],
  );
  expect(f.platform.computers.configured).toBe(false);
  const done = await f.finished(f.run(g, 'Computer flow').runId);
  expect(done.status).toBe('failed');
  expect(stepsByLabel(done).Browse.error).toBe(COMPUTER_UNAVAILABLE_MESSAGE);
});

it('no longer reports the five advanced steps as unavailable', () => {
  for (const type of [
    'wait',
    'run-flow',
    'for-each',
    'dot-team',
    'computer-task',
  ]) {
    const node = makeNode(type, { x: 0, y: 0 }, {});
    const problems = lintFlow(
      { schema: 1, nodes: [node], edges: [] },
      lintContext(),
    );
    expect(problems.some((problem) => problem.code === 'coming-soon')).toBe(
      false,
    );
  }
});
