import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  CANCELLED_MESSAGE,
  fallbackOutput,
  nextScheduleAt,
  readiness,
  renderTokens,
  tokenScope,
  type NodeRun,
} from '../src/server/flow-runner.js';
import {
  FlowRunStore,
  INTERRUPTED_MESSAGE,
} from '../src/server/flow-run-store.js';
import { SETUP_REQUIRED_MESSAGE } from '../src/server/flow-executors.js';
import { makeNode, type FlowGraph } from '../src/shared/flows.js';
import {
  RUN_LIMITS,
  type FlowApproval,
  type FlowRun,
  type RunTrigger,
} from '../src/shared/flow-runs.js';

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
  cleanup.push(() => platform.runner.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  const json = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const createFlow = async (graph: FlowGraph, name = 'Test flow') => {
    const response = await app.request(
      'http://localhost/api/flows',
      json({ name, graph }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const startRun = async (flowId: string, input: string) => {
    const response = await app.request(
      `http://localhost/api/flows/${flowId}/runs`,
      json({ input }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as FlowRun;
  };
  const getRun = async (runId: string) =>
    (await (
      await app.request(`http://localhost/api/flows/runs/${runId}`)
    ).json()) as FlowRun;
  const finished = async (runId: string) => {
    await platform.runner.settled(runId);
    return getRun(runId);
  };
  const waiting = async (runId: string) =>
    until(async () => {
      const run = await getRun(runId);
      return run.status === 'waiting' ? run : undefined;
    });
  const approvals = async () =>
    (await (
      await app.request('http://localhost/api/flows/approvals')
    ).json()) as FlowApproval[];
  const decide = (id: string, body: unknown) =>
    app.request(
      `http://localhost/api/flows/approvals/${id}/decide`,
      json(body),
    );
  return {
    ws,
    platform,
    app,
    json,
    createFlow,
    startRun,
    getRun,
    finished,
    waiting,
    approvals,
    decide,
  };
}
async function until<T>(
  probe: () => Promise<T | undefined>,
  ms = 3000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Builds a graph from labelled nodes; labels double as token slugs. */
function graph(
  nodes: [label: string, type: string, config?: Record<string, unknown>][],
  edges: [from: string, port: string, to: string, input: string][],
): FlowGraph {
  const built = new Map(
    nodes.map(([label, type, config], index) => {
      const node = makeNode(type, { x: index * 300, y: 100 }, config ?? {});
      node.label = label;
      return [label, node];
    }),
  );
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

it('runs Start -> Combine -> Branch -> Finish with rendered tokens', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Combine', 'combine', { template: 'Topic: {{start.input}}' }],
        [
          'Branch',
          'branch',
          { field: '{{combine.text}}', operator: 'contains', value: 'topic' },
        ],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Combine', 'values'],
        ['Combine', 'text', 'Branch', 'input'],
        ['Branch', 'yes', 'Finish', 'value'],
      ],
    ),
  );
  const started = await f.startRun(flow.id, 'launch');
  expect(['queued', 'running', 'completed']).toContain(started.status);
  const run = await f.finished(started.id);
  expect(run.status).toBe('completed');
  expect(run.result?.text).toBe('Topic: launch');
  const steps = stepsByLabel(run);
  expect(steps.Combine.output?.text.value).toBe('Topic: launch');
  expect(steps.Branch.output).toHaveProperty('yes');
  expect(steps.Branch.output).not.toHaveProperty('no');
  expect(run.steps.every((step) => step.status === 'completed')).toBe(true);
  expect(run.completedSteps).toBe(4);
  const texts = run.events.map((event) => event.text);
  expect(texts[0]).toBe('Run started by hand.');
  expect(texts.at(-1)).toBe('Run completed.');
  expect(texts.some((text) => text.startsWith('Combine completed'))).toBe(true);
  const list = (await (
    await f.app.request(`http://localhost/api/flows/${flow.id}/runs`)
  ).json()) as { id: string }[];
  expect(list.map((item) => item.id)).toEqual([run.id]);
});

it('skips the untaken arm of a Branch and still reaches Finish', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        [
          'Branch',
          'branch',
          { field: '{{start.input}}', operator: 'equals', value: 'yes' },
        ],
        ['Pos', 'combine', { template: 'yes: {{start.input}}' }],
        ['Neg', 'combine', { template: 'no: {{start.input}}' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Branch', 'input'],
        ['Branch', 'yes', 'Pos', 'values'],
        ['Branch', 'no', 'Neg', 'values'],
        ['Pos', 'text', 'Finish', 'value'],
        ['Neg', 'text', 'Finish', 'value'],
      ],
    ),
  );
  const run = await f.finished((await f.startRun(flow.id, 'nope')).id);
  expect(run.status).toBe('completed');
  const steps = stepsByLabel(run);
  expect(steps.Pos.status).toBe('skipped');
  expect(steps.Neg.status).toBe('completed');
  expect(steps.Finish.status).toBe('completed');
  expect(run.result?.text).toBe('no: nope');
  expect(
    run.events.some(
      (event) => event.text === 'Pos was skipped: no input arrived.',
    ),
  ).toBe(true);
});

it('parks on Human review, then resumes on approve or routes the declined arm', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        [
          'Review',
          'human-review',
          { message: 'Check {{start.input}}', requireFeedback: true },
        ],
        ['Declined', 'combine', { template: 'declined: {{review.declined}}' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Review', 'draft'],
        ['Review', 'approved', 'Finish', 'value'],
        ['Review', 'declined', 'Declined', 'values'],
        ['Declined', 'text', 'Finish', 'value'],
      ],
    ),
  );
  // Approve, with an edit.
  const first = await f.waiting((await f.startRun(flow.id, 'draft one')).id);
  expect(first.waitingNodeId).toBe(stepsByLabel(first).Review.nodeId);
  expect(stepsByLabel(first).Review.status).toBe('waiting');
  let pending = await f.approvals();
  expect(pending).toHaveLength(1);
  expect(pending[0].kind).toBe('review');
  expect(pending[0].payload.message).toBe('Check draft one');
  expect(pending[0].payload.draft).toBe('draft one');
  expect(pending[0].payload.actions).toEqual(['approve', 'changes', 'decline']);
  const approved = await f.decide(pending[0].id, {
    action: 'approve',
    editedText: 'edited draft',
  });
  expect(approved.status).toBe(200);
  const done = await f.finished(first.id);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('edited draft');
  expect(stepsByLabel(done).Declined.status).toBe('skipped');
  expect(done.approvals[0].status).toBe('approved');
  // A second decision on the same review is refused.
  expect((await f.decide(pending[0].id, { action: 'approve' })).status).toBe(
    409,
  );
  // Decline requires a note, then routes the Declined arm.
  const second = await f.waiting((await f.startRun(flow.id, 'draft two')).id);
  pending = await f.approvals();
  expect(pending).toHaveLength(1);
  expect(pending[0].runId).toBe(second.id);
  expect((await f.decide(pending[0].id, { action: 'decline' })).status).toBe(
    400,
  );
  expect(
    (await f.decide(pending[0].id, { action: 'decline', feedback: 'not yet' }))
      .status,
  ).toBe(200);
  const declined = await f.finished(second.id);
  expect(declined.status).toBe('completed');
  expect(declined.result?.text).toBe('declined: not yet');
  expect(stepsByLabel(declined).Review.output).toHaveProperty('declined');
  expect(await f.approvals()).toHaveLength(0);
});

