/**
 * The Reviews inbox: the page itself, the live inbox's polling and decision
 * wiring, and the two cross-flow server routes it reads
 * (GET /flows/approvals with its inbox context, GET /flows/runs).
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({
  api,
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
import {
  FlowRunsActivity,
  REVIEWS_ROUTE,
  ReviewsInbox,
  ReviewsPage,
  waitedLabel,
} from '../src/client/flows/ReviewsInbox';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { makeNode, type FlowGraph } from '../src/shared/flows.js';
import type {
  FlowApproval,
  FlowRun,
  FlowRunSummary,
} from '../src/shared/flow-runs';

/* ---------- client fixtures ---------- */

/**
 * The two pure components are asserted on their markup; these three helpers
 * are for the handful of cases that need a real click, and keep the act
 * environment local to them.
 */
function render(element: ReactElement): ReactTestRenderer {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}
function click(
  tree: ReactTestRenderer,
  match: (node: ReactTestInstance) => boolean | undefined,
) {
  const button = tree.root
    .findAll((node) => node.type === 'button')
    .find((node) => match(node));
  if (!button) throw new Error('No matching button.');
  act(() => {
    (button.props as { onClick: () => void }).onClick();
  });
}
function unmount(tree: ReactTestRenderer) {
  act(() => tree.unmount());
  vi.unstubAllGlobals();
}

const NOW = 1_700_000_000_000;
const review = (over: Partial<FlowApproval> = {}): FlowApproval => ({
  id: 'a1',
  runId: 'r1',
  flowId: 'f1',
  nodeId: 'n2',
  kind: 'review',
  title: 'Review the digest',
  payload: {
    message: 'Please check the numbers.',
    draft: 'Draft text',
    allowEdits: false,
    actions: ['approve', 'changes', 'decline'],
    requireFeedback: true,
  },
  status: 'pending',
  editedText: null,
  feedback: null,
  createdAt: NOW - 300_000,
  decidedAt: null,
  context: {
    flowName: 'Monday digest',
    nodeLabel: 'Editor sign-off',
    runStartedAt: NOW - 320_000,
    trigger: 'schedule',
  },
  ...over,
});

/* ---------- the page ---------- */

describe('ReviewsPage', () => {
  it('renders a pending review with its flow, step, wait and decisions', () => {
    const html = renderToStaticMarkup(
      <ReviewsPage
        reviews={[review()]}
        loaded
        now={NOW}
        onDecide={() => {}}
        onOpenFlow={() => {}}
      />,
    );
    expect(html).toContain('Reviews');
    expect(html).toContain('Monday digest');
    expect(html).toContain('Editor sign-off');
    expect(html).toContain('Waiting 5m 00s');
    expect(html).toContain('On a schedule');
    expect(html).toContain('1 waiting');
    expect(html).toContain('Open flow');
    // The card is named for screen readers by the flow it belongs to.
    expect(html).toContain('aria-labelledby="a1-flow"');
    // The editor's own decision card, with the same three choices.
    expect(html).toContain('Review the digest');
    expect(html).toContain('Please check the numbers.');
    expect(html).toContain('Draft text');
    expect(html).toContain('Approve');
    expect(html).toContain('Request changes');
    expect(html).toContain('Decline');
    expect(html).not.toContain('Nothing waiting on you.');
  });

  it('opens a review with the parked run, so the editor can restore it', () => {
    const opened: [string, string][] = [];
    const tree = render(
      <ReviewsPage
        reviews={[review()]}
        loaded
        now={NOW}
        onDecide={() => {}}
        onOpenFlow={(flowId, runId) => opened.push([flowId, runId])}
      />,
    );
    click(tree, (node) =>
      (node.props as { className?: string }).className?.includes(
        'flow-review-open',
      ),
    );
    expect(opened).toEqual([['f1', 'r1']]);
    unmount(tree);
  });

  it('falls back to the approval title when a run carries no context', () => {
    const html = renderToStaticMarkup(
      <ReviewsPage
        reviews={[review({ context: undefined })]}
        loaded
        now={NOW}
        onDecide={() => {}}
        onOpenFlow={() => {}}
      />,
    );
    expect(html).toContain('A flow');
    expect(html).toContain('Review the digest');
  });

  it('shows the empty state only once the list has loaded', () => {
    const empty = {
      reviews: [],
      now: NOW,
      onDecide: () => {},
      onOpenFlow: () => {},
    };
    expect(renderToStaticMarkup(<ReviewsPage {...empty} loaded />)).toContain(
      'Nothing waiting on you.',
    );
    expect(
      renderToStaticMarkup(<ReviewsPage {...empty} loaded={false} />),
    ).not.toContain('Nothing waiting on you.');
  });

  it('labels how long a review has waited', () => {
    expect(waitedLabel(NOW - 4_000, NOW)).toBe('Waiting 4.0s');
    expect(waitedLabel(NOW - 7_400_000, NOW)).toBe('Waiting 2h 03m');
    // A clock that runs ahead of the server reads as a brand-new review.
    expect(waitedLabel(NOW + 1_000, NOW)).toBe('Waiting 0.0s');
    expect(REVIEWS_ROUTE).toBe('#/reviews');
  });
});

