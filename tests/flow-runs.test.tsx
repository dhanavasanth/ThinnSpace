import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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
import { pollDelay, useFlowRun } from '../src/client/flows/useFlowRun';
import {
  ApprovalCard,
  RunDialog,
  RunTray,
  RunsButton,
  formatDuration,
  manualStart,
  needsRunDialog,
  nodeStatus,
  orderSteps,
  runFormFields,
  stepStatuses,
  valueText,
} from '../src/client/flows/FlowRuns';
import type {
  FlowApproval,
  FlowRun,
  FlowRunStep,
  FlowRunSummary,
} from '../src/shared/flow-runs';
import { makeNode, type FlowGraph } from '../src/shared/flows';

/* ---------- fixtures ---------- */

const step = (over: Partial<FlowRunStep>): FlowRunStep => ({
  runId: 'r1',
  nodeId: 'n1',
  nodeType: 'dot-task',
  label: 'Writer',
  iterationKey: '',
  attempt: 1,
  status: 'completed',
  input: 'Write the digest',
  output: { result: { kind: 'text', value: 'The digest' } },
  error: null,
  threadId: null,
  startedAt: 1_000,
  finishedAt: 3_500,
  durationMs: 2_500,
  ...over,
});
const summary = (over: Partial<FlowRunSummary>): FlowRunSummary => ({
  id: 'r1',
  flowId: 'f1',
  flowName: 'Digest',
  versionId: null,
  status: 'completed',
  trigger: { source: 'manual', nodeId: 's1', input: '' },
  error: null,
  waitingNodeId: null,
  startedAt: Date.now() - 60_000,
  finishedAt: Date.now() - 30_000,
  stepCount: 3,
  completedSteps: 3,
  ...over,
});
const fullRun = (over: Partial<FlowRun>): FlowRun => ({
  ...summary({}),
  result: null,
  steps: [],
  events: [],
  approvals: [],
  ...over,
});
const approval = (over: Partial<FlowApproval['payload']>): FlowApproval => ({
  id: 'a1',
  runId: 'r1',
  flowId: 'f1',
  nodeId: 'n2',
  kind: 'review',
  title: 'Review the digest',
  payload: {
    message: 'Please **check** the numbers.',
    draft: 'Draft text',
    allowEdits: false,
    actions: ['approve', 'changes', 'decline'],
    requireFeedback: true,
    ...over,
  },
  status: 'pending',
  editedText: null,
  feedback: null,
  createdAt: Date.now(),
  decidedAt: null,
});

/* ---------- pure helpers ---------- */

describe('status painting', () => {
  it('folds per-item rows into one card status', () => {
    expect(nodeStatus(['completed', 'completed'])).toBe('completed');
    expect(nodeStatus(['completed', 'running'])).toBe('running');
    expect(nodeStatus(['completed', 'failed'])).toBe('failed');
    expect(nodeStatus(['running', 'failed'])).toBe('running');
    expect(nodeStatus(['completed', 'pending'])).toBe('running');
    expect(nodeStatus(['skipped', 'skipped'])).toBe('skipped');
    expect(nodeStatus(['pending'])).toBe('idle');
    expect(nodeStatus(['waiting', 'completed'])).toBe('waiting');
  });

  it('keeps the latest attempt per item when mapping steps to nodes', () => {
    const map = stepStatuses([
      step({ nodeId: 'a', attempt: 1, status: 'failed' }),
      step({ nodeId: 'a', attempt: 2, status: 'completed' }),
      step({ nodeId: 'b', iterationKey: '0', status: 'completed' }),
      step({ nodeId: 'b', iterationKey: '1', status: 'running' }),
      step({ nodeId: 'c', status: 'skipped' }),
    ]);
    expect(map.get('a')).toBe('completed');
    expect(map.get('b')).toBe('running');
    expect(map.get('c')).toBe('skipped');
    expect(map.has('d')).toBe(false);
  });

  it('orders started steps by time and the rest by graph order', () => {
    const rows = [
      step({
        nodeId: 'c',
        startedAt: null,
        finishedAt: null,
        status: 'pending',
      }),
      step({ nodeId: 'b', startedAt: 2_000 }),
      step({ nodeId: 'a', startedAt: 1_000 }),
      step({ nodeId: 'd', startedAt: null, status: 'pending' }),
      step({ nodeId: 'a', startedAt: 1_000, iterationKey: '1' }),
    ];
    const ids = orderSteps(rows, ['a', 'b', 'd', 'c']).map(
      (row) => `${row.nodeId}${row.iterationKey}`,
    );
    expect(ids).toEqual(['a', 'a1', 'b', 'd', 'c']);
  });
});