it('saves a page directly with review off and waits for approval with review on', async () => {
  const f = fixture();
  const space = f.ws.spaces()[0];
  const build = (review: boolean) =>
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Draft', 'combine', { template: '{{start.input}}' }],
        [
          'Save',
          'save-page',
          {
            space: space.id,
            mode: 'create',
            title: 'Note {{start.input}}',
            review,
          },
        ],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Draft', 'values'],
        ['Draft', 'text', 'Save', 'content'],
        ['Save', 'saved', 'Finish', 'value'],
      ],
    );
  const direct = await f.createFlow(build(false), 'Direct');
  const run = await f.finished((await f.startRun(direct.id, 'hello')).id);
  expect(run.status).toBe('completed');
  let pages = f.ws.pages.list(space.id);
  expect(pages).toHaveLength(1);
  expect(pages[0].title).toBe('Note hello');
  expect(pages[0].content).toBe('hello');
  expect(run.result?.text).toBe(
    `Note hello (#/spaces/${space.id}/pages/${pages[0].id})`,
  );

  const reviewed = await f.createFlow(build(true), 'Reviewed');
  const parked = await f.waiting((await f.startRun(reviewed.id, 'later')).id);
  expect(stepsByLabel(parked).Save.status).toBe('waiting');
  const [approval] = await f.approvals();
  expect(approval.kind).toBe('page');
  expect(approval.payload.pageTitle).toBe('Note later');
  expect(approval.payload.spaceId).toBe(space.id);
  expect(f.ws.pages.list(space.id)).toHaveLength(1);
  expect(
    (await f.decide(approval.id, { action: 'approve', editedText: 'polished' }))
      .status,
  ).toBe(200);
  const saved = await f.finished(parked.id);
  expect(saved.status).toBe('completed');
  pages = f.ws.pages.list(space.id);
  expect(pages).toHaveLength(2);
  expect(pages[1].title).toBe('Note later');
  expect(pages[1].content).toBe('polished');
});

