import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Position, ReactFlowProvider, type NodeProps } from '@xyflow/react';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {},
}));
import {
  EditorActionsContext,
  FlowNodeCard,
  containerColor,
  describeNode,
  type EditorActions,
  type EditorNode,
} from '../src/client/flows/FlowNodeCard';
import {
  CONTAINER_HEADER,
  CONTAINER_PAD,
  CONTAINER_SIZE,
  bodySpot,
  cloneSubgraph,
  containerAt,
  isContainer,
  orderByParent,
  reparentNodes,
  serializeCanvas,
  structuralKey,
  tidyLayout,
  toEditorNode,
  withBodies,
} from '../src/client/flows/flow-history';
import {
  NodePanel,
  catalogGroups,
  categorySoon,
  isComingSoon,
} from '../src/client/flows/NodePanel';
import type { FlowNodeData } from '../src/client/flows/contract';
import {
  NODE_CATALOG,
  NODE_SPECS,
  makeNode,
  type FlowNode,
} from '../src/shared/flows';
import type { WorkspaceState } from '../src/shared/types';

const workspace = { dots: [], spaces: [] } as unknown as WorkspaceState;
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
/** The For each spec, with whatever ports and flags the catalog now gives it. */
const forEach = NODE_SPECS['for-each'];

function card(node: FlowNode, extra: Partial<FlowNodeData> = {}) {
  const props = {
    id: node.id,
    type: 'flow',
    data: { node, problems: [], status: 'idle', ...extra },
    selected: false,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: node.position.x,
    positionAbsoluteY: node.position.y,
  } as NodeProps<EditorNode>;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <EditorActionsContext.Provider value={actions}>
        <FlowNodeCard {...props} />
      </EditorActionsContext.Provider>
    </ReactFlowProvider>,
  );
}
/** An editor node with a known box, so centre maths needs no measurement. */
function editorNode(
  node: FlowNode,
  size?: { width: number; height: number },
): EditorNode {
  const built = toEditorNode(node, workspace, []);
  return size ? { ...built, measured: size } : built;
}
const container = (
  position = { x: 400, y: 200 },
  config: Record<string, unknown> = { maxItems: 25 },
) => makeNode('for-each', position, config);

const flagWas = forEach?.comingSoon;
afterEach(() => {
  // The test below flips the catalog's comingSoon flag; put it back.
  if (!forEach) return;
  if (flagWas === undefined) delete forEach.comingSoon;
  else forEach.comingSoon = flagWas;
});

it('draws a For each as a container with its header, summary and chips', () => {
  const loop = container(undefined, { maxItems: 12, concurrency: 3 });
  const html = card(loop);
  expect(html).toContain('class="fcontainer"');
  expect(html).toContain('fcontainer-head');
  expect(html).toContain('For each');
  expect(html).toContain('once for every item of the list');
  expect(html).toContain('Max 12 items');
  expect(html).toContain('3 at a time');
  // An empty body says what the body is for.
  expect(html).toContain('Drag the steps that run for each item in here');
  // The declared ports are drawn: the list input and the results output on
  // the edges, and the per-item output (once the catalog declares it) inside.
  for (const port of forEach?.inputs ?? [])
    expect(html).toContain(`data-handleid="${port.id}"`);
  for (const port of forEach?.outputs ?? [])
    expect(html).toContain(`data-handleid="${port.id}"`);
  if (forEach?.outputs.some((port) => port.id === 'item'))
    expect(html).toContain('fcontainer-item');
  // A step card is still a step card.
  expect(card(makeNode('combine', { x: 0, y: 0 }))).toContain('class="fnode"');
  expect(isContainer('for-each')).toBe(true);
  expect(isContainer('combine')).toBe(false);
  expect(containerColor('for-each')).not.toBe('#94a3b8');
  expect(describeNode(container(undefined, {})).summary).toContain('once for');
});

it('gives a container a lower z-index and its own stored size', () => {
  const loop = editorNode(container());
  const step = editorNode(makeNode('combine', { x: 0, y: 0 }));
  expect(loop.zIndex!).toBeLessThan(step.zIndex ?? 0);
  expect(loop.width).toBe(CONTAINER_SIZE.width);
  expect(loop.height).toBe(CONTAINER_SIZE.height);
  // A child is handed to React Flow as a bounded child of its container.
  const child = makeNode('combine', { x: 40, y: 60 });
  child.parentId = loop.id;
  expect(editorNode(child)).toMatchObject({
    parentId: loop.id,
    extent: 'parent',
  });
  // React Flow needs the parent before its children.
  const ordered = orderByParent([editorNode(child), loop]);
  expect(ordered.map((node) => node.id)).toEqual([loop.id, child.id]);
});

