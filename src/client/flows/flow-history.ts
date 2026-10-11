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
  renameToken,
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
/** The icon square a step card draws; its label block hangs outside the box. */
export const CARD_SQUARE = 96;
export const NOTE_SIZE = { width: 220, height: 140 };
const COLUMN_GAP = 320;
const ROW_GAP = 220;
/** For each containers: the size they start at and the floor the resizer keeps. */
export const CONTAINER_SIZE = { width: 480, height: 300 };
export const CONTAINER_MIN = { width: 320, height: 220 };
/** Header strip height and the padding around the body area inside it. */
export const CONTAINER_HEADER = 48;
export const CONTAINER_PAD = 18;
/** Body cards are the 96px squares, so they sit closer than outer columns. */
const BODY_COLUMN_GAP = 150;
const BODY_ROW_GAP = 160;
/** The label block under a card's icon square, which the square's box excludes. */
export const CARD_LABEL = 52;
/**
 * The box a step card really occupies: the icon square plus the label block
 * hanging under it. Used wherever a card has to fit inside a container, so a
 * stored position matches what React Flow then draws from the measured height.
 */
export const BODY_CARD = {
  width: CARD_SQUARE,
  height: CARD_SQUARE + CARD_LABEL,
};

export function isDecorative(type: string) {
  return !!NODE_SPECS[type]?.decorative;
}
/**
 * A container is drawn as a body that other cards live inside. The shared
 * model allows `for-each` only (see `canContain`) and containers never nest,
 * so one level of parent/child is all the canvas ever has to resolve.
 */
export function isContainer(type: string) {
  return type === 'for-each';
}
/**
 * Whether a step may live inside a container's body. Containers never nest,
 * and control flow belongs to the outer graph: a Start inside a body is
 * never fired (the container drives the body, not the trigger) and a Finish
 * inside one would rewrite the run result once per item. `lintFlow`'s
 * `body-not-supported` rule refuses the same three types, so an imported
 * graph is reported as well as a dragged one.
 */
export function canBeContained(type: string) {
  return !isContainer(type) && type !== 'start' && type !== 'finish';
}
/** The box a stored node occupies on the canvas. */
export function storedSize(node: Pick<FlowNode, 'type' | 'width' | 'height'>) {
  if (isContainer(node.type))
    return {
      width: node.width ?? CONTAINER_SIZE.width,
      height: node.height ?? CONTAINER_SIZE.height,
    };
  if (isDecorative(node.type))
    return {
      width: node.width ?? NOTE_SIZE.width,
      height: node.height ?? NOTE_SIZE.height,
    };
  return { width: CARD_SQUARE, height: CARD_SQUARE };
}
/** The same box, preferring what React Flow has measured. */
export function editorSize(node: EditorNode) {
  const stored = storedSize(node.data.node);
  return {
    width: node.measured?.width ?? node.width ?? stored.width,
    height: node.measured?.height ?? node.height ?? stored.height,
  };
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
  const container = isContainer(node.type);
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
    // A container is drawn behind the cards it holds; notes behind both.
    zIndex: container ? -2 : decorative ? -1 : 0,
    ...(decorative || container ? storedSize(node) : {}),
    // React Flow's own parent/child model: a child's position is relative to
    // its container and `extent` keeps it inside the container's bounds.
    ...(node.parentId
      ? { parentId: node.parentId, extent: 'parent' as const }
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
  const ids = new Set(nodes.map((editorNode) => editorNode.id));
  return {
    nodes: nodes.map((editorNode) => {
      const node: FlowNode = {
        ...editorNode.data.node,
        position: {
          x: Math.round(editorNode.position.x),
          y: Math.round(editorNode.position.y),
        },
      };
      if (isDecorative(node.type) || isContainer(node.type)) {
        if (editorNode.width) node.width = Math.round(editorNode.width);
        if (editorNode.height) node.height = Math.round(editorNode.height);
      }
      // React Flow's field is the live one: a drop into (or out of) a
      // container changes it, so it decides what is stored. A container that
      // is no longer on the canvas leaves no membership behind.
      if (editorNode.parentId && ids.has(editorNode.parentId))
        node.parentId = editorNode.parentId;
      else delete node.parentId;
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
      // Which loop a step sits in is structure, not layout: moving a card
      // into a For each changes what the engine runs.
      node.parentId ?? '',
    ]),
    edges: snapshot.edges,
  });
}