it('fails a Dot task without Intelligence and continues when asked to', async () => {
  const f = fixture();
  const dot = f.ws.dots()[0];
  const build = (onError: string) =>
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        [
          'Writer',
          'dot-task',
          { dot: dot.id, task: 'Write about {{start.input}}', onError },
        ],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Writer', 'context'],
        ['Writer', 'result', 'Finish', 'value'],
      ],
    );
  const lenient = await f.createFlow(build('continue'), 'Lenient');
  const run = await f.finished((await f.startRun(lenient.id, 'cats')).id);
  expect(run.status).toBe('completed');
  const writer = stepsByLabel(run).Writer;
  expect(writer.status).toBe('failed');
  expect(writer.error).toBe(SETUP_REQUIRED_MESSAGE);
  expect(stepsByLabel(run).Finish.status).toBe('completed');
  expect(run.result?.text).toBe('');

  const strict = await f.createFlow(build('stop'), 'Strict');
  const failed = await f.finished((await f.startRun(strict.id, 'cats')).id);
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain(SETUP_REQUIRED_MESSAGE);
  expect(stepsByLabel(failed).Finish.status).toBe('skipped');
});

it('cancels a run that is waiting on a person', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Review', 'human-review', { message: 'Look' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Review', 'draft'],
        ['Review', 'approved', 'Finish', 'value'],
      ],
    ),
  );
  const parked = await f.waiting((await f.startRun(flow.id, 'x')).id);
  const response = await f.app.request(
    `http://localhost/api/flows/runs/${parked.id}/cancel`,
    f.json({}),
  );
  expect(response.status).toBe(200);
  const cancelled = (await response.json()) as FlowRun;
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.finishedAt).not.toBeNull();
  expect(cancelled.approvals[0].status).toBe('expired');
  expect(await f.approvals()).toHaveLength(0);
  expect(cancelled.events.at(-1)?.text).toBe('Run cancelled.');
  // The review did not fail; the run ended around it.
  expect(stepsByLabel(cancelled).Review.status).toBe('skipped');
  expect(stepsByLabel(cancelled).Review.error).toBe(CANCELLED_MESSAGE);
  expect(
    (
      await f.app.request(
        'http://localhost/api/flows/runs/missing/cancel',
        f.json({}),
      )
    ).status,
  ).toBe(404);
});