describe('FlowRunsActivity', () => {
  const run = (over: Partial<FlowRunSummary> = {}): FlowRunSummary => ({
    id: 'r1',
    flowId: 'f1',
    flowName: 'Monday digest',
    versionId: null,
    status: 'waiting',
    trigger: { source: 'manual', nodeId: 's1', input: '' },
    error: null,
    waitingNodeId: 'n2',
    startedAt: Date.now() - 125_000,
    finishedAt: null,
    stepCount: 4,
    completedSteps: 2,
    ...over,
  });
  it('renders status, flow, trigger, timing and step progress', () => {
    const html = renderToStaticMarkup(
      <FlowRunsActivity runs={[run()]} loaded onOpen={() => {}} />,
    );
    expect(html).toContain('Flow runs');
    expect(html).toContain('Waiting for a person');
    expect(html).toContain('Monday digest');
    expect(html).toContain('Manual');
    expect(html).toContain('2m ago');
    expect(html).toContain('2m 05s');
    expect(html).toContain('2/4 steps');
  });
  it('opens the run that was clicked, not just its flow', () => {
    const opened: [string, string][] = [];
    const tree = render(
      <FlowRunsActivity
        runs={[run()]}
        loaded
        onOpen={(flowId, runId) => opened.push([flowId, runId])}
      />,
    );
    click(tree, () => true);
    expect(opened).toEqual([['f1', 'r1']]);
    unmount(tree);
  });
  it('explains an empty list without claiming it is still loading', () => {
    expect(
      renderToStaticMarkup(
        <FlowRunsActivity runs={[]} loaded onOpen={() => {}} />,
      ),
    ).toContain('No flow has run yet.');
    expect(
      renderToStaticMarkup(
        <FlowRunsActivity runs={[]} loaded={false} onOpen={() => {}} />,
      ),
    ).toContain('Loading flow runs…');
  });
});

/* ---------- the live inbox ---------- */

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

