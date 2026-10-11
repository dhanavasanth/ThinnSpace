import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { Position, ReactFlowProvider, type NodeProps } from '@xyflow/react';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {},
}));
import {
  EditorActionsContext,
  FlowNodeCard,
  PreviewContext,
  type EditorActions,
  type EditorNode,
  type PreviewStep,
} from '../src/client/flows/FlowNodeCard';
import { FlowEdge } from '../src/client/flows/FlowEdge';
import type { FlowNodeData } from '../src/client/flows/contract';
import { makeNode, type FlowNode } from '../src/shared/flows';
import type { Dot } from '../src/shared/types';

const writer: Dot = {
  id: 'd1',
  spaceId: 's1',
  spaceIds: ['s1'],
  name: 'Writer',
  instructions: 'Writes launch pages.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
  avatar: 'mint',
};
const actions: EditorActions = {
  renamingId: null,
  setRenamingId: () => {},
  rename: () => {},
  patchNode: () => {},
  commit: () => {},
  toggleCollapsed: () => {},
  duplicate: () => {},
  remove: () => {},
  removeEdge: () => {},
  addFrom: () => {},
};

function props(
  node: FlowNode,
  extra: Partial<FlowNodeData> = {},
  selected = false,
): NodeProps<EditorNode> {
  return {
    id: node.id,
    type: 'flow',
    data: { node, problems: [], status: 'idle', ...extra },
    selected,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: node.position.x,
    positionAbsoluteY: node.position.y,
  };
}
function render(
  node: FlowNode,
  extra: Partial<FlowNodeData> = {},
  preview: Map<string, PreviewStep> | null = null,
) {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <EditorActionsContext.Provider value={actions}>
        <PreviewContext.Provider value={preview}>
          <FlowNodeCard {...props(node, extra)} />
        </PreviewContext.Provider>
      </EditorActionsContext.Provider>
    </ReactFlowProvider>,
  );
}

it('shows the avatar, the Dot name and the task for a Dot task', () => {
  const task = makeNode(
    'dot-task',
    { x: 0, y: 0 },
    { dot: 'd1', task: 'Draft the launch page\nwith three sections' },
  );
  const html = render(task, { dot: writer });
  expect(html).toContain('class="fnode has-avatar"');
  expect(html).toContain('/dots/mint.png');
  expect(html).toContain('Writer · Draft the launch page');
  expect(html).not.toContain('three sections');
  // Category glyph badge, three port-coloured outputs with labels, one input.
  expect(html).toContain('fnode-cat');
  expect(html).toContain('aria-label="Context input (any)"');
  expect(html).toContain('aria-label="Result output (text)"');
  expect(html).toContain('background:#6366f1');
  expect(html).toContain('>Pages touched<');
  // The focusable React Flow wrapper carries the name (see nodeAriaLabel);
  // the card itself is not a second, unfocusable control.
  expect(html).not.toContain('role="button"');
  expect(html).not.toContain('aria-label="Dot task"');
});

it('stacks two labelled outputs for a Branch', () => {
  const branch = makeNode(
    'branch',
    { x: 0, y: 0 },
    { field: '{{editor.data.score}}', operator: 'gt', value: '7' },
  );
  const html = render(branch);
  expect(html).toContain('--fnode-ports:2');
  expect(html).toContain('<span class="fnode-port-label">Yes</span>');
  expect(html).toContain('<span class="fnode-port-label">No</span>');
  expect(html).toContain('aria-label="Add a step after No"');
  expect(html).toContain('class="fnode-token">editor.data.score</span>');
  expect(html).not.toContain('has-avatar');
});

it('gives Start the pill silhouette, no input, and a trigger chip', () => {
  const html = render(makeNode('start', { x: 0, y: 0 }));
  expect(html).toContain('class="fnode is-start"');
  expect(html).not.toContain('fnode-ins');
  expect(html).toContain('aria-label="Input output (trigger)"');
  expect(html).toContain('<span class="fnode-chip" title="Run manually"');
  expect(html).toContain('Run manually');
});

it('renders the X badge for a failed step and the ring state attribute', () => {
  const html = render(makeNode('web-research', { x: 0, y: 0 }), {
    status: 'failed',
  });
  expect(html).toContain('data-status="failed"');
  expect(html).toContain('class="fnode-status failed"');
  expect(html).toContain('aria-label="Failed"');
  expect(html).toContain('lucide-x');
  expect(render(makeNode('web-research', { x: 0, y: 0 }))).not.toContain(
    'fnode-status',
  );
});

it('shows the validation dot and the preview step badge', () => {
  const task = makeNode('dot-task', { x: 0, y: 0 }, {});
  const html = render(
    task,
    {
      problems: [
        {
          level: 'error',
          code: 'missing-config',
          message: 'Dot task: Dot is required.',
          nodeId: task.id,
        },
      ],
    },
    new Map([[task.id, { step: 3, wave: 1, waitsFor: 2 }]]),
  );
  expect(html).toContain('class="fnode-problem error"');
  expect(html).toContain('title="Dot task: Dot is required."');
  expect(html).toContain('previewing wave-1');
  expect(html).toContain('<span class="fnode-step"');
  expect(html).toContain('waits for 2');
});

it('caps chips at three and renders notes as sticky cards', () => {
  const save = makeNode(
    'save-page',
    { x: 0, y: 0 },
    { space: 's1', mode: 'create', title: 'Launch', perItem: true },
  );
  const html = render(save, { spaceName: 'Marketing' });
  expect(html.match(/class="fnode-chip"/g)?.length).toBe(3);
  expect(html).toContain('Marketing / Launch');
  const note = render(
    makeNode('note', { x: 0, y: 0 }, { text: 'Why this exists', color: 'sky' }),
  );
  expect(note).toContain('class="fnote tone-sky"');
  expect(note).toContain('Why this exists');
});

it('draws a neutral edge with an arrowhead and the delete affordance', () => {
  const html = renderToStaticMarkup(
    <ReactFlowProvider>
      <EditorActionsContext.Provider value={actions}>
        <svg>
          <FlowEdge
            id="e1"
            source="a"
            target="b"
            sourceX={0}
            sourceY={0}
            targetX={200}
            targetY={40}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            selected={false}
            animated={false}
            selectable
            deletable
          />
        </svg>
      </EditorActionsContext.Provider>
    </ReactFlowProvider>,
  );
  expect(html).toContain('class="fedge"');
  expect(html).toContain('marker id="fedge-arrow-e1"');
  expect(html).toContain('class="fedge-arrow"');
  expect(html).toContain('marker-end="url(#fedge-arrow-e1)"');
  expect(html).not.toContain('linearGradient');
});
