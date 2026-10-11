import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {},
}));
import {
  emptyGraph,
  lintFlow,
  makeNode,
  newNodeId,
  renameToken,
  tokenSlug,
  type FlowGraph,
  type FlowNode,
} from '../src/shared/flows';
import {
  applyNodePatch,
  createHistory,
  pushHistory,
  redoHistory,
  serializeCanvas,
  toEditorNode,
  undoHistory,
} from '../src/client/flows/flow-history';
import type { WorkspaceState } from '../src/shared/types';

const context = { dots: [{ id: 'd1' }], spaces: [{ id: 's1' }] };
const workspace: WorkspaceState = {
  spaces: [],
  dots: [],
  avatars: [],
  flows: [],
  conversations: [],
  setup: {
    intelligence: true,
    model: true,
    browser: false,
    voice: false,
    slack: 'offline',
    missing: [],
  },
  calls: [],
};
const codes = (graph: FlowGraph) =>
  lintFlow(graph, context).map((problem) => `${problem.level}:${problem.code}`);
const connect = (
  graph: FlowGraph,
  source: FlowNode,
  target: FlowNode,
  sourceHandle = 'result',
  targetHandle = 'context',
) => {
  graph.edges.push({
    id: newNodeId('e'),
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
  });
};
/** Start -> research -> writer, with the writer quoting the researcher. */
function chain() {
  const graph = emptyGraph();
  const research = makeNode(
    'dot-task',
    { x: 300, y: 160 },
    { dot: 'd1', task: 'Research {{start.input}}' },
  );
  research.label = 'Research';
  const writer = makeNode(
    'dot-task',
    { x: 600, y: 160 },
    {
      dot: 'd1',
      task: 'Write up {{research.result}} and cite {{ research.data }}.',
      expectedOutput: 'Mentions research in prose, not as a chip.',
      perItem: false,
    },
  );
  writer.label = 'Writer';
  graph.nodes.push(research, writer);
  connect(graph, graph.nodes[0], research, 'started');
  connect(graph, research, writer);
  return { graph, research, writer };
}
const nodeById = (graph: FlowGraph, id: string) =>
  graph.nodes.find((node) => node.id === id)!;

it('rewrites downstream references when a node is renamed', () => {
  const { graph, research, writer } = chain();
  const next = renameToken(graph, research.id, 'Research', 'Desk research');
  expect(next).not.toBe(graph);
  const renamed = nodeById(next, writer.id);
  expect(renamed.config.task).toBe(
    'Write up {{desk_research.result}} and cite {{ desk_research.data }}.',
  );
  // Prose that merely mentions the old name is left alone, as is the renamed
  // node's own config and the rest of the graph.
  expect(renamed.config.expectedOutput).toBe(
    'Mentions research in prose, not as a chip.',
  );
  expect(renamed.config.perItem).toBe(false);
  expect(nodeById(next, research.id).config.task).toBe(
    'Research {{start.input}}',
  );
  expect(next.edges).toEqual(graph.edges);
  // The original graph is untouched: a rename is a new graph, not a mutation.
  expect(writer.config.task).toBe(
    'Write up {{research.result}} and cite {{ research.data }}.',
  );
});

it('leaves references alone when the new slug belongs to another node', () => {
  const { graph, research, writer } = chain();
  // Renaming Research to "Writer" would make {{writer.…}} ambiguous.
  expect(tokenSlug(writer)).toBe('writer');
  expect(renameToken(graph, research.id, 'Research', 'Writer')).toBe(graph);
  expect(renameToken(graph, research.id, 'Research', 'writer!')).toBe(graph);
});

it('leaves references alone when another node still answers to the old slug', () => {
  // Two unlabelled cards of the same type is the default state, and
  // upstreamRefs disambiguates them positionally (`web_research`,
  // `web_research_2`). Rewriting the second one's slug would repoint the
  // first one's chip at it — a valid token that reads the wrong step.
  const graph = emptyGraph();
  const first = makeNode('web-research', { x: 300, y: 0 }, { query: 'a' });
  const second = makeNode('web-research', { x: 300, y: 200 }, { query: 'b' });
  const brief = makeNode(
    'dot-task',
    { x: 600, y: 100 },
    {
      dot: 'd1',
      task: 'first={{web_research.findings}} second={{web_research_2.findings}}',
    },
  );
  graph.nodes.push(first, second, brief);
  connect(graph, graph.nodes[0], first, 'started', 'query');
  connect(graph, graph.nodes[0], second, 'started', 'query');
  connect(graph, first, brief, 'findings', 'context');
  connect(graph, second, brief, 'findings', 'context');
  expect(tokenSlug(first)).toBe(tokenSlug(second));
  expect(renameToken(graph, second.id, undefined, 'Market scan')).toBe(graph);
  // And the mirror case: renaming the card that owns the bare slug would
  // renumber its sibling and orphan that chip.
  expect(renameToken(graph, first.id, undefined, 'Market scan')).toBe(graph);
  // Both stale references stay visible to the linter instead.
  expect(codes(graph)).not.toContain('warning:unknown-token');
});