describe('ReviewsInbox', () => {
  let root: ReactTestRenderer;
  let pending: FlowApproval[];
  const changed = vi.fn();
  const polls = () =>
    api.mock.calls.filter(([path]) => path === '/flows/approvals');
  const press = async (label: string) => {
    const button = root.root
      .findAll((node) => node.type === 'button')
      .find((node) => textOf(node).includes(label));
    if (!button) throw new Error(`No "${label}" button on the inbox.`);
    await act(async () => {
      (button.props as { onClick: () => void }).onClick();
    });
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    api.mockReset();
    changed.mockReset();
    pending = [review()];
    api.mockImplementation(async (path: string, method = 'GET') => {
      if (path === '/flows/approvals' && method === 'GET') return pending;
      if (path === '/flows/approvals/a1/decide' && method === 'POST') {
        pending = [];
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    await act(async () => {
      root = create(<ReviewsInbox onOpenFlow={() => {}} onCount={changed} />);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the pending list on mount and polls it every 10 s', async () => {
    expect(polls()).toHaveLength(1);
    expect(textOf(root.root)).toContain('Monday digest');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(polls()).toHaveLength(3);
    await act(async () => root.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(polls()).toHaveLength(3);
    // afterEach unmounts again; make that a no-op.
    await act(async () => {
      root = create(<div />);
    });
  });

  it('decides a review, refreshes the list and reports the new count', async () => {
    // The count comes from the poll the inbox already makes, so the badge
    // needs no request of its own: one load, then one after the decision.
    expect(changed).toHaveBeenLastCalledWith(1);
    await press('Approve');
    expect(api).toHaveBeenCalledWith('/flows/approvals/a1/decide', 'POST', {
      action: 'approve',
    });
    expect(polls()).toHaveLength(2);
    expect(changed).toHaveBeenLastCalledWith(0);
    expect(textOf(root.root)).toContain('Nothing waiting on you.');
  });

  it('surfaces a failed load inline', async () => {
    api.mockRejectedValueOnce(new Error('Could not reach the server.'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(textOf(root.root)).toContain('Could not reach the server.');
  });
});

/* ---------- the routes ---------- */

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

/** The in-memory server fixture of tests/flow-runner.test.ts, trimmed. */
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
  const createFlow = async (graph: FlowGraph, name: string) => {
    const response = await app.request(
      'http://localhost/api/flows',
      json({ name, graph }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const startRun = async (flowId: string, input = '') => {
    const response = await app.request(
      `http://localhost/api/flows/${flowId}/runs`,
      json({ input }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as FlowRun;
  };
  const get = async <T,>(path: string) => {
    const response = await app.request(`http://localhost/api${path}`);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  return { app, platform, createFlow, startRun, get };
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

it('enriches pending approvals with the context the inbox renders', async () => {
  const f = fixture();
  const flow = await f.createFlow(
    graph(
      [
        ['Start', 'start', { trigger: 'manual' }],
        ['Editor sign-off', 'human-review', { message: 'Look at this' }],
        ['Finish', 'finish', {}],
      ],
      [
        ['Start', 'started', 'Editor sign-off', 'draft'],
        ['Editor sign-off', 'approved', 'Finish', 'value'],
      ],
    ),
    'Monday digest',
  );
  const started = await f.startRun(flow.id, 'the draft');
  const pending = await until(async () => {
    const list = await f.get<FlowApproval[]>('/flows/approvals');
    return list.length ? list : undefined;
  });
  expect(pending).toHaveLength(1);
  expect(pending[0].runId).toBe(started.id);
  expect(pending[0].context).toEqual({
    flowName: 'Monday digest',
    nodeLabel: 'Editor sign-off',
    runStartedAt: started.startedAt,
    trigger: 'manual',
  });
  // The payload the card needs is untouched.
  expect(pending[0].payload.draft).toBe('the draft');
  expect(pending[0].payload.actions).toEqual(['approve', 'changes', 'decline']);
  // The badge reads a count, so it never pulls the drafts across.
  expect(await f.get<{ pending: number }>('/flows/approvals/count')).toEqual({
    pending: 1,
  });
});

it('lists the most recent runs across every flow, newest first', async () => {
  const f = fixture();
  const trivial = graph(
    [
      ['Start', 'start', { trigger: 'manual' }],
      ['Finish', 'finish', {}],
    ],
    [['Start', 'started', 'Finish', 'value']],
  );
  const first = await f.createFlow(trivial, 'First flow');
  const second = await f.createFlow(trivial, 'Second flow');
  const older = await f.startRun(first.id, 'one');
  await f.platform.runner.settled(older.id);
  const newer = await f.startRun(second.id, 'two');
  await f.platform.runner.settled(newer.id);

  const list = await f.get<FlowRunSummary[]>('/flows/runs');
  expect(list.map((row) => row.id)).toEqual([newer.id, older.id]);
  expect(list.map((row) => row.flowName)).toEqual([
    'Second flow',
    'First flow',
  ]);
  expect(list[0].trigger.source).toBe('manual');
  expect(list[0].stepCount).toBe(2);
  expect(list[0].completedSteps).toBe(2);
  // limit caps the list, and "runs" is never read as a flow id.
  expect(await f.get<FlowRunSummary[]>('/flows/runs?limit=1')).toHaveLength(1);
  expect(
    (await f.app.request('http://localhost/api/flows/runs/nope')).status,
  ).toBe(404);
  // The per-flow list still answers only its own runs.
  const own = await f.get<FlowRunSummary[]>(`/flows/${second.id}/runs`);
  expect(own.map((row) => row.id)).toEqual([newer.id]);
});
