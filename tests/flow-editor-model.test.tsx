import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
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
import { describeNode, nodeIcon } from '../src/client/flows/FlowNodeCard';
import { nodeIcon as homeIcon } from '../src/client/flows/FlowsHome';
import { ConfirmDialog, ProblemsTray } from '../src/client/flows/FlowVersions';
import {
  NodePanel,
  acceptsKind,
  catalogGroups,
  filterGroups,
  flattenResults,
  isComingSoon,
  searchScore,
} from '../src/client/flows/NodePanel';
import { canRemove, roomFor } from '../src/client/flows/flow-history';
import { describeSchedule, relativeTime } from '../src/client/flows/format';
import {
  FLOW_LIMITS,
  NODE_CATALOG,
  NODE_SPECS,
  makeNode,
  type FlowProblem,
} from '../src/shared/flows';
import type { Dot, WorkspaceState } from '../src/shared/types';

const dot = {
  id: 'd1',
  name: 'Writer',
  avatar: 'fox',
  instructions: 'Writes the weekly digest. Keeps it short.',
} as unknown as Dot;
const workspace = { dots: [dot], spaces: [] } as unknown as WorkspaceState;

it('protects only the last Start from removal', () => {
  const start = makeNode('start', { x: 0, y: 0 });
  const other = makeNode('start', { x: 1, y: 1 });
  const task = makeNode('dot-task', { x: 2, y: 2 }, {});
  expect(canRemove([start, task], start.id)).toBe(false);
  expect(canRemove([start, task], task.id)).toBe(true);
  expect(canRemove([start, other, task], start.id)).toBe(true);
  expect(canRemove([start, task], 'missing')).toBe(true);
});

it('refuses additions that would exceed the server limits', () => {
  expect(roomFor(10, 10, 1, 1)).toBeNull();
  expect(roomFor(FLOW_LIMITS.nodes, 0, 1)).toMatch(/limited to 200 steps/);
  expect(roomFor(FLOW_LIMITS.nodes - 3, 0, 3)).toBeNull();
  expect(roomFor(0, FLOW_LIMITS.edges, 0, 1)).toMatch(/400 connections/);
});

it('summarises cards from stored titles rather than raw ids', () => {
  const read = makeNode(
    'read-page',
    { x: 0, y: 0 },
    { space: 's1', mode: 'page', page: 'p_7f3a1c', pageName: 'Roadmap' },
  );
  expect(describeNode(read, undefined, 'Marketing').summary).toBe(
    'Marketing / Roadmap',
  );
  const newest = makeNode(
    'read-page',
    { x: 0, y: 0 },
    { space: 's1', mode: 'newest', limit: 3 },
  );
  expect(describeNode(newest, undefined, 'Marketing').summary).toBe(
    'Marketing / Newest 3 pages',
  );
  const tool = makeNode(
    'mcp-tool',
    { x: 0, y: 0 },
    {
      dot: 'd1',
      tool: 'conn_ab12:send_email',
      toolTitle: 'Send email',
      toolConnection: 'Gmail',
    },
  );
  const described = describeNode(tool);
  expect(described.summary).toBe('Send email');
  expect(described.chips).toContain('Gmail');
  // Without a stored title the tool name (not the connection id) is shown.
  expect(
    describeNode(
      makeNode('mcp-tool', { x: 0, y: 0 }, { tool: 'conn_ab12:send_email' }),
    ).summary,
  ).toBe('send_email');
});

it('reads the real review flag and never prints NaN for a schedule', () => {
  const task = makeNode(
    'dot-task',
    { x: 0, y: 0 },
    { dot: 'd1', task: 'Write', reviewBeforeSave: true },
  );
  expect(describeNode(task).chips).toContain('Asks before saving');
  const broken = makeNode(
    'start',
    { x: 0, y: 0 },
    { trigger: 'schedule', schedule: 'daily' },
  );
  expect(describeNode(broken).summary).toBe('No schedule set');
  const weekdays = makeNode(
    'start',
    { x: 0, y: 0 },
    {
      trigger: 'schedule',
      schedule: 86400,
      scheduleDays: 'weekdays',
      scheduleAt: '09:00',
    },
  );
  expect(describeNode(weekdays).summary).toBe('Runs Monday to Friday at 09:00');
  expect(describeSchedule({ schedule: 7200 }, 'schedule')).toBe(
    'Runs every 2 hours.',
  );
  expect(describeSchedule({ schedule: -5 }, 'schedule')).toBe(
    'No schedule set.',
  );
});

it('shares one icon table and one relative-time helper across surfaces', () => {
  for (const type of ['save-page', 'combine', 'branch']) {
    const spec = NODE_SPECS[type];
    if (!spec) continue;
    expect(homeIcon(type)).toBe(nodeIcon(spec.icon));
  }
  const now = Date.now();
  expect(relativeTime(now - 30_000, now)).toBe('just now');
  expect(relativeTime(now - 120_000, now)).toBe('2m ago');
  expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
});