it('carries the key path of an indexed chip through a rename', () => {
  const { graph, research, writer } = chain();
  nodeById(graph, writer.id).config.task =
    'score {{research.data.score}} and plain {{research.result}}';
  const next = renameToken(graph, research.id, 'Research', 'Desk research');
  expect(nodeById(next, writer.id).config.task).toBe(
    'score {{desk_research.data.score}} and plain {{desk_research.result}}',
  );
  // A path chip left behind would resolve to '' at run time, so the linter
  // has to see that shape too.
  const stale = emptyGraph();
  const reader = makeNode(
    'dot-task',
    { x: 300, y: 0 },
    { dot: 'd1', task: 'Use {{nobody.data.headline}}' },
  );
  stale.nodes.push(reader);
  connect(stale, stale.nodes[0], reader, 'started');
  expect(codes(stale)).toContain('warning:unknown-token');
});

it('is a no-op when the slug does not change', () => {
  const { graph, research } = chain();
  expect(renameToken(graph, research.id, 'Research', 'research')).toBe(graph);
  expect(renameToken(graph, research.id, 'Research', '  Research  ')).toBe(
    graph,
  );
  // Nothing upstream or sideways of the rename is rewritten either.
  const { graph: other, writer } = chain();
  expect(renameToken(other, writer.id, 'Writer', 'Editor')).toBe(other);
  expect(renameToken(graph, 'gone', 'Research', 'Editor')).toBe(graph);
});

it('falls back to the catalog label when a name is cleared', () => {
  const { graph, research, writer } = chain();
  const next = renameToken(graph, research.id, 'Research', undefined);
  expect(nodeById(next, writer.id).config.task).toBe(
    'Write up {{dot_task.result}} and cite {{ dot_task.data }}.',
  );
});

it('warns at design time about a Slack-destined Send message', () => {
  const graph = emptyGraph();
  const send = makeNode(
    'send-message',
    { x: 300, y: 160 },
    { destination: 'slack', slackChannel: '#team', message: 'hi' },
  );
  graph.nodes.push(send);
  connect(graph, graph.nodes[0], send, 'started', 'content');
  expect(codes(graph)).toContain('warning:slack-proactive-unavailable');
  expect(
    lintFlow(graph, context).find(
      (problem) => problem.code === 'slack-proactive-unavailable',
    )?.message,
  ).toContain('Slack delivery is not available yet; this step will fail.');
  // Saving the draft stays allowed: the Slack problem is never an error.
  expect(codes(graph)).not.toContain('error:slack-proactive-unavailable');

  // Replying in the thread that started the run is implemented, so it is no
  // longer a Slack-unavailable warning; what it needs is a Slack Start, and
  // this graph starts manually.
  send.config.destination = 'thread';
  expect(codes(graph)).not.toContain('warning:slack-proactive-unavailable');
  expect(codes(graph)).toContain('warning:reply-without-slack-start');

  send.config.destination = 'inbox';
  expect(codes(graph)).not.toContain('warning:slack-proactive-unavailable');
});

it('renames a card and repairs its chips in one canvas edit', () => {
  const { graph, research, writer } = chain();
  const nodes = graph.nodes.map((node) => toEditorNode(node, workspace, []));
  const edges = graph.edges.map((edge) => ({ ...edge, type: 'flow' as const }));
  const renamed = applyNodePatch(
    nodes,
    edges,
    research.id,
    { label: 'Desk research' },
    workspace,
  );
  const after = serializeCanvas(renamed, edges);
  const saved = (id: string) => after.nodes.find((node) => node.id === id)!;
  expect(saved(research.id).label).toBe('Desk research');
  expect(saved(writer.id).config.task).toBe(
    'Write up {{desk_research.result}} and cite {{ desk_research.data }}.',
  );
  // A config-only patch leaves every other card alone.
  const configOnly = applyNodePatch(
    nodes,
    edges,
    writer.id,
    { config: { ...writer.config, dot: 'd1' } },
    workspace,
  );
  const touched = configOnly.filter((node, index) => node !== nodes[index]);
  expect(touched.map((node) => node.id)).toEqual([writer.id]);
});

it('takes a rename and its repaired chips back in a single undo', () => {
  // The editor runs applyNodePatch inside one mutate(), which is one
  // pushHistory. This is that sequence without React: one undo has to put
  // both the label and the downstream chip back.
  const { graph, research, writer } = chain();
  const nodes = graph.nodes.map((node) => toEditorNode(node, workspace, []));
  const edges = graph.edges.map((edge) => ({ ...edge, type: 'flow' as const }));
  let history = createHistory(serializeCanvas(nodes, edges));
  const renamed = applyNodePatch(
    nodes,
    edges,
    research.id,
    { label: 'Desk research' },
    workspace,
  );
  history = pushHistory(
    history,
    serializeCanvas(renamed, edges),
    `rename:${research.id}`,
  );
  const at = (snapshot: { nodes: FlowNode[] }, id: string) =>
    snapshot.nodes.find((node) => node.id === id)!;
  expect(at(history.present, research.id).label).toBe('Desk research');
  expect(at(history.present, writer.id).config.task).toContain(
    '{{desk_research.result}}',
  );

  const undone = undoHistory(history)!;
  // One step back, and neither half of the edit survives.
  expect(undone.past).toHaveLength(0);
  expect(at(undone.present, research.id).label).toBe('Research');
  expect(at(undone.present, writer.id).config.task).toBe(
    'Write up {{research.result}} and cite {{ research.data }}.',
  );

  // And one step forward restores both together.
  const redone = redoHistory(undone)!;
  expect(at(redone.present, research.id).label).toBe('Desk research');
  expect(at(redone.present, writer.id).config.task).toContain(
    '{{desk_research.result}}',
  );
});
