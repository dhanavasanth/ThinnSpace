/**
 * Editing model for the Flows canvas: a bounded undo/redo stack of graph
 * snapshots, the pure helpers that turn stored FlowNodes into React Flow
 * nodes and back (clone, free space, tidy, connection rules), and the
 * useFlowDocument hook that owns loading, autosave, linting, and history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Viewport,
} from '@xyflow/react';
import type { Dot, WorkspaceState } from '../../shared/types';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  createsCycle,
  kindsCompatible,
  lintFlow,
  newNodeId,
  nodeInputs,
  nodeLabel,
  nodeOutputs,
  type Flow,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowProblem,
} from '../../shared/flows';
import { ApiError, api, authHeaders } from '../api';
import type { EditorNode } from './FlowNodeCard';
import type { EditorEdge } from './FlowEdge';

export type Snapshot = Pick<FlowGraph, 'nodes' | 'edges'>;

export const HISTORY_LIMIT = 100;
/** Edits in the same group within this window replace the last entry. */
const COALESCE_MS = 900;

export interface History {
  past: Snapshot[];
  present: Snapshot;
  future: Snapshot[];
  group?: string;
  at: number;
}

export function snapshotKey(snapshot: Snapshot) {
  return JSON.stringify(snapshot);
}
export function createHistory(present: Snapshot): History {
  return { past: [], present, future: [], at: 0 };
}
/**
 * Push a snapshot. Identical snapshots are ignored; consecutive pushes with
 * the same `group` (typing in one field, nudging) collapse into one entry.
 */
export function pushHistory(
  history: History,
  next: Snapshot,
  group?: string,
): History {
  if (snapshotKey(next) === snapshotKey(history.present)) return history;
  const now = Date.now();
  const coalesce =
    group !== undefined &&
    history.group === group &&
    now - history.at < COALESCE_MS;
  const past = coalesce
    ? history.past
    : [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], group, at: now };
}
export function undoHistory(history: History): History | undefined {
  const previous = history.past.at(-1);
  if (!previous) return undefined;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    at: 0,
  };
}
export function redoHistory(history: History): History | undefined {
  const [next, ...rest] = history.future;
  if (!next) return undefined;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    at: 0,
  };
}

/* ---------- canvas model ---------- */

export const CARD_WIDTH = 240;
export const NOTE_SIZE = { width: 220, height: 140 };
const COLUMN_GAP = 320;
const ROW_GAP = 220;

export function isDecorative(type: string) {
  return !!NODE_SPECS[type]?.decorative;
}
export function resolveDot(
  node: FlowNode,
  workspace: WorkspaceState,
): Dot | undefined {
  const id = node.config.dot ?? node.config.slackDot;
  return typeof id === 'string'
    ? workspace.dots.find((dot) => dot.id === id)
    : undefined;
}
export function resolveSpaceName(
  node: FlowNode,
  workspace: WorkspaceState,
): string | undefined {
  const id = node.config.space ?? node.config.watchSpace;
  return typeof id === 'string'
    ? workspace.spaces.find((space) => space.id === id)?.name
    : undefined;
}