/**
 * Apply a patch to one card and, when the patch renames it, repair the chips
 * that referred to it by its old name. Both land in the same canvas edit, so
 * one undo takes the rename and the repaired references back together.
 */
export function applyNodePatch(
  nodes: EditorNode[],
  edges: EditorEdge[],
  id: string,
  patch: Partial<FlowNode>,
  workspace: WorkspaceState,
): EditorNode[] {
  const before = nodes.find((node) => node.id === id);
  if (!before) return nodes;
  const patched = nodes.map((node) =>
    node.id === id ? patchEditorNode(node, patch, workspace) : node,
  );
  if (!('label' in patch)) return patched;
  const oldLabel = before.data.node.label;
  const newLabel = patch.label;
  if ((oldLabel ?? '') === (newLabel ?? '')) return patched;
  const graph = toGraph(serializeCanvas(patched, edges));
  const repaired = renameToken(graph, id, oldLabel, newLabel);
  if (repaired === graph) return patched;
  // serializeCanvas carries each config object by reference, so only the
  // nodes renameToken actually rewrote come back with a new one.
  const rewritten = new Map(repaired.nodes.map((node) => [node.id, node]));
  return patched.map((node) => {
    const next = rewritten.get(node.id);
    return next && next.config !== node.data.node.config
      ? patchEditorNode(node, { config: next.config }, workspace)
      : node;
  });
}

/**
 * Copy nodes and the edges between them with fresh ids, shifted by `offset`.
 * A copied container takes its body with it: the children's `parentId` is
 * remapped to the copy and their positions, being container-relative, stay
 * as they are so the body lands laid out the same way.
 */