describe('run form', () => {
  it('reads inputFields rows from JSON text or arrays and ignores junk', () => {
    const rows = runFormFields({
      inputFields:
        '[{"name":"audience","label":"Audience","type":"text","required":true},{"name":"count","type":"number"},{"name":"audience"},{"label":"no name"},{"name":"long","type":"textarea"},{"name":"flag","type":"toggle"}]',
    });
    expect(rows).toEqual([
      { name: 'audience', label: 'Audience', type: 'text', required: true },
      { name: 'count', label: 'count', type: 'number', required: false },
      { name: 'long', label: 'long', type: 'textarea', required: false },
      { name: 'flag', label: 'flag', type: 'boolean', required: false },
    ]);
    expect(runFormFields({ inputFields: 'not json' })).toEqual([]);
    expect(runFormFields({ inputFields: '' })).toEqual([]);
    expect(runFormFields({})).toEqual([]);
    expect(
      runFormFields({ inputFields: [{ name: 'x', type: 'weird' }] }),
    ).toEqual([{ name: 'x', label: 'x', type: 'text', required: false }]);
  });

  it('asks for input only when the manual Start wants some', () => {
    const plain = makeNode('start', { x: 0, y: 0 });
    const labelled = makeNode('start', { x: 0, y: 0 }, { inputLabel: 'Topic' });
    const typed = makeNode(
      'start',
      { x: 0, y: 0 },
      { inputFields: [{ name: 'audience' }] },
    );
    expect(needsRunDialog(plain)).toBe(false);
    expect(needsRunDialog(labelled)).toBe(true);
    expect(needsRunDialog(typed)).toBe(true);
    expect(needsRunDialog(undefined)).toBe(false);
    const schedule = makeNode('start', { x: 0, y: 0 }, { trigger: 'schedule' });
    const graph: FlowGraph = {
      schema: 1,
      nodes: [schedule, labelled],
      edges: [],
    };
    expect(manualStart(graph)?.id).toBe(labelled.id);
    expect(manualStart({ ...graph, nodes: [schedule] })?.id).toBe(schedule.id);
  });

  it('renders the Start sample as placeholder and typed fields as controls', () => {
    const start = makeNode(
      'start',
      { x: 0, y: 0 },
      {
        inputLabel: 'Topic',
        sampleInput: 'Q3 launch',
        inputFields: [
          { name: 'audience', label: 'Audience', required: true },
          { name: 'count', label: 'How many', type: 'number' },
          { name: 'urgent', label: 'Urgent', type: 'boolean' },
        ],
      },
    );
    const html = renderToStaticMarkup(
      <RunDialog
        start={start}
        busy={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('placeholder="Q3 launch"');
    expect(html).toContain('Topic');
    expect(html).toContain('Audience');
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('>Run<');
  });
});

it('formats durations and values for the tray', () => {
  expect(formatDuration(400)).toBe('0.4s');
  expect(formatDuration(12_400)).toBe('12s');
  expect(formatDuration(65_000)).toBe('1m 05s');
  expect(formatDuration(3_720_000)).toBe('1h 02m');
  expect(formatDuration(null)).toBe('');
  expect(valueText('plain')).toBe('plain');
  expect(valueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  expect(valueText(null)).toBe('');
  expect(valueText('x'.repeat(5000))).toMatch(/1000 more characters/);
});

it('backs off exponentially after network errors, capped', () => {
  expect(pollDelay(0)).toBe(1000);
  expect(pollDelay(1)).toBe(2000);
  expect(pollDelay(3)).toBe(8000);
  expect(pollDelay(10)).toBe(30_000);
});

/* ---------- tray rendering ---------- */

const trayProps = {
  runsLoaded: true,
  busy: false,
  error: '',
  order: ['s1', 'n1', 'n2'],
  onClose: () => {},
  onStop: () => {},
  onSelectRun: () => {},
  onDecide: () => {},
  onDismiss: () => {},
};

describe('run tray', () => {
  it('shows the empty states before any run exists', () => {
    const html = renderToStaticMarkup(
      <RunTray {...trayProps} run={null} runs={[]} />,
    );
    expect(html).toContain('No runs yet.');
    expect(html).toContain('Press Run flow to start one.');
    expect(
      renderToStaticMarkup(
        <RunTray {...trayProps} run={null} runs={[]} runsLoaded={false} />,
      ),
    ).toContain('Loading runs…');
  });

  it('lists history rows with status, trigger and duration', () => {
    const html = renderToStaticMarkup(
      <RunTray
        {...trayProps}
        run={null}
        runs={[
          summary({
            id: 'r2',
            status: 'failed',
            trigger: { source: 'schedule', nodeId: 's1', input: '' },
          }),
          summary({ id: 'r1' }),
        ]}
      />,
    );
    expect(html).toContain('Failed');
    expect(html).toContain('On a schedule');
    expect(html).toContain('Manual');
    expect(html).toContain('30s');
    expect(html).toContain('3/3 steps');
  });

  it('renders the loaded run: header, markdown result, sources and steps', () => {
    const run = fullRun({
      result: {
        text: 'All **done**. See [the page](/#/spaces/s1/p1).',
        sources: [{ title: 'Source A', url: 'https://example.com/a' }],
      },
      steps: [
        step({
          nodeId: 's1',
          nodeType: 'start',
          label: 'Start',
          input: 'hello',
        }),
        step({ nodeId: 'n1' }),
        step({
          nodeId: 'n2',
          label: 'Save',
          status: 'failed',
          error: 'Space not found',
          output: null,
        }),
      ],
    });
    const html = renderToStaticMarkup(
      <RunTray {...trayProps} run={run} runs={[summary({})]} />,
    );
    expect(html).toContain('Completed');
    expect(html).toContain('Manual');
    expect(html).toContain('Started');
    expect(html).toContain('<strong>done</strong>');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('Source A');
    expect(html).toContain('Writer');
    expect(html).toContain('The digest');
    expect(html).toContain('Space not found');
    expect(html).toContain('2.5s'); // step duration is shown
    expect(html).toContain('>Clear<');
    expect(html).not.toContain('>Stop<');
  });

  it('offers Stop while active and the approval card while waiting', () => {
    const running = fullRun({ status: 'running', finishedAt: null });
    expect(
      renderToStaticMarkup(<RunTray {...trayProps} run={running} runs={[]} />),
    ).toContain('Stop');
    const waiting = fullRun({
      status: 'waiting',
      finishedAt: null,
      approvals: [approval({})],
    });
    const html = renderToStaticMarkup(
      <RunTray {...trayProps} run={waiting} runs={[]} />,
    );
    expect(html).toContain('Review the digest');
    expect(html).toContain('<strong>check</strong>');
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain('Approve');
    expect(html).toContain('Request changes');
    expect(html).toContain('Decline');
    expect(html).toContain('for changes or a decline');
  });

  it('shows an inline error and the Runs badge', () => {
    expect(
      renderToStaticMarkup(
        <RunTray {...trayProps} run={null} runs={[]} error="Lost contact" />,
      ),
    ).toContain('Lost contact');
    const html = renderToStaticMarkup(
      <RunsButton open={false} active reviews={2} onClick={() => {}} />,
    );
    expect(html).toContain('flow-runs-badge');
    expect(html).toContain('>2<');
    expect(html).toContain('2 reviews waiting for you');
  });

  it('only offers the actions a review allows, with an editable draft', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        approval={approval({
          allowEdits: true,
          actions: ['approve', 'decline'],
          requireFeedback: false,
        })}
        busy={false}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain('Draft (you can edit it)');
    expect(html).toContain('aria-readonly="false"');
    expect(html).toContain('Approve');
    expect(html).not.toContain('Request changes');
    expect(html).toContain('Decline');
    expect(html).toContain('(optional)');
  });
});

/* ---------- the polling hook ---------- */

describe('useFlowRun', () => {
  let state: ReturnType<typeof useFlowRun>;
  let root: ReactTestRenderer;
  function Hook() {
    state = useFlowRun('f1');
    return null;
  }
  const polls = () =>
    api.mock.calls.filter(
      ([path, method]) =>
        path === '/flows/runs/r1' && (method ?? 'GET') === 'GET',
    );
  const lists = () =>
    api.mock.calls.filter(
      ([path]) => path === '/flows/f1/runs' && api.mock.calls.length,
    );

  /** Routes the mock api; `statuses` is what successive run polls answer. */
  function serve(statuses: (FlowRun['status'] | Error)[]) {
    let polled = 0;
    api.mockImplementation(
      async (path: string, method = 'GET', body?: unknown) => {
        if (path === '/flows/approvals') return [];
        if (path === '/flows/f1/runs' && method === 'GET')
          return [summary({ status: 'running' })];
        if (path === '/flows/f1/runs' && method === 'POST')
          return fullRun({
            status: 'running',
            finishedAt: null,
            trigger: {
              source: 'manual',
              nodeId: 's1',
              input: String((body as { input: string }).input),
            },
          });
        if (path === '/flows/runs/r1' && method === 'GET') {
          const next = statuses[Math.min(polled, statuses.length - 1)];
          polled += 1;
          if (next instanceof Error) throw next;
          return fullRun({
            status: next,
            finishedAt: next === 'running' ? null : Date.now(),
          });
        }
        if (path === '/flows/runs/r1/cancel')
          return fullRun({ status: 'cancelled' });
        if (path === '/flows/approvals/a1/decide')
          return fullRun({ status: 'running', finishedAt: null });
        throw new Error(`unexpected ${method} ${path}`);
      },
    );
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    api.mockReset();
    serve(['running']);
    await act(async () => {
      root = create(createElement(Hook));
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the history on mount and starts a run with the typed input', async () => {
    expect(state.runsLoaded).toBe(true);
    expect(state.runs).toHaveLength(1);
    serve(['running', 'running', 'completed']);
    await act(async () => {
      await state.start('hello', { audience: 'devs' });
    });
    expect(api).toHaveBeenCalledWith('/flows/f1/runs', 'POST', {
      input: 'hello',
      fields: { audience: 'devs' },
    });
    expect(state.run?.status).toBe('running');
    expect(state.active).toBe(true);
    // Polls once a second while active, then stops and refreshes the list.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(polls()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(polls()).toHaveLength(3);
    expect(state.run?.status).toBe('completed');
    expect(state.active).toBe(false);
    const listsAfter = lists().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(polls()).toHaveLength(3);
    expect(lists().length).toBe(listsAfter);
  });

  it('backs off while the network is down and recovers', async () => {
    serve([new Error('offline'), new Error('offline'), 'running', 'completed']);
    await act(async () => {
      await state.start('');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(polls()).toHaveLength(1);
    expect(state.error).toBe('offline');
    expect(state.active).toBe(true);
    // Second poll 2 s later, third 4 s after that.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(polls()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(polls()).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(polls()).toHaveLength(3);
    expect(state.error).toBe('');
    // Back to the 1 s cadence once a poll succeeds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(polls()).toHaveLength(4);
    expect(state.run?.status).toBe('completed');
  });

  it('stops polling on unmount and after a cancel', async () => {
    await act(async () => {
      await state.start('');
    });
    await act(async () => {
      await state.cancel();
    });
    expect(api).toHaveBeenCalledWith('/flows/runs/r1/cancel', 'POST');
    expect(state.run?.status).toBe('cancelled');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(polls()).toHaveLength(0);
    await act(async () => {
      await state.start('');
    });
    await act(async () => root.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(polls()).toHaveLength(0);
    // afterEach unmounts again; make that a no-op.
    await act(async () => {
      root = create(createElement('div'));
    });
  });

  it('sends decisions and surfaces failures inline', async () => {
    await act(async () => {
      await state.start('');
    });
    await act(async () => {
      await state.decide('a1', 'changes', 'Tighten it', undefined);
    });
    expect(api).toHaveBeenCalledWith('/flows/approvals/a1/decide', 'POST', {
      action: 'changes',
      feedback: 'Tighten it',
    });
    api.mockRejectedValueOnce(new Error('Review not found.'));
    let thrown: unknown;
    await act(async () => {
      try {
        await state.decide('a9', 'approve');
      } catch (cause) {
        thrown = cause;
      }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(state.error).toBe('Review not found.');
    expect(state.busy).toBe(false);
  });
});