/** The accessible name of a card; React Flow's focusable wrapper carries it. */
export function nodeAriaLabel(node: FlowNode) {
  const spec = NODE_SPECS[node.type];
  const title = nodeLabel(node);
  return spec && spec.label !== title ? `${title} (${spec.label})` : title;
}
export function toEditorNode(
  node: FlowNode,
  workspace: WorkspaceState,
  problems: FlowProblem[],
  previous?: EditorNode,
): EditorNode {
  const decorative = isDecorative(node.type);
  return {
    id: node.id,
    type: 'flow',
    position: node.position,
    ariaLabel: nodeAriaLabel(node),
    data: {
      node,
      problems,
      dot: resolveDot(node, workspace),
      spaceName: resolveSpaceName(node, workspace),
      status: 'idle',
    },
    selected: previous?.selected ?? false,
    zIndex: decorative ? -1 : 0,
    ...(decorative
      ? {
          width: node.width ?? NOTE_SIZE.width,
          height: node.height ?? NOTE_SIZE.height,
        }
      : {}),
  };
}
export function toEditorEdge(edge: FlowEdge): EditorEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    type: 'flow',
  };
}
/** Apply a label/config/collapsed patch and re-resolve the Dot and Space. */
export function patchEditorNode(
  editorNode: EditorNode,
  patch: Partial<FlowNode>,
  workspace: WorkspaceState,
): EditorNode {
  const node = { ...editorNode.data.node, ...patch };
  return {
    ...editorNode,
    ariaLabel: nodeAriaLabel(node),
    data: {
      ...editorNode.data,
      node,
      dot: resolveDot(node, workspace),
      spaceName: resolveSpaceName(node, workspace),
    },
  };
}
/** The stored shape of what is on the canvas (positions rounded). */
export function serializeCanvas(
  nodes: EditorNode[],
  edges: EditorEdge[],
): Snapshot {
  return {
    nodes: nodes.map((editorNode) => {
      const node: FlowNode = {
        ...editorNode.data.node,
        position: {
          x: Math.round(editorNode.position.x),
          y: Math.round(editorNode.position.y),
        },
      };
      if (isDecorative(node.type)) {
        if (editorNode.width) node.width = Math.round(editorNode.width);
        if (editorNode.height) node.height = Math.round(editorNode.height);
      }
      return node;
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? '',
      target: edge.target,
      targetHandle: edge.targetHandle ?? '',
    })),
  };
}
export function toGraph(
  snapshot: Snapshot,
  viewport?: FlowGraph['viewport'],
): FlowGraph {
  return { schema: 1, ...snapshot, ...(viewport ? { viewport } : {}) };
}
/** Only the parts of a snapshot the linter cares about. */
export function structuralKey(snapshot: Snapshot) {
  return JSON.stringify({
    nodes: snapshot.nodes.map((node) => [
      node.id,
      node.type,
      node.typeVersion,
      node.label ?? '',
      node.config,
    ]),
    edges: snapshot.edges,
  });
}

/** Copy nodes and the edges between them with fresh ids, shifted by `offset`. */
export function cloneSubgraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  offset: number,
): Snapshot {
  const ids = new Map(nodes.map((node) => [node.id, newNodeId()]));
  return {
    nodes: nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      config: { ...node.config },
    })),
    edges: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        ...edge,
        id: newNodeId('e'),
        source: ids.get(edge.source)!,
        target: ids.get(edge.target)!,
      })),
  };
}