export function cloneSubgraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  offset: number,
): Snapshot {
  const ids = new Map(nodes.map((node) => [node.id, newNodeId()]));
  return {
    nodes: nodes.map((node) => {
      const parentId = node.parentId ? ids.get(node.parentId) : undefined;
      const clone: FlowNode = {
        ...node,
        id: ids.get(node.id)!,
        position: parentId
          ? { ...node.position }
          : { x: node.position.x + offset, y: node.position.y + offset },
        config: { ...node.config },
      };
      if (parentId) clone.parentId = parentId;
      else delete clone.parentId;
      return clone;
    }),
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

/**
 * A spot at or near `wanted` that does not overlap an existing card. Body
 * nodes are skipped: their positions are container-relative, so they say
 * nothing about what is free out on the canvas.
 */
export function freeSpot(
  nodes: (Pick<FlowNode, 'position'> & { parentId?: string })[],
  wanted: { x: number; y: number },
) {
  const outer = nodes.filter((node) => !node.parentId);
  const occupied = (x: number, y: number) =>
    outer.some(
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

/* ---------- containers ---------- */

/**
 * React Flow requires a parent node to come before its children in the node
 * array; every write goes through `setCanvas`, which keeps that invariant.
 */
export function orderByParent<T extends { id: string; parentId?: string }>(
  nodes: T[],
): T[] {
  if (!nodes.some((node) => node.parentId)) return nodes;
  const ids = new Set(nodes.map((node) => node.id));
  const bodies = new Map<string, T[]>();
  const outer: T[] = [];
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId))
      bodies.set(node.parentId, [...(bodies.get(node.parentId) ?? []), node]);
    else outer.push(node);
  }
  return outer.flatMap((node) => [node, ...(bodies.get(node.id) ?? [])]);
}
/** Absolute canvas position of an editor node, resolving container offset. */
export function absoluteOf(nodes: EditorNode[], node: EditorNode) {
  if (!node.parentId) return node.position;
  const parent = nodes.find((item) => item.id === node.parentId);
  return parent
    ? {
        x: parent.position.x + node.position.x,
        y: parent.position.y + node.position.y,
      }
    : node.position;
}
/** The container (if any) whose box holds an absolute canvas point. */
export function containerAt(
  nodes: EditorNode[],
  point: { x: number; y: number },
  exclude?: string,
) {
  return nodes.find((node) => {
    if (node.id === exclude) return false;
    if (!isContainer(node.data.node.type) || node.parentId) return false;
    const size = editorSize(node);
    return (
      point.x >= node.position.x &&
      point.x <= node.position.x + size.width &&
      point.y >= node.position.y &&
      point.y <= node.position.y + size.height
    );
  });
}
/** A relative position that keeps a child inside its container's body area. */
export function clampToBody(
  container: EditorNode,
  size: { width: number; height: number },
  position: { x: number; y: number },
) {
  const box = editorSize(container);
  const maxX = Math.max(CONTAINER_PAD, box.width - CONTAINER_PAD - size.width);
  const maxY = Math.max(
    CONTAINER_HEADER,
    box.height - CONTAINER_PAD - size.height,
  );
  return {
    x: Math.round(Math.min(Math.max(position.x, CONTAINER_PAD), maxX)),
    y: Math.round(Math.min(Math.max(position.y, CONTAINER_HEADER), maxY)),
  };
}
/** Set or clear a node's container, carrying the stored copy along with it. */
function setMembership(
  node: EditorNode,
  parentId: string | undefined,
  position: { x: number; y: number },
): EditorNode {
  const stored: FlowNode = { ...node.data.node, position };
  if (parentId) stored.parentId = parentId;
  else delete stored.parentId;
  return {
    ...node,
    position,
    parentId,
    extent: parentId ? 'parent' : undefined,
    data: { ...node.data, node: stored },
  };
}
/** `ids` plus every node that lives inside the containers among them. */
export function withBodies(
  nodes: { id: string; parentId?: string }[],
  ids: string[],
) {
  const all = new Set(ids);
  for (const node of nodes)
    if (node.parentId && all.has(node.parentId)) all.add(node.id);
  return [...all];
}
/**
 * The container's box, grown if needed so a body card at `position` fits.
 * Adding a step into a full body grows the loop, the way tidy does, instead
 * of stacking the new card on top of the last row.
 */
export function growToFit(
  container: EditorNode,
  position: { x: number; y: number },
  card: { width: number; height: number } = BODY_CARD,
) {
  const box = editorSize(container);
  return {
    width: Math.max(box.width, position.x + card.width + CONTAINER_PAD),
    height: Math.max(box.height, position.y + card.height + CONTAINER_PAD),
  };
}
/**
 * A free spot inside a container's body, in container-relative coordinates.
 * Columns wrap within the container's width; rows are allowed to run past
 * its height, because the caller grows the container (`growToFit`) rather
 * than clamping a new card onto the previous row.
 */
export function bodySpot(nodes: EditorNode[], containerId: string) {
  const container = nodes.find((node) => node.id === containerId);
  if (!container) return { x: CONTAINER_PAD, y: CONTAINER_HEADER };
  const body = nodes.filter((node) => node.parentId === containerId);
  const box = editorSize(container);
  let x = CONTAINER_PAD;
  let y = CONTAINER_HEADER + 10;
  for (let step = 0; step < 40; step += 1) {
    const clash = body.some(
      (node) =>
        Math.abs(node.position.x - x) < CARD_SQUARE + 24 &&
        Math.abs(node.position.y - y) < CARD_SQUARE + 24,
    );
    if (!clash) break;
    x += BODY_COLUMN_GAP;
    if (x > box.width - CONTAINER_PAD - CARD_SQUARE) {
      x = CONTAINER_PAD;
      y += BODY_ROW_GAP;
    }
  }
  return {
    x: Math.round(Math.max(x, CONTAINER_PAD)),
    y: Math.round(Math.max(y, CONTAINER_HEADER)),
  };
}

export interface Reparented {
  nodes: EditorNode[];
  /** Ids whose container membership changed. */
  changed: string[];
  /** Something a body cannot hold was dropped into one and left outside. */
  refused: boolean;
  /** Which rule refused it, so the notice can say which. */
  refusedKind?: 'container' | 'control';
}
/**
 * Recompute container membership for the nodes that just moved. A node whose
 * centre lands inside a container joins its body and its position becomes
 * container-relative; one whose centre leaves goes back to absolute canvas
 * coordinates. Containers never nest, so a container over a container keeps
 * its own membership and the caller says so.
 */
export function reparentNodes(
  nodes: EditorNode[],
  ids: string[],
  options: { detach?: boolean } = {},
): Reparented {
  const moved = new Set(ids);
  const changed: string[] = [];
  let refused = false;
  let refusedKind: Reparented['refusedKind'];
  const next = nodes.map((node) => {
    if (!moved.has(node.id)) return node;
    const absolute = absoluteOf(nodes, node);
    const size = editorSize(node);
    const centre = {
      x: absolute.x + size.width / 2,
      y: absolute.y + size.height / 2,
    };
    const host = options.detach
      ? undefined
      : containerAt(nodes, centre, node.id);
    if (host && !canBeContained(node.data.node.type)) {
      refused = true;
      refusedKind ??= isContainer(node.data.node.type)
        ? 'container'
        : 'control';
      return node;
    }
    if ((host?.id ?? undefined) === node.parentId) return node;
    changed.push(node.id);
    if (!host) return setMembership(node, undefined, absolute);
    return setMembership(
      node,
      host.id,
      clampToBody(host, size, {
        x: absolute.x - host.position.x,
        y: absolute.y - host.position.y,
      }),
    );
  });
  return {
    nodes: changed.length ? next : nodes,
    changed,
    refused,
    ...(refusedKind ? { refusedKind } : {}),
  };
}

/** Columns by topological depth over one set of nodes. */
function depthColumns(nodes: FlowNode[], edges: FlowEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
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
    nodes.map((node) => [node.id, parents.get(node.id)?.length ?? 0]),
  );
  const queue = nodes
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
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  return [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, column]) => ({
      level,
      column: [...column].sort((a, b) => a.position.y - b.position.y),
    }));
}