it('runs a per-item step once per element of a list', async () => {
  const f = fixture();
  const space = f.ws.spaces()[0];
  for (const title of ['A', 'B', 'C'])
    f.ws.pages.create(space.id, {
      title,
      content: `Body ${title}`,
      parentId: null,
    });
  const g = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Read', 'read-page', { space: space.id, mode: 'all' }],
      [
        'Save',
        'save-page',
        { space: space.id, mode: 'create', review: false, perItem: true },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Read', 'context'],
      ['Read', 'page', 'Save', 'content'],
      ['Save', 'saved', 'Finish', 'value'],
    ],
  );
  // The json -> text edge is a lint error for the editor, so this goes
  // straight through the runner rather than the manual-run route.
  const flow = f.ws.flows.create('Per item', '', g);
  const trigger: RunTrigger = {
    source: 'manual',
    nodeId: g.nodes[0].id,
    input: '',
  };
  const record = f.platform.runner.create(flow, g, null, trigger);
  f.platform.runner.start(record.id);
  const run = await f.finished(record.id);
  expect(run.status).toBe('completed');
  const items = run.steps.filter(
    (step) => step.label === 'Save' && step.iterationKey !== '',
  );
  expect(items.map((step) => step.iterationKey).sort()).toEqual([
    '0',
    '1',
    '2',
  ]);
  expect(items.every((step) => step.status === 'completed')).toBe(true);
  const saved = stepsByLabel(run).Save.output?.saved;
  expect(saved?.kind).toBe('json');
  expect(Array.isArray(saved?.value) && saved.value.length).toBe(3);
  expect(f.ws.pages.list(space.id)).toHaveLength(6);
  expect(
    run.events.some((event) => event.text === 'Save runs once per item (3).'),
  ).toBe(true);
});

it('rejects runs of flows with lint errors and unknown flows', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Writer', 'dot-task', { task: 'x' }],
      ],
      [['Start', 'started', 'Writer', 'context']],
    ),
  );
  const response = await f.app.request(
    `http://localhost/api/flows/${flow.id}/runs`,
    f.json({ input: 'x' }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { problems: { code: string }[] };
  expect(body.problems.some((p) => p.code === 'missing-config')).toBe(true);
  expect(
    (await f.app.request('http://localhost/api/flows/nope/runs', f.json({})))
      .status,
  ).toBe(404);
});

it('registers triggers on publish and accepts webhook calls with the token', async () => {
  const f = fixture();
  const g = graph(
    [
      ['Hook', 'start', { trigger: 'webhook' }],
      [
        'Combine',
        'combine',
        { template: 'got {{hook.input}} for {{hook.topic}}' },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Hook', 'started', 'Combine', 'values'],
      ['Combine', 'text', 'Finish', 'value'],
    ],
  );
  const flow = await f.createFlow(g);
  const hookUrl = `http://localhost/api/flows/${flow.id}/hooks/${g.nodes[0].id}`;
  // Unpublished flows do not accept calls.
  expect((await f.app.request(hookUrl, f.json({}))).status).toBe(404);
  const published = await f.app.request(
    `http://localhost/api/flows/${flow.id}/publish`,
    f.json({ revision: 1 }),
  );
  expect(published.status).toBe(200);
  const triggers = f.ws.runs.triggers(flow.id);
  expect(triggers.map((row) => row.kind)).toEqual(['webhook']);
  const token = f.ws.runs.webhookToken(flow.id);
  expect(token).toBeTruthy();
  expect((await f.app.request(hookUrl, f.json({ input: 'x' }))).status).toBe(
    401,
  );
  const accepted = await f.app.request(hookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token! },
    body: JSON.stringify({ input: 'ping', topic: 'cats' }),
  });
  expect(accepted.status).toBe(202);
  const { runId } = (await accepted.json()) as { runId: string };
  const run = await f.finished(runId);
  expect(run.status).toBe('completed');
  expect(run.trigger.source).toBe('webhook');
  expect(run.result?.text).toBe('got ping for cats');
  // Unpublishing clears the registry.
  await f.app.request(
    `http://localhost/api/flows/${flow.id}/unpublish`,
    f.json({}),
  );
  expect(f.ws.runs.triggers(flow.id)).toHaveLength(0);
});