it('takes in a step whose centre lands inside the container', () => {
  const loop = container({ x: 400, y: 200 });
  const step = makeNode('combine', { x: 500, y: 300 });
  const nodes = [
    editorNode(loop, CONTAINER_SIZE),
    editorNode(step, { width: 96, height: 96 }),
  ];
  const moved = reparentNodes(nodes, [step.id]);
  expect(moved.changed).toEqual([step.id]);
  expect(moved.refused).toBe(false);
  const joined = moved.nodes.find((node) => node.id === step.id)!;
  expect(joined.parentId).toBe(loop.id);
  expect(joined.extent).toBe('parent');
  // 500 - 400 and 300 - 200, which is inside the body area already.
  expect(joined.position).toEqual({ x: 100, y: 100 });
  // The stored copy travels with it, so a save keeps the membership.
  expect(joined.data.node.parentId).toBe(loop.id);
  expect(joined.data.node.position).toEqual({ x: 100, y: 100 });
  // A step dropped on the header is pushed down into the body area.
  const high = editorNode(makeNode('combine', { x: 410, y: 205 }), {
    width: 96,
    height: 96,
  });
  const pushed = reparentNodes([nodes[0], high], [high.id]).nodes[1];
  expect(pushed.position.x).toBeGreaterThanOrEqual(CONTAINER_PAD);
  expect(pushed.position.y).toBeGreaterThanOrEqual(CONTAINER_HEADER);
  // A step well clear of it is left alone, array and all.
  const far = editorNode(makeNode('combine', { x: 40, y: 40 }), {
    width: 96,
    height: 96,
  });
  const before = [nodes[0], far];
  const untouched = reparentNodes(before, [far.id]);
  expect(untouched.changed).toEqual([]);
  expect(untouched.nodes).toBe(before);
});

it('restores absolute coordinates when a step is dragged out', () => {
  const loop = container({ x: 400, y: 200 });
  const inside = makeNode('combine', { x: 100, y: 100 });
  inside.parentId = loop.id;
  const nodes = [
    editorNode(loop, CONTAINER_SIZE),
    editorNode(inside, { width: 96, height: 96 }),
  ];
  // Dragged left, so its centre is now outside the container.
  const dragged = nodes.map((node) =>
    node.id === inside.id ? { ...node, position: { x: -600, y: 100 } } : node,
  );
  const moved = reparentNodes(dragged, [inside.id]);
  expect(moved.changed).toEqual([inside.id]);
  const out = moved.nodes.find((node) => node.id === inside.id)!;
  expect(out.parentId).toBeUndefined();
  expect(out.extent).toBeUndefined();
  expect(out.position).toEqual({ x: -200, y: 300 });
  expect(out.data.node.parentId).toBeUndefined();
  // "Move out of the loop" does the same without waiting for a drag.
  const detached = reparentNodes(nodes, [inside.id], { detach: true });
  expect(detached.nodes.find((node) => node.id === inside.id)).toMatchObject({
    parentId: undefined,
    position: { x: 500, y: 300 },
  });
});

it('stores a membership change, so undo and the linter both see it', () => {
  const loop = container({ x: 400, y: 200 });
  const step = makeNode('combine', { x: 500, y: 300 });
  const nodes = [
    editorNode(loop, CONTAINER_SIZE),
    editorNode(step, { width: 96, height: 96 }),
  ];
  const before = serializeCanvas(nodes, []);
  const after = serializeCanvas(reparentNodes(nodes, [step.id]).nodes, []);
  expect(before.nodes[1].parentId).toBeUndefined();
  expect(after.nodes[1]).toMatchObject({
    parentId: loop.id,
    position: { x: 100, y: 100 },
  });
  // The container's size is stored, so a resize survives a save and an undo.
  expect(after.nodes[0]).toMatchObject(CONTAINER_SIZE);
  // Which loop a step sits in is structure: the linter and the run-order
  // preview are recomputed, not just the layout.
  expect(structuralKey(after)).not.toBe(structuralKey(before));
  // A container that is gone leaves no dangling membership behind.
  expect(
    serializeCanvas(
      reparentNodes(nodes, [step.id]).nodes.filter((n) => n.id !== loop.id),
      [],
    ).nodes[0].parentId,
  ).toBeUndefined();
});

it('refuses to nest one container inside another', () => {
  const outer = container({ x: 0, y: 0 });
  const inner = container({ x: 60, y: 80 });
  const nodes = [
    editorNode(outer, CONTAINER_SIZE),
    editorNode(inner, CONTAINER_SIZE),
  ];
  const moved = reparentNodes(nodes, [inner.id]);
  expect(moved.refused).toBe(true);
  expect(moved.changed).toEqual([]);
  expect(moved.nodes.find((node) => node.id === inner.id)!.parentId).toBe(
    undefined,
  );
  // A container is not a drop target for itself either.
  expect(containerAt(nodes, { x: 100, y: 120 }, outer.id)?.id).toBe(inner.id);
  expect(containerAt(nodes, { x: -50, y: -50 })).toBeUndefined();
});