export interface TidyLayout {
  /** Absolute spots for outer nodes, container-relative ones for a body. */
  positions: Map<string, { x: number; y: number }>;
  /** Containers grown so their laid-out body fits. */
  sizes: Map<string, { width: number; height: number }>;
}
/**
 * Left-to-right columns by topological depth; rows keep the nodes' relative
 * vertical order. Notes are left where they are. A container's body is laid
 * out inside it first (growing the container to fit), and the container then
 * takes part in the outer layout as one box.
 */
export function tidyLayout(snapshot: Snapshot): TidyLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const container of snapshot.nodes) {
    if (!isContainer(container.type) || container.parentId) continue;
    const body = snapshot.nodes.filter(
      (node) => node.parentId === container.id && !isDecorative(node.type),
    );
    // Tidy only ever grows a container, so a size the author chose stands.
    const current = storedSize(container);
    let width = Math.max(CONTAINER_MIN.width, current.width);
    let height = Math.max(CONTAINER_MIN.height, current.height);
    for (const { level, column } of depthColumns(body, snapshot.edges))
      column.forEach((node, row) => {
        const x = CONTAINER_PAD + level * BODY_COLUMN_GAP;
        const y = CONTAINER_HEADER + 10 + row * BODY_ROW_GAP;
        positions.set(node.id, { x, y });
        width = Math.max(width, x + BODY_CARD.width + CONTAINER_PAD);
        // Room for the label block that hangs under a card's square.
        height = Math.max(height, y + BODY_CARD.height + CONTAINER_PAD);
      });
    sizes.set(container.id, { width, height });
  }
  const steps = snapshot.nodes.filter(
    (node) => !node.parentId && !isDecorative(node.type),
  );
  const minX = Math.min(...steps.map((node) => node.position.x), 80);
  const minY = Math.min(...steps.map((node) => node.position.y), 120);
  let x = minX;
  for (const { column } of depthColumns(steps, snapshot.edges)) {
    let y = minY;
    let widest = CARD_WIDTH;
    for (const node of column) {
      positions.set(node.id, { x: Math.round(x), y: Math.round(y) });
      const size = sizes.get(node.id) ?? storedSize(node);
      widest = Math.max(widest, size.width);
      y += Math.max(ROW_GAP, size.height + 80);
    }
    x += Math.max(COLUMN_GAP, widest + 80);
  }
  return { positions, sizes };
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

/* ---------- narrow screens ---------- */

/**
 * The breakpoint the editor's small-screen mode uses. It must stay in step
 * with the `@media (max-width: 900px)` block in flow-editor.css: below it the
 * right slot is a bottom sheet, the minimap goes, and node dragging is turned
 * off so a finger pans the canvas instead of moving a card.
 */