it('readiness, token rendering and schedules behave as pure helpers', () => {
  const edges = {
    edges: [
      {
        id: 'a',
        source: 'x',
        sourceHandle: 'yes',
        target: 'z',
        targetHandle: 'v',
      },
      {
        id: 'b',
        source: 'y',
        sourceHandle: 'text',
        target: 'z',
        targetHandle: 'v',
      },
    ],
  };
  const states = new Map<string, NodeRun>([
    ['x', { state: 'completed', output: { no: { kind: 'any', value: 1 } } }],
    ['y', { state: 'running', output: null }],
  ]);
  expect(readiness(edges, 'z', states, 'all')).toBe('wait');
  expect(readiness(edges, 'z', states, 'first')).toBe('wait');
  states.set('y', {
    state: 'completed',
    output: { text: { kind: 'text', value: 'hi' } },
  });
  expect(readiness(edges, 'z', states, 'all')).toBe('ready');
  states.set('y', { state: 'skipped', output: null });
  expect(readiness(edges, 'z', states, 'all')).toBe('skip');
  expect(readiness(edges, 'missing', states, 'all')).toBe('skip');

  const g = graph(
    [
      ['Start', 'start', {}],
      ['Editor', 'dot-task', { dot: 'd', task: 't' }],
      ['Next', 'combine', {}],
    ],
    [
      ['Start', 'started', 'Editor', 'context'],
      ['Editor', 'data', 'Next', 'values'],
    ],
  );
  const outputs = new Map([
    [
      g.nodes[1].id,
      {
        data: { kind: 'json' as const, value: { score: 7, tags: ['a', 'b'] } },
      },
    ],
  ]);
  const scope = tokenScope(
    g,
    g.nodes[2].id,
    {
      source: 'manual',
      nodeId: g.nodes[0].id,
      input: 'topic',
      fields: { audience: 'devs' },
    },
    (id) => outputs.get(id),
  );
  const missing: string[] = [];
  expect(
    renderTokens(
      '{{start.input}}/{{start.audience}}/{{editor.data.score}}/{{editor.data.tags.1}}/{{editor.result}}/{{nobody.x}}',
      scope,
      (token) => missing.push(token),
    ),
  ).toBe('topic/devs/7/b//');
  expect(missing).toEqual(['{{editor.result}}', '{{nobody.x}}']);

  const now = Date.UTC(2026, 0, 5, 12, 0, 0);
  expect(nextScheduleAt({ schedule: 3600 }, now)).toBe(now + 3_600_000);
  const weekday = new Date(
    nextScheduleAt({ scheduleDays: 'weekdays', scheduleAt: '09:00' }, now),
  );
  expect(weekday.getTime()).toBeGreaterThan(now);
  expect([1, 2, 3, 4, 5]).toContain(weekday.getDay());
  expect(weekday.getHours()).toBe(9);
});

it('deleting a flow drops its runs, approvals and triggers, waiting runs included', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Review', 'human-review', { message: 'Look' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Review', 'draft'],
        ['Review', 'approved', 'Finish', 'value'],
      ],
    ),
  );
  const parked = await f.waiting((await f.startRun(flow.id, 'x')).id);
  const [approval] = await f.approvals();
  expect(approval.runId).toBe(parked.id);
  const deleted = await f.app.request(`http://localhost/api/flows/${flow.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(deleted.status).toBe(200);
  // The run is gone from the API and the engine, and the review with it.
  expect(
    (await f.app.request(`http://localhost/api/flows/runs/${parked.id}`))
      .status,
  ).toBe(404);
  expect(await f.approvals()).toHaveLength(0);
  await f.platform.runner.settled(parked.id);
  expect((await f.decide(approval.id, { action: 'approve' })).status).toBe(404);
  expect(f.ws.runs.list(flow.id)).toHaveLength(0);
  expect(f.ws.runs.triggers(flow.id)).toHaveLength(0);
  expect(f.ws.runs.steps(parked.id)).toHaveLength(0);
});

it('records each attempt of a retried step on its own row', async () => {
  const f = fixture();
  const dot = f.ws.dots()[0];
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        [
          'Writer',
          'dot-task',
          { dot: dot.id, task: 'Write', onError: 'retry' },
        ],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Writer', 'context'],
        ['Writer', 'result', 'Finish', 'value'],
      ],
    ),
  );
  const run = await f.finished((await f.startRun(flow.id, 'x')).id);
  expect(run.status).toBe('failed');
  const attempts = run.steps.filter((step) => step.label === 'Writer');
  expect(attempts.map((step) => step.attempt)).toEqual([1, 2]);
  for (const step of attempts) {
    expect(step.status).toBe('failed');
    expect(step.error).toBe(SETUP_REQUIRED_MESSAGE);
    expect(step.durationMs).not.toBeNull();
  }
  expect(attempts[1].startedAt).toBeGreaterThanOrEqual(attempts[0].finishedAt!);
  expect(run.events.some((e) => e.text.includes('retrying once'))).toBe(true);
});