it('keys problem rows uniquely even when a node repeats a code', () => {
  const node = makeNode('dot-task', { x: 0, y: 0 }, {});
  const problems: FlowProblem[] = [
    {
      level: 'error',
      code: 'missing-config',
      message: 'Dot task: Dot is required.',
      nodeId: node.id,
    },
    {
      level: 'error',
      code: 'missing-config',
      message: 'Dot task: Task is required.',
      nodeId: node.id,
    },
  ];
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const html = renderToStaticMarkup(
    <ProblemsTray
      problems={problems}
      nodes={[node]}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain('Dot is required.');
  expect(html).toContain('Task is required.');
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes('same key')),
  ).toBe(false);
  warn.mockRestore();
});

it('lists real Dots first in the Dots category and keeps coming-soon steps', () => {
  const groups = catalogGroups(workspace);
  const dots = groups.find((group) => group.category.id === 'dots')!;
  expect(dots.items[0]).toMatchObject({
    type: 'dot-task',
    label: 'Writer',
    description: 'Writes the weekly digest.',
    dot,
  });
  expect(dots.items.slice(1).every((item) => !item.dot)).toBe(true);
  const soon = groups.find((group) => group.category.id === 'team')!;
  expect(soon.items.every(isComingSoon)).toBe(true);
  expect(groups.map((group) => group.category.id)).toEqual(
    NODE_CATALOG.map((category) => category.id),
  );
});

it('ranks search results by label match, then fuzzy, then description', () => {
  const groups = catalogGroups(workspace);
  const labels = flattenResults(groups, 'save').map(({ item }) => item.label);
  expect(labels[0]).toBe('Save page');
  const fuzzy = flattenResults(groups, 'hmrv').map(({ item }) => item.label);
  expect(fuzzy[0]).toBe('Human review');
  expect(
    searchScore({ label: 'Branch', description: '', type: 'branch' }, 'br'),
  ).toBeGreaterThan(
    searchScore(
      { label: 'Web research', description: 'browse', type: 'web' },
      'br',
    ),
  );
  expect(
    searchScore({ label: 'Note', description: '', type: 'note' }, 'zzz'),
  ).toBe(0);
  expect(flattenResults(groups, 'zzzz')).toEqual([]);
});

it('offers only steps that can take the source output when wired', () => {
  const groups = catalogGroups(workspace);
  const fromTrigger = filterGroups(groups, '', (item) =>
    acceptsKind(item, 'trigger'),
  );
  const types = fromTrigger.flatMap((group) =>
    group.items.map((item) => item.type),
  );
  expect(types).toContain('dot-task');
  expect(types).not.toContain('note');
  expect(types).not.toContain('start');
  expect(acceptsKind({ type: 'note' }, 'text')).toBe(false);
  expect(acceptsKind({ type: 'missing' }, 'text')).toBe(false);
});

it('renders the picker with its n8n-style title, search and categories', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  const html = renderToStaticMarkup(
    <NodePanel workspace={workspace} onPick={() => {}} onClose={() => {}} />,
  );
  expect(html).toContain('What happens next?');
  expect(html).toContain('Search steps');
  for (const category of NODE_CATALOG)
    expect(html).toContain(category.label.replace('&', '&amp;'));
  const wired = renderToStaticMarkup(
    <NodePanel
      workspace={workspace}
      from={{ label: 'Research', port: 'Result', kind: 'text' }}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );
  expect(wired).toContain('What should this step connect to?');
  expect(wired).toContain('Research');
  expect(wired).not.toContain('Notes');
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes('same key')),
  ).toBe(false);
  warn.mockRestore();
});

it('renders the delete confirm with the flow name and a danger action', () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog
      title="Delete “Weekly digest”?"
      body="Its versions and runs are removed."
      confirmLabel="Delete"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('Delete “Weekly digest”?');
  expect(html).toContain('Its versions and runs are removed.');
  expect(html).toMatch(/class="danger"[^>]*>Delete</);
});

it('says "Coming soon" for Slack destinations instead of promising delivery', () => {
  const slack = makeNode(
    'send-message',
    { x: 0, y: 0 },
    { destination: 'slack', slackChannel: '#team', message: 'hi' },
  );
  expect(describeNode(slack).chips).toEqual(['Coming soon']);
  const inbox = makeNode(
    'send-message',
    { x: 0, y: 0 },
    { destination: 'inbox', message: 'hi' },
  );
  expect(describeNode(inbox).chips).toEqual(['Run log']);
  const review = makeNode(
    'human-review',
    { x: 0, y: 0 },
    { message: 'look', notify: 'slack' },
  );
  expect(describeNode(review).chips).toContain('Coming soon');
  expect(describeNode(review).chips).not.toContain('Slack DM');
});