it('carries a container body through delete, duplicate and tidy', () => {
  const loop = container({ x: 400, y: 200 });
  const first = makeNode('combine', { x: 20, y: 60 });
  const second = makeNode('combine', { x: 180, y: 60 });
  first.parentId = loop.id;
  second.parentId = loop.id;
  const outside = makeNode('combine', { x: 40, y: 40 });
  const nodes = [loop, first, second, outside];
  // Delete and copy both expand a container to its body.
  expect(withBodies(nodes, [loop.id]).sort()).toEqual(
    [loop.id, first.id, second.id].sort(),
  );
  expect(withBodies(nodes, [outside.id])).toEqual([outside.id]);
  // A duplicate keeps the body inside the copy, with fresh ids.
  const edges = [
    {
      id: 'e1',
      source: first.id,
      sourceHandle: 'text',
      target: second.id,
      targetHandle: 'values',
    },
  ];
  const copy = cloneSubgraph([loop, first, second], edges, 40);
  const copiedLoop = copy.nodes[0];
  expect(copiedLoop.id).not.toBe(loop.id);
  expect(copiedLoop.position).toEqual({ x: 440, y: 240 });
  for (const child of copy.nodes.slice(1)) {
    expect(child.id).not.toBe(first.id);
    expect(child.parentId).toBe(copiedLoop.id);
  }
  // The body keeps its relative layout, so the copy looks like the original.
  expect(copy.nodes[1].position).toEqual({ x: 20, y: 60 });
  expect(copy.edges[0].source).toBe(copy.nodes[1].id);
  // Tidy lays the body out inside the container and leaves the container as
  // one box in the outer layout.
  const { positions, sizes } = tidyLayout({ nodes, edges });
  expect(positions.get(first.id)!.x).toBe(CONTAINER_PAD);
  expect(positions.get(first.id)!.y).toBeGreaterThanOrEqual(CONTAINER_HEADER);
  expect(positions.get(second.id)!.x).toBeGreaterThan(
    positions.get(first.id)!.x,
  );
  expect(sizes.get(loop.id)!.width).toBeGreaterThanOrEqual(
    CONTAINER_SIZE.width,
  );
  expect(positions.get(loop.id)).toBeDefined();
  expect(positions.get(outside.id)).toBeDefined();
  // A new step added into the loop lands in the body area, not on top of
  // what is already there.
  const spot = bodySpot(
    [
      editorNode(loop, CONTAINER_SIZE),
      editorNode(first, { width: 96, height: 96 }),
    ],
    loop.id,
  );
  expect(spot.y).toBeGreaterThanOrEqual(CONTAINER_HEADER);
  expect(spot.x + 96).toBeLessThanOrEqual(CONTAINER_SIZE.width);
});

it('reads the coming-soon flag rather than a hard-coded list of nodes', () => {
  if (!forEach) return;
  forEach.comingSoon = true;
  const flagged = catalogGroups(workspace);
  const group = flagged.find((candidate) =>
    candidate.items.some((item) => item.type === 'for-each'),
  )!;
  expect(isComingSoon({ type: 'for-each' })).toBe(true);
  // A group is dimmed because every step in it is flagged, not because of
  // which category it is.
  expect(
    categorySoon({
      category: group.category,
      items: group.items.filter(isComingSoon),
    }),
  ).toBe(true);
  // The engine ships it: the flag goes, and the panel lists it as an
  // ordinary, addable step of whichever category the catalog files it under.
  delete forEach.comingSoon;
  const groups = catalogGroups(workspace);
  const real = groups.find((candidate) =>
    candidate.items.some((item) => item.type === 'for-each'),
  )!;
  const item = real.items.find((candidate) => candidate.type === 'for-each')!;
  expect(isComingSoon(item)).toBe(false);
  expect(categorySoon(real)).toBe(false);
  expect(real.category.id).toBe(
    NODE_CATALOG.find((category) =>
      category.nodes.some((spec) => spec.type === 'for-each'),
    )!.id,
  );
  const html = renderToStaticMarkup(
    <NodePanel workspace={workspace} onPick={() => {}} onClose={() => {}} />,
  );
  // Its real category is listed, counting the loop among its steps.
  expect(html).toContain(real.category.label.replace('&', '&amp;'));
  expect(html).toContain(`>${real.items.length}<`);
  expect(item.label).toBe('For each');
});

it('keeps the per-item handle inside the body and the rest on the edges', () => {
  if (!forEach) return;
  const outputs = forEach.outputs;
  // The engine's per-item output may not be declared yet; the container
  // draws whichever ports the catalog gives it, so the test supplies one.
  if (!outputs.some((port) => port.id === 'item'))
    forEach.outputs = [{ id: 'item', label: 'Item', kind: 'json' }, ...outputs];
  try {
    const html = card(container());
    expect(html).toContain('fcontainer-item');
    expect(html).toContain('data-handleid="item"');
    // The inside handle leaves towards the body rather than looping back
    // around the frame.
    expect(html).toMatch(
      new RegExp(`fcontainer-item[\\s\\S]*data-handlepos="${Position.Right}"`),
    );
    // The list input and the results output stay on the outer edges.
    expect(html).toContain('fcontainer-ports in');
    expect(html).toContain('fcontainer-ports out');
  } finally {
    forEach.outputs = outputs;
  }
});