it('continues down the fallback arm only when an exclusive step fails', async () => {
  const f = fixture();
  const dot = f.ws.dots()[0];
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        [
          'Sort',
          'dot-decide',
          {
            dot: dot.id,
            question: 'Which?',
            branches: 'Good, Bad',
            onError: 'continue',
          },
        ],
        ['Good', 'combine', { template: 'good' }],
        ['Bad', 'combine', { template: 'bad' }],
        ['Other', 'combine', { template: 'other' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Sort', 'input'],
        ['Sort', 'branch:Good', 'Good', 'values'],
        ['Sort', 'branch:Bad', 'Bad', 'values'],
        ['Sort', 'otherwise', 'Other', 'values'],
        ['Good', 'text', 'Finish', 'value'],
        ['Bad', 'text', 'Finish', 'value'],
        ['Other', 'text', 'Finish', 'value'],
      ],
    ),
  );
  const run = await f.finished((await f.startRun(flow.id, 'x')).id);
  expect(run.status).toBe('completed');
  const steps = stepsByLabel(run);
  expect(steps.Sort.status).toBe('failed');
  expect(Object.keys(steps.Sort.output ?? {})).toEqual(['otherwise']);
  expect(steps.Good.status).toBe('skipped');
  expect(steps.Bad.status).toBe('skipped');
  expect(steps.Other.status).toBe('completed');
  expect(run.result?.text).toBe('other');
});

it('a clean stop leaves a run waiting on a person; the decision resumes it later', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Review', 'human-review', { message: 'Look' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Review', 'draft'],
        ['Review', 'approved', 'Finish', 'value'],
      ],
    ),
  );
  const parked = await f.waiting((await f.startRun(flow.id, 'draft')).id);
  f.platform.runner.stop();
  // Nothing was in flight, so the run and its review survive the shutdown.
  const after = await f.getRun(parked.id);
  expect(after.status).toBe('waiting');
  expect(stepsByLabel(after).Review.status).toBe('waiting');
  const pending = await f.approvals();
  expect(pending).toHaveLength(1);
  // The decision rebuilds the execution from the tables and carries on.
  expect((await f.decide(pending[0].id, { action: 'approve' })).status).toBe(
    200,
  );
  const done = await f.finished(parked.id);
  expect(done.status).toBe('completed');
  expect(done.result?.text).toBe('draft');
  const review = stepsByLabel(done).Review;
  expect(review.startedAt).toBe(stepsByLabel(after).Review.startedAt);
  expect(review.durationMs).not.toBeNull();
});