export const NARROW_MAX = 900;
const NARROW_QUERY = `(max-width: ${NARROW_MAX}px)`;
function readNarrow() {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function')
      return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    // Fall through to the width, which every environment reports.
  }
  return window.innerWidth <= NARROW_MAX;
}
/** True while the viewport is at or below NARROW_MAX, kept live on resize. */
export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    const update = () => setNarrow(readNarrow());
    window.addEventListener('resize', update);
    const query =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(NARROW_QUERY)
        : null;
    query?.addEventListener?.('change', update);
    update();
    return () => {
      window.removeEventListener('resize', update);
      query?.removeEventListener?.('change', update);
    };
  }, []);
  return narrow;
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
      // Every write lands here, so this is where the one invariant React
      // Flow has about containers is kept: a parent before its children.
      const ordered = orderByParent(nextNodes);
      nodesRef.current = ordered;
      edgesRef.current = nextEdges;
      setNodes(ordered);
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
          // A resized note or container carries its size on the React Flow
          // node rather than inside `data.node`, so the sizes are compared
          // too: without it, undoing a resize would leave the new size on a
          // card whose stored copy had not changed.
          const resized =
            !!previous &&
            ((previous.width ?? undefined) !== node.width ||
              (previous.height ?? undefined) !== node.height);
          if (
            previous &&
            !resized &&
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
            // A stale measurement would fight the size being restored;
            // React Flow measures the new one on the next frame.
            ...(resized ? {} : carryMeasured(previous)),
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
          // Catches a Run flow step pointing at this very flow as it is
          // drawn; a loop through another flow is caught on publish.
          flowId: flow.id,
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
    (requested: string[], edgeIds: string[] = []) => {
      // Deleting a container deletes the steps inside it: half a loop body
      // left behind would be a flow nobody meant to draw.
      const ids = withBodies(nodesRef.current, requested);
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
  /**
   * The named steps with the edges between them. A container brings its body
   * along; a body node copied on its own leaves the loop, so it comes out in
   * absolute coordinates with no container.
   */
  const subgraph = useCallback(
    (ids: string[]) => {
      const wanted = new Set(withBodies(nodesRef.current, ids));
      const picked = nodesRef.current
        .filter((n) => wanted.has(n.id))
        .map((n) =>
          n.parentId && !wanted.has(n.parentId)
            ? setMembership(n, undefined, absoluteOf(nodesRef.current, n))
            : n,
        );
      return serializeCanvas(
        picked,
        edgesRef.current.filter(
          (e) => wanted.has(e.source) && wanted.has(e.target),
        ),
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
      mutate((current, currentEdges) => {
        const added = clone.nodes.map((node) => ({
          ...toEditorNode(node, workspaceRef.current, []),
          selected: true,
        }));
        // A copy that lands over a For each joins its body, the same as a
        // step dragged there; the copy of a container keeps its own.
        const landed = added.filter((node) => !node.parentId).map((n) => n.id);
        return {
          nodes: reparentNodes([...deselect(current), ...added], landed).nodes,
          edges: [...currentEdges, ...clone.edges.map(toEditorEdge)],
        };
      });
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
      mutate((current) => {
        // A body node whose container is moving too already travels with
        // it: nudging both would move it twice.
        const moving = new Set(
          current.filter((n) => n.selected).map((n) => n.id),
        );
        const shifted: string[] = [];
        const nudged = current.map((n) => {
          if (!n.selected || (n.parentId && moving.has(n.parentId))) return n;
          shifted.push(n.id);
          const position = { x: n.position.x + dx, y: n.position.y + dy };
          // A child cannot be stored outside its own body: React Flow clamps
          // only what it draws, so an unclamped position and the drawn card
          // would drift apart and jump when the container is resized.
          const parent = n.parentId
            ? current.find((item) => item.id === n.parentId)
            : undefined;
          return {
            ...n,
            position: parent
              ? clampToBody(parent, editorSize(n), position)
              : position,
          };
        });
        // The keyboard decides membership the same way a drag does, so the
        // same final geometry means the same thing on both.
        return { nodes: reparentNodes(nudged, shifted).nodes };
      }, 'nudge'),
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
    const { positions, sizes } = tidyLayout(
      serializeCanvas(nodesRef.current, edgesRef.current),
    );
    mutate((current) => ({
      nodes: current.map((n) => {
        const position = positions.get(n.id);
        const size = sizes.get(n.id);
        if (!position && !size) return n;
        const node = { ...n.data.node, ...(position ? { position } : {}) };
        if (size) Object.assign(node, size);
        return {
          ...n,
          ...(position ? { position } : {}),
          ...(size ?? {}),
          data: { ...n.data, node },
        };
      }),
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
        const at = absoluteOf(nodesRef.current, node);
        void rf.setCenter(at.x + 120, at.y + 60, {
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
    copySelection,
    paste,
    duplicateNodes,
    nudge,
    collapseSelected,
    tidy,
    focusProblem,
  };
}