/** A spot at or near `wanted` that does not overlap an existing card. */
export function freeSpot(
  nodes: Pick<FlowNode, 'position'>[],
  wanted: { x: number; y: number },
) {
  const occupied = (x: number, y: number) =>
    nodes.some(
      (node) =>
        Math.abs(node.position.x - x) < CARD_WIDTH + 20 &&
        Math.abs(node.position.y - y) < 150,
    );
  let { x, y } = wanted;
  for (let step = 0; step < 40 && occupied(x, y); step += 1) {
    y += 60;
    if (step % 6 === 5) {
      y = wanted.y;
      x += CARD_WIDTH + 40;
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Left-to-right columns by topological depth; rows keep the nodes' relative
 * vertical order. Notes are left where they are.
 */
export function tidyLayout(snapshot: Snapshot) {
  const steps = snapshot.nodes.filter((node) => !isDecorative(node.type));
  const ids = new Set(steps.map((node) => node.id));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    parents.set(edge.target, [
      ...(parents.get(edge.target) ?? []),
      edge.source,
    ]);
    children.set(edge.source, [
      ...(children.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const depth = new Map<string, number>();
  const pending = new Map(
    steps.map((node) => [node.id, parents.get(node.id)?.length ?? 0]),
  );
  const queue = steps
    .filter((node) => !pending.get(node.id))
    .map((node) => node.id);
  while (queue.length) {
    const id = queue.shift()!;
    const level = depth.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, level + 1));
      const left = (pending.get(child) ?? 1) - 1;
      pending.set(child, left);
      if (left === 0) queue.push(child);
    }
  }
  const columns = new Map<number, FlowNode[]>();
  for (const node of steps) {
    const level = depth.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const minX = Math.min(...steps.map((node) => node.position.x), 80);
  const minY = Math.min(...steps.map((node) => node.position.y), 120);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, column] of columns) {
    column
      .sort((a, b) => a.position.y - b.position.y)
      .forEach((node, row) =>
        positions.set(node.id, {
          x: minX + level * COLUMN_GAP,
          y: minY + row * ROW_GAP,
        }),
      );
  }
  return positions;
}

/* ---------- connection rules ---------- */

/** Why a connection is not allowed, or null when it is. */
export function connectionProblem(
  nodes: EditorNode[],
  edges: EditorEdge[],
  c: Connection | EditorEdge,
): string | null {
  const source = nodes.find((n) => n.id === c.source);
  const target = nodes.find((n) => n.id === c.target);
  if (!source || !target) return 'That step no longer exists.';
  if (c.source === c.target) return 'A step cannot connect to itself.';
  if (
    isDecorative(source.data.node.type) ||
    isDecorative(target.data.node.type)
  )
    return 'Notes do not take connections.';
  const out = nodeOutputs(source.data.node).find(
    (p) => p.id === c.sourceHandle,
  );
  const inp = nodeInputs(target.data.node).find((p) => p.id === c.targetHandle);
  if (!out || !inp) return 'Connect an output to an input.';
  if (!kindsCompatible(out.kind, inp.kind))
    return `${out.label} sends ${out.kind}, but ${inp.label} expects ${inp.kind}.`;
  if (
    edges.some(
      (e) =>
        e.source === c.source &&
        e.sourceHandle === c.sourceHandle &&
        e.target === c.target &&
        e.targetHandle === c.targetHandle,
    )
  )
    return 'These are already connected.';
  if (
    !inp.multiple &&
    edges.some(
      (e) => e.target === c.target && e.targetHandle === c.targetHandle,
    )
  )
    return `${inp.label} accepts one connection. Remove the existing one first.`;
  if (createsCycle(edges, c.source, c.target))
    return 'Flows cannot loop back on themselves.';
  return null;
}
/** An edge from `from` into the first compatible input of `node`, if any. */
export function edgeFrom(
  nodes: EditorNode[],
  from: { nodeId: string; port: string },
  node: FlowNode,
): EditorEdge | undefined {
  const source = nodes.find((n) => n.id === from.nodeId);
  const out =
    source && nodeOutputs(source.data.node).find((p) => p.id === from.port);
  const inp =
    out && nodeInputs(node).find((p) => kindsCompatible(out.kind, p.kind));
  if (!source || !out || !inp) return undefined;
  return {
    id: newNodeId('e'),
    source: source.id,
    sourceHandle: out.id,
    target: node.id,
    targetHandle: inp.id,
    type: 'flow',
  };
}

/* ---------- document hook ---------- */

export type SaveState =
  | { status: 'saved'; at: number }
  | { status: 'saving' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'conflict' };
export const AUTOSAVE_MS = 1500;
/** Longest pause between automatic retries after a network or server error. */
const RETRY_CAP_MS = 30_000;
const LINT_MS = 150;

export interface FlowDocumentOptions {
  flowId: string;
  workspace: WorkspaceState;
  onDirty: (dirty: boolean) => void;
  onRefresh: () => void;
}

/** Every flow keeps at least one Start; the last one cannot be removed. */
export function canRemove(nodes: Pick<FlowNode, 'id' | 'type'>[], id: string) {
  const node = nodes.find((n) => n.id === id);
  if (!node || node.type !== 'start') return true;
  return nodes.filter((n) => n.type === 'start').length > 1;
}

/** Copy of a node's measured size so edges keep drawing across a rebuild. */
function carryMeasured(
  previous: EditorNode | undefined,
): Pick<EditorNode, 'measured'> {
  return previous?.measured ? { measured: previous.measured } : {};
}

/** PUT that survives page unload; otherwise the same as `api`. */
async function putFlow(id: string, body: unknown, keepalive: boolean) {
  if (!keepalive) return api<Flow>(`/flows/${id}`, 'PUT', body);
  const response = await fetch(`/api/flows/${id}`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await response
    .json()
    .catch(() => ({ error: 'Server returned an unreadable response.' }))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  return data as Flow;
}
/** A message the header chip can show, with a hint for rejected saves. */
function saveErrorMessage(cause: unknown) {
  if (!(cause instanceof ApiError))
    return 'Could not reach the server. Your edits are kept here and will be retried.';
  if (cause.status >= 500) return `${cause.message} Retrying shortly.`;
  if (cause.status === 400)
    return `${cause.message} Check step names (${FLOW_LIMITS.name} characters max), note sizes, and the ${FLOW_LIMITS.nodes}-step limit, then edit again to retry.`;
  return cause.message;
}

/**
 * Loads the flow, keeps the canvas state, runs the linter, autosaves with
 * optimistic concurrency, and records history. Interaction handlers live in
 * FlowEditor; this is the document underneath them.
 */
export function useFlowDocument({
  flowId,
  workspace,
  onDirty,
  onRefresh,
}: FlowDocumentOptions) {
  const rf = useReactFlow<EditorNode, EditorEdge>();
  const nodesInitialized = useNodesInitialized();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<EditorNode[]>([]);
  const [edges, setEdges] = useState<EditorEdge[]>([]);
  const [problems, setProblems] = useState<FlowProblem[]>([]);
  const [savedKey, setSavedKey] = useState('');
  const [saveState, setSaveState] = useState<SaveState>({
    status: 'saved',
    at: 0,
  });
  const [pendingView, setPendingView] = useState<Viewport | 'fit' | null>(null);
  const [name, setName] = useState('');
  const [, setTick] = useState(0);
  const history = useRef(createHistory({ nodes: [], edges: [] }));
  // The refs are the single source of truth for what is on the canvas: every
  // write goes through setCanvas, so handlers that run between renders (drag
  // stop, resize end, keyboard shortcuts) never see a stale array.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const flowRef = useRef(flow);
  const savedKeyRef = useRef(savedKey);
  // The shell refreshes workspace state on a timer; reading it through a ref
  // keeps load/adopt stable so a poll never re-fetches (and resets) the flow.
  const workspaceRef = useRef(workspace);
  const problemsRef = useRef(problems);
  // Saves are serialised; a reload bumps the generation so a late response
  // from a superseded request cannot overwrite the fresh document.
  const inflight = useRef<Promise<Flow | null> | null>(null);
  const generation = useRef(0);
  const failedKey = useRef<string | null>(null);
  const attempts = useRef(0);
  flowRef.current = flow;
  savedKeyRef.current = savedKey;
  workspaceRef.current = workspace;
  problemsRef.current = problems;

  // Derived from the committed history snapshot rather than live React Flow
  // state, so a drag does not serialise the whole graph on every frame.
  const snapshot = history.current.present;
  const key = useMemo(() => snapshotKey(snapshot), [snapshot]);
  const lintKey = useMemo(() => structuralKey(snapshot), [snapshot]);
  const graph = useMemo(() => toGraph(snapshot), [snapshot]);
  const dirty = !!flow && key !== savedKey;

  const setCanvas = useCallback(
    (nextNodes: EditorNode[], nextEdges: EditorEdge[]) => {
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
    },
    [],
  );
  /** Apply an edit and record it in the undo stack. */
  const mutate = useCallback(
    (
      edit: (
        nodes: EditorNode[],
        edges: EditorEdge[],
      ) => { nodes?: EditorNode[]; edges?: EditorEdge[] },
      group?: string,
    ) => {
      const result = edit(nodesRef.current, edgesRef.current);
      const nextNodes = result.nodes ?? nodesRef.current;
      const nextEdges = result.edges ?? edgesRef.current;
      setCanvas(nextNodes, nextEdges);
      history.current = pushHistory(
        history.current,
        serializeCanvas(nextNodes, nextEdges),
        group,
      );
      setTick((tick) => tick + 1);
    },
    [setCanvas],
  );
  /**
   * Record the canvas as it is. Deferred one task so it runs after the change
   * React Flow dispatches in the same tick (drag stop, resize end).
   */
  const commit = useCallback(() => {
    window.setTimeout(() => mutate(() => ({})), 0);
  }, [mutate]);
  const restoreSnapshot = useCallback(
    (snap: Snapshot) => {
      const before = new Map(nodesRef.current.map((n) => [n.id, n]));
      setCanvas(
        snap.nodes.map((node) => {
          const previous = before.get(node.id);
          if (
            previous &&
            previous.position.x === node.position.x &&
            previous.position.y === node.position.y &&
            JSON.stringify(previous.data.node) === JSON.stringify(node)
          )
            return previous;
          return {
            ...toEditorNode(
              node,
              workspaceRef.current,
              previous?.data.problems ?? [],
              previous,
            ),
            ...carryMeasured(previous),
          };
        }),
        snap.edges.map(toEditorEdge),
      );
    },
    [setCanvas],
  );
  const step = useCallback(
    (move: (history: History) => History | undefined) => {
      const next = move(history.current);
      if (!next) return;
      history.current = next;
      restoreSnapshot(next.present);
      setTick((tick) => tick + 1);
    },
    [restoreSnapshot],
  );
  const undo = useCallback(() => step(undoHistory), [step]);
  const redo = useCallback(() => step(redoHistory), [step]);

  /** Replace everything with a flow from the server. */
  const adopt = useCallback(
    (loaded: Flow) => {
      generation.current += 1;
      failedKey.current = null;
      attempts.current = 0;
      const before = new Map(nodesRef.current.map((n) => [n.id, n]));
      // A fresh flow opens trigger-first: its lone Start is selected so the
      // properties panel asks "What starts this flow?" straight away.
      const triggerFirst =
        loaded.graph.nodes.length === 1 &&
        loaded.graph.nodes[0].type === 'start';
      const nextNodes = loaded.graph.nodes.map((node) => ({
        ...toEditorNode(node, workspaceRef.current, []),
        ...carryMeasured(before.get(node.id)),
        selected: triggerFirst,
      }));
      const nextEdges = loaded.graph.edges.map(toEditorEdge);
      setCanvas(nextNodes, nextEdges);
      const snap = serializeCanvas(nextNodes, nextEdges);
      history.current = createHistory(snap);
      setTick((tick) => tick + 1);
      savedKeyRef.current = snapshotKey(snap);
      setSavedKey(savedKeyRef.current);
      flowRef.current = loaded;
      setFlow(loaded);
      setName(loaded.name);
      setSaveState({ status: 'saved', at: loaded.updatedAt });
      setPendingView(loaded.graph.viewport ?? 'fit');
    },
    [setCanvas],
  );
  /**
   * Applies a fresh flow record whose graph matches what is on the canvas
   * (publish, unpublish): the status fields change, the canvas and history
   * stay put.
   */
  const adoptMeta = useCallback((loaded: Flow) => {
    flowRef.current = loaded;
    setFlow(loaded);
    setName(loaded.name);
  }, []);
  const load = useCallback(async () => {
    setLoadError(null);
    setFlow(null);
    try {
      adopt(await api<Flow>(`/flows/${flowId}`));
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : 'Could not load this flow.',
      );
    }
  }, [adopt, flowId]);
  useEffect(() => {
    void load();
  }, [load]);
  // The requested view is consumed only once React Flow has applied it, so a
  // stale `nodesInitialized` from the previous graph cannot swallow a fit.
  useEffect(() => {
    if (!pendingView || !nodesInitialized) return;
    let cancelled = false;
    const applied =
      pendingView === 'fit'
        ? rf.fitView({ padding: 0.2, maxZoom: 1 })
        : rf.setViewport(pendingView);
    void applied.then((done) => {
      if (!cancelled && done) setPendingView(null);
    });
    return () => {
      cancelled = true;
    };
  }, [pendingView, nodesInitialized, rf]);

  /** The PUT itself; callers go through saveNow so requests never overlap. */
  const performSave = useCallback(
    async (extra: {
      name?: string;
      keepalive?: boolean;
    }): Promise<Flow | null> => {
      const current = flowRef.current;
      if (!current) return null;
      const gen = generation.current;
      const snap = serializeCanvas(nodesRef.current, edgesRef.current);
      const nextKey = snapshotKey(snap);
      const graphChanged = nextKey !== savedKeyRef.current;
      if (!graphChanged && extra.name === undefined) return current;
      setSaveState({ status: 'saving' });
      try {
        const updated = await putFlow(
          current.id,
          {
            revision: current.revision,
            ...(graphChanged ? { graph: toGraph(snap, rf.getViewport()) } : {}),
            ...(extra.name !== undefined ? { name: extra.name } : {}),
          },
          extra.keepalive === true,
        );
        if (gen !== generation.current) return null;
        flowRef.current = updated;
        setFlow(updated);
        setName(updated.name);
        savedKeyRef.current = nextKey;
        setSavedKey(nextKey);
        failedKey.current = null;
        attempts.current = 0;
        setSaveState({ status: 'saved', at: updated.updatedAt });
        if (extra.name !== undefined) onRefresh();
        return updated;
      } catch (cause) {
        if (gen !== generation.current) return null;
        // A rename that did not reach the server is not shown as applied.
        if (extra.name !== undefined) setName(current.name);
        failedKey.current = nextKey;
        if (cause instanceof ApiError && cause.status === 409) {
          setSaveState({ status: 'conflict' });
        } else {
          const retryable = !(cause instanceof ApiError) || cause.status >= 500;
          if (retryable) attempts.current += 1;
          setSaveState({
            status: 'error',
            message: saveErrorMessage(cause),
            retryable,
          });
        }
        return null;
      }
    },
    [onRefresh, rf],
  );
  /** PUT the graph (and optionally a new name), queued behind any save in flight. */
  const saveNow = useCallback(
    (extra: { name?: string; keepalive?: boolean } = {}) => {
      const previous = inflight.current ?? Promise.resolve(null);
      const next: Promise<Flow | null> = previous.then(() =>
        performSave(extra),
      );
      inflight.current = next;
      void next.finally(() => {
        if (inflight.current === next) inflight.current = null;
      });
      return next;
    },
    [performSave],
  );
  /** True while edits exist that the server has not confirmed. */
  const hasUnsaved = useCallback(
    () =>
      !!flowRef.current &&
      (inflight.current !== null ||
        snapshotKey(serializeCanvas(nodesRef.current, edgesRef.current)) !==
          savedKeyRef.current),
    [],
  );
  // The shell only needs to guard navigation when a save actually failed;
  // the autosave window and the unmount flush cover everything else.
  const atRisk =
    dirty && (saveState.status === 'error' || saveState.status === 'conflict');
  useEffect(() => {
    onDirty(atRisk);
  }, [atRisk, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const saveNowRef = useRef(saveNow);
  const hasUnsavedRef = useRef(hasUnsaved);
  saveNowRef.current = saveNow;
  hasUnsavedRef.current = hasUnsaved;
  // Leaving the editor inside the autosave window still saves (best effort).
  useEffect(
    () => () => {
      void saveNowRef.current();
    },
    [],
  );
  // Closing or reloading the tab: flush with keepalive and let the browser
  // ask, since a request still in flight may not finish otherwise.
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedRef.current()) return;
      event.preventDefault();
      void saveNowRef.current({ keepalive: true });
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);
  useEffect(() => {
    if (
      !dirty ||
      saveState.status === 'saving' ||
      saveState.status === 'conflict'
    )
      return;
    let delay = AUTOSAVE_MS;
    if (saveState.status === 'error') {
      // A rejected graph is only re-sent after another edit (or ⌘S); a
      // network or server failure backs off instead of hammering.
      if (!saveState.retryable && failedKey.current === key) return;
      if (saveState.retryable)
        delay = Math.min(RETRY_CAP_MS, AUTOSAVE_MS * 2 ** attempts.current);
    }
    const timer = window.setTimeout(() => void saveNow(), delay);
    return () => window.clearTimeout(timer);
  }, [dirty, key, saveState, saveNow]);

  // Lint on every structural change and paint the results onto cards/edges.
  // Dots and Spaces are keyed by id so the 3s workspace poll does not re-lint.
  const dotsKey = workspace.dots.map((dot) => dot.id).join();
  const spacesKey = workspace.spaces.map((space) => space.id).join();
  useEffect(() => {
    if (!flow) return;
    const timer = window.setTimeout(() => {
      const found = lintFlow(
        toGraph(serializeCanvas(nodesRef.current, edgesRef.current)),
        {
          dots: workspaceRef.current.dots,
          spaces: workspaceRef.current.spaces,
        },
      );
      if (JSON.stringify(found) !== JSON.stringify(problemsRef.current))
        setProblems(found);
      let changed = false;
      const nextNodes = nodesRef.current.map((node) => {
        const mine = found.filter((p) => p.nodeId === node.id);
        if (JSON.stringify(mine) === JSON.stringify(node.data.problems))
          return node;
        changed = true;
        return { ...node, data: { ...node.data, problems: mine } };
      });
      const bad = new Set(
        found
          .filter((p) => p.level === 'error' && p.edgeId)
          .map((p) => p.edgeId),
      );
      const nextEdges = edgesRef.current.map((edge) => {
        const className = bad.has(edge.id) ? 'has-problem' : undefined;
        if (edge.className === className) return edge;
        changed = true;
        return { ...edge, className };
      });
      if (changed) setCanvas(nextNodes, nextEdges);
    }, LINT_MS);
    return () => window.clearTimeout(timer);
  }, [lintKey, flow, dotsKey, spacesKey, setCanvas]);
  // Dots and Spaces can be renamed, re-instructed or removed while the editor is open.
  useEffect(() => {
    let changed = false;
    const next = nodesRef.current.map((node) => {
      const resolved = patchEditorNode(node, {}, workspace);
      const was = node.data.dot;
      const now = resolved.data.dot;
      if (
        was?.id === now?.id &&
        was?.name === now?.name &&
        was?.avatar === now?.avatar &&
        was?.instructions === now?.instructions &&
        resolved.data.spaceName === node.data.spaceName
      )
        return node;
      changed = true;
      return resolved;
    });
    if (changed) setCanvas(next, edgesRef.current);
  }, [workspace, setCanvas]);

  return {
    rf,
    flow,
    flowRef,
    loadError,
    nodes,
    edges,
    nodesRef,
    edgesRef,
    setCanvas,
    snapshot,
    graph,
    dirty,
    problems,
    setProblems,
    saveState,
    name,
    setName,
    mutate,
    commit,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    adopt,
    adoptMeta,
    load,
    saveNow,
    hasUnsaved,
  };
}

/* ---------- canvas edits ---------- */

export type FlowDocument = ReturnType<typeof useFlowDocument>;
/** Why adding `nodes`/`edges` more would exceed the server limits, or null. */
export function roomFor(
  nodeCount: number,
  edgeCount: number,
  nodes: number,
  edges = 0,
): string | null {
  if (nodeCount + nodes > FLOW_LIMITS.nodes)
    return `Flows are limited to ${FLOW_LIMITS.nodes} steps.`;
  if (edgeCount + edges > FLOW_LIMITS.edges)
    return `Flows are limited to ${FLOW_LIMITS.edges} connections.`;
  return null;
}
export const motionMs = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 320;
export const deselect = (nodes: EditorNode[]) =>
  nodes.map((n) => (n.selected ? { ...n, selected: false } : n));

/** Remove, copy, paste, duplicate, nudge, collapse, tidy, and focus. */
export function useCanvasEdits(
  {
    nodesRef,
    edgesRef,
    mutate,
    setCanvas,
    rf,
  }: Pick<
    FlowDocument,
    'nodesRef' | 'edgesRef' | 'mutate' | 'setCanvas' | 'rf'
  >,
  workspace: WorkspaceState,
  notify: (message: string) => void,
) {
  const clipboard = useRef<Snapshot | null>(null);
  const pasteCount = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const removeNodes = useCallback(
    (ids: string[], edgeIds: string[] = []) => {
      // A flow keeps at least one Start; the last one cannot be deleted.
      const starts = nodesRef.current
        .filter((n) => n.data.node.type === 'start')
        .map((n) => n.id);
      const survivingStart = starts.find((id) => !ids.includes(id));
      const kept = survivingStart ? ids : ids.filter((id) => id !== starts[0]);
      if (kept.length !== ids.length)
        notify('Every flow begins with a Start, so this one stays.');
      if (!kept.length && !edgeIds.length) return;
      const gone = new Set(kept);
      mutate((current, currentEdges) => ({
        nodes: current.filter((n) => !gone.has(n.id)),
        edges: currentEdges.filter(
          (e) =>
            !gone.has(e.source) &&
            !gone.has(e.target) &&
            !edgeIds.includes(e.id),
        ),
      }));
    },
    [mutate, nodesRef, notify],
  );
  const removeSelected = useCallback(
    () =>
      removeNodes(
        nodesRef.current.filter((n) => n.selected).map((n) => n.id),
        edgesRef.current.filter((e) => e.selected).map((e) => e.id),
      ),
    [edgesRef, nodesRef, removeNodes],
  );
  /** The named steps with the edges between them. */
  const subgraph = useCallback(
    (ids: string[]) => {
      const picked = nodesRef.current.filter((n) => ids.includes(n.id));
      const set = new Set(picked.map((n) => n.id));
      return serializeCanvas(
        picked,
        edgesRef.current.filter((e) => set.has(e.source) && set.has(e.target)),
      );
    },
    [edgesRef, nodesRef],
  );
  const insert = useCallback(
    (snap: Snapshot, offset: number) => {
      const room = roomFor(
        nodesRef.current.length,
        edgesRef.current.length,
        snap.nodes.length,
        snap.edges.length,
      );
      if (room) return notify(room);
      const clone = cloneSubgraph(snap.nodes, snap.edges, offset);
      mutate((current, currentEdges) => ({
        nodes: [
          ...deselect(current),
          ...clone.nodes.map((node) => ({
            ...toEditorNode(node, workspaceRef.current, []),
            selected: true,
          })),
        ],
        edges: [...currentEdges, ...clone.edges.map(toEditorEdge)],
      }));
    },
    [edgesRef, mutate, nodesRef, notify],
  );
  const copySelection = useCallback(() => {
    const snap = subgraph(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id),
    );
    if (!snap.nodes.length) return notify('Select a step to copy first.');
    clipboard.current = snap;
    pasteCount.current = 0;
    const count = snap.nodes.length;
    notify(`Copied ${count} ${count === 1 ? 'step' : 'steps'}.`);
  }, [nodesRef, notify, subgraph]);
  const paste = useCallback(() => {
    if (!clipboard.current) return;
    pasteCount.current += 1;
    insert(clipboard.current, 40 * pasteCount.current);
  }, [insert]);
  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const snap = subgraph(ids);
      if (!snap.nodes.length) return notify('Select a step to duplicate.');
      insert(snap, 40);
    },
    [insert, notify, subgraph],
  );
  const nudge = useCallback(
    (dx: number, dy: number) =>
      mutate(
        (current) => ({
          nodes: current.map((n) =>
            n.selected
              ? {
                  ...n,
                  position: { x: n.position.x + dx, y: n.position.y + dy },
                }
              : n,
          ),
        }),
        'nudge',
      ),
    [mutate],
  );
  const collapseSelected = useCallback(
    () =>
      mutate((current) => ({
        nodes: current.map((n) =>
          n.selected && !isDecorative(n.data.node.type)
            ? patchEditorNode(
                n,
                { collapsed: !n.data.node.collapsed },
                workspaceRef.current,
              )
            : n,
        ),
      })),
    [mutate],
  );
  const tidy = useCallback(() => {
    const positions = tidyLayout(
      serializeCanvas(nodesRef.current, edgesRef.current),
    );
    mutate((current) => ({
      nodes: current.map((n) =>
        positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n,
      ),
    }));
    window.requestAnimationFrame(
      () => void rf.fitView({ padding: 0.2, maxZoom: 1, duration: motionMs() }),
    );
  }, [edgesRef, mutate, nodesRef, rf]);
  const focusProblem = useCallback(
    (problem: FlowProblem) => {
      if (problem.nodeId) {
        const node = nodesRef.current.find((n) => n.id === problem.nodeId);
        if (!node) return;
        setCanvas(
          nodesRef.current.map((n) => ({ ...n, selected: n.id === node.id })),
          edgesRef.current.map((e) =>
            e.selected ? { ...e, selected: false } : e,
          ),
        );
        void rf.setCenter(node.position.x + 120, node.position.y + 60, {
          zoom: Math.max(rf.getZoom(), 1),
          duration: motionMs(),
        });
      } else if (problem.edgeId) {
        setCanvas(
          deselect(nodesRef.current),
          edgesRef.current.map((e) => ({
            ...e,
            selected: e.id === problem.edgeId,
          })),
        );
      }
    },
    [edgesRef, nodesRef, rf, setCanvas],
  );
  return {
    removeNodes,
    removeSelected,
    copySelection,
    paste,
    duplicateNodes,
    nudge,
    collapseSelected,
    tidy,
    focusProblem,
  };
}