it('boot recovery closes stranded runs, their open steps and reviews, and keeps waiting runs', () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  db.exec('CREATE TABLE flows(id TEXT PRIMARY KEY)');
  const store = new FlowRunStore(db);
  const trigger: RunTrigger = { source: 'manual', nodeId: 's', input: '' };
  const make = () =>
    store.create({
      flowId: 'f1',
      flowName: 'Flow',
      versionId: null,
      graph: { schema: 1, nodes: [], edges: [] },
      trigger,
      steps: [
        { nodeId: 'a', nodeType: 'combine', label: 'A' },
        { nodeId: 'b', nodeType: 'human-review', label: 'B' },
      ],
    });
  const step = (
    runId: string,
    nodeId: string,
    status: 'running' | 'waiting',
    startedAt: number,
  ) =>
    store.saveStep({
      runId,
      nodeId,
      nodeType: 'combine',
      label: nodeId,
      status,
      startedAt,
    });
  const review = (runId: string) =>
    store.createApproval({
      runId,
      flowId: 'f1',
      nodeId: 'b',
      kind: 'review',
      title: 'B',
      payload: {
        message: '',
        draft: '',
        allowEdits: true,
        actions: ['approve', 'decline'],
        requireFeedback: false,
      },
    });
  // A run with one step in flight and one review beside it.
  const stranded = make();
  store.setStatus(stranded.id, 'running');
  step(stranded.id, 'a', 'running', Date.now() - 50);
  step(stranded.id, 'b', 'waiting', Date.now() - 50);
  review(stranded.id);
  // A run that was only waiting on a person.
  const parked = make();
  step(parked.id, 'b', 'waiting', Date.now() - 50);
  store.setStatus(parked.id, 'waiting', { waitingNodeId: 'b' });
  review(parked.id);

  const reopened = new FlowRunStore(db);
  const interrupted = reopened.get(stranded.id)!;
  expect(interrupted.status).toBe('interrupted');
  expect(interrupted.error).toBe(INTERRUPTED_MESSAGE);
  for (const row of interrupted.steps) {
    expect(row.status).toBe('failed');
    expect(row.error).toBe(INTERRUPTED_MESSAGE);
    expect(row.durationMs).toBeGreaterThanOrEqual(50);
  }
  expect(interrupted.approvals[0].status).toBe('expired');
  const kept = reopened.get(parked.id)!;
  expect(kept.status).toBe('waiting');
  expect(kept.steps.find((row) => row.nodeId === 'b')?.status).toBe('waiting');
  expect(reopened.pendingApprovals().map((a) => a.runId)).toEqual([parked.id]);

  // A later write without a start time keeps the recorded one and still
  // yields a duration.
  reopened.saveStep({
    runId: parked.id,
    nodeId: 'b',
    nodeType: 'combine',
    label: 'b',
    status: 'completed',
    startedAt: null,
    finishedAt: Date.now(),
  });
  const resumed = reopened.steps(parked.id).find((row) => row.nodeId === 'b')!;
  expect(resumed.startedAt).toBe(
    kept.steps.find((row) => row.nodeId === 'b')?.startedAt,
  );
  expect(resumed.durationMs).toBeGreaterThanOrEqual(50);

  // Events are trimmed to the contract's cap as they are written.
  for (let i = 0; i < RUN_LIMITS.events + 5; i++)
    reopened.event(parked.id, null, 'log', `event ${i}`);
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM flow_run_events WHERE runId=?')
    .get(parked.id) as { n: number };
  expect(count.n).toBe(RUN_LIMITS.events);
  expect(reopened.get(parked.id)!.events.at(-1)?.text).toBe(
    `event ${RUN_LIMITS.events + 4}`,
  );

  // "One thread per key" conversations are remembered per flow and Dot.
  reopened.saveKeyedThread('f1', 'd1', 'customer-7', 't1');
  expect(reopened.keyedThread('f1', 'd1', 'customer-7')).toBe('t1');
  reopened.saveKeyedThread('f1', 'd1', 'customer-7', 't2');
  expect(reopened.keyedThread('f1', 'd1', 'customer-7')).toBe('t2');
  reopened.removeFlow('f1');
  expect(reopened.keyedThread('f1', 'd1', 'customer-7')).toBeUndefined();
});

it('fallbackOutput takes one arm for exclusive steps and every port otherwise', () => {
  const ports = (node: ReturnType<typeof makeNode>) =>
    Object.keys(fallbackOutput(node));
  expect(ports(makeNode('branch', { x: 0, y: 0 }))).toEqual(['no']);
  expect(ports(makeNode('human-review', { x: 0, y: 0 }))).toEqual(['declined']);
  expect(ports(makeNode('save-page', { x: 0, y: 0 }))).toEqual(['declined']);
  expect(
    ports(makeNode('dot-decide', { x: 0, y: 0 }, { branches: 'A, B' })),
  ).toEqual(['otherwise']);
  expect(
    ports(
      makeNode(
        'dot-decide',
        { x: 0, y: 0 },
        { branches: 'A, B', otherwise: false },
      ),
    ),
  ).toEqual([]);
  expect(ports(makeNode('web-research', { x: 0, y: 0 }))).toEqual([
    'findings',
    'sources',
  ]);
  expect(
    fallbackOutput(makeNode('web-research', { x: 0, y: 0 })).sources,
  ).toEqual({ kind: 'json', value: null });
});
