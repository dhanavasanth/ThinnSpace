import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {},
}));
import { FlowProperties } from '../src/client/flows/FlowProperties';
import type { UpstreamRef } from '../src/client/flows/contract';
import { makeNode, type Flow, type FlowGraph } from '../src/shared/flows';
import type { WorkspaceState } from '../src/shared/types';

const workspace: WorkspaceState = {
  spaces: [{ id: 's1', name: 'Marketing', description: '', createdAt: 1 }],
  dots: [
    {
      id: 'd1',
      spaceId: 's1',
      spaceIds: ['s1'],
      name: 'Writer',
      instructions: 'Writes launch pages.',
      researchAllowed: true,
      memoryAllowed: true,
      createdAt: 1,
      avatar: null,
    },
  ],
  avatars: [],
  flows: [],
  conversations: [],
  setup: {
    intelligence: true,
    model: true,
    browser: false,
    voice: false,
    slack: '',
    missing: [],
  },
  calls: [],
};

const start = makeNode('start', { x: 0, y: 0 });
const task = makeNode('dot-task', { x: 300, y: 0 }, {});
const graph: FlowGraph = {
  schema: 1,
  nodes: [start, task],
  edges: [
    {
      id: 'e1',
      source: start.id,
      sourceHandle: 'started',
      target: task.id,
      targetHandle: 'context',
    },
  ],
};
const flow: Flow = {
  id: 'f1',
  name: 'Launch page',
  description: '',
  graph,
  revision: 1,
  publishedVersionId: null,
  publishedRevision: null,
  createdAt: 1,
  updatedAt: 1,
};
const upstream: UpstreamRef[] = [
  {
    nodeId: start.id,
    nodeLabel: 'Start',
    port: 'input',
    portLabel: 'Input',
    kind: 'text',
    token: '{{start.input}}',
  },
];
const noop = () => {};

function render(
  problems = [] as {
    level: 'error' | 'warning';
    code: string;
    message: string;
    nodeId?: string;
  }[],
) {
  return renderToStaticMarkup(
    <FlowProperties
      flow={flow}
      node={task}
      graph={graph}
      workspace={workspace}
      problems={problems}
      upstream={upstream}
      onChange={noop}
      onDuplicate={noop}
      onDelete={noop}
      onClose={noop}
      onAddNext={noop}
    />,
  );
}

it('shows the Dot picker and the Task field for a Dot task', () => {
  const html = render();
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('Writer');
  expect(html).toContain('>Task<');
  expect(html).toContain('Insert an upstream output');
  // Advanced tab exists because dot-task has advanced fields.
  expect(html).toContain('Advanced');
  // Next step lists both outputs of a Dot task.
  expect(html).toContain('Add a step after Result');
  expect(html).toContain('Add a step after Data');
});

it('renders a missing-config problem as an inline error on its field', () => {
  const html = render([
    {
      level: 'error',
      code: 'missing-config',
      message: 'Dot task: Task is required.',
      nodeId: task.id,
    },
  ]);
  expect(html).toContain('fp-inline-error');
  expect(html).toContain('Task is required.');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('1 problem');
});

it('uses the chosen Dot avatar and offers Edit Dot', () => {
  const html = renderToStaticMarkup(
    <FlowProperties
      flow={flow}
      node={{ ...task, config: { dot: 'd1' } }}
      graph={graph}
      workspace={workspace}
      problems={[]}
      upstream={upstream}
      onChange={noop}
      onDuplicate={noop}
      onDelete={noop}
      onClose={noop}
      onAddNext={noop}
      onEditDot={noop}
    />,
  );
  expect(html).toContain('fp-avatar');
  expect(html).toContain('Dot task · Writer');
});

it('lists the shared settings under Advanced for every executable step', () => {
  // Send message has no advanced field of its own; the common settings still
  // give it an Advanced tab and the card note becomes editable.
  const message = makeNode('send-message', { x: 0, y: 0 }, {});
  const html = renderToStaticMarkup(
    <FlowProperties
      flow={flow}
      node={message}
      graph={graph}
      workspace={workspace}
      problems={[]}
      upstream={upstream}
      onChange={noop}
      onDuplicate={noop}
      onDelete={noop}
      onClose={noop}
      onAddNext={noop}
    />,
  );
  expect(html).toContain('Advanced');
  // Catalog order is kept for a Dot task: Dot, then Task.
  const task = render();
  expect(task.indexOf('>Dot<')).toBeGreaterThan(-1);
  expect(task.indexOf('>Dot<')).toBeLessThan(task.indexOf('>Task<'));
});

it('offers a one-click update for an outdated node and labels group controls', () => {
  const calls: unknown[] = [];
  const html = renderToStaticMarkup(
    <FlowProperties
      flow={flow}
      node={{ ...start, typeVersion: 0 }}
      graph={graph}
      workspace={workspace}
      problems={[]}
      upstream={[]}
      onChange={(id, patch) => calls.push([id, patch])}
      onDuplicate={noop}
      onDelete={noop}
      onClose={noop}
      onAddNext={noop}
    />,
  );
  expect(html).toContain('Update node');
  // Field labels only point `for` at labelable elements; the Dot picker is
  // labelled through aria-labelledby instead.
  const dotHtml = render();
  expect(dotHtml).toMatch(/role="radiogroup"[^>]*aria-labelledby="fp-/);
  expect(dotHtml).not.toContain('role="alert"');
});
