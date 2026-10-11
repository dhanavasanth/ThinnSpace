/**
 * The Flows canvas editor: header, React Flow canvas with its floating '+'
 * and Run bar, the right slot (step picker or properties panel), problems
 * tray, versions drawer. The document (load, autosave, lint, history) lives
 * in useFlowDocument; this file owns the interactions.
 */
import '@xyflow/react/dist/style.css';
import './flow-editor.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
} from '@xyflow/react';
import {
  ListOrdered,
  Play,
  Plus,
  ShieldCheck,
  Square,
  WandSparkles,
  X,
} from 'lucide-react';
import { ApiError, api } from '../api';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  flowStatus,
  incomingCount,
  lintFlow,
  makeNode,
  newNodeId,
  nodeLabel,
  nodeOutputs,
  runOrder,
  type Flow,
  type FlowNode,
  type FlowProblem,
  type PortKind,
} from '../../shared/flows';
import { flowRoute, type FlowEditorProps } from './contract';
import { upstreamRefs } from './upstream';
import { FlowProperties } from './FlowProperties';
import {
  EditorActionsContext,
  FlowNodeCard,
  NODE_LABEL_MAX,
  PreviewContext,
  categoryColor,
  type EditorActions,
  type EditorNode,
  type PreviewStep,
} from './FlowNodeCard';
import { FlowEdge, type EditorEdge } from './FlowEdge';
import { NodePanel } from './NodePanel';
import {
  RunDialog,
  RunTray,
  RunsButton,
  manualStart,
  needsRunDialog,
  stepStatuses,
} from './FlowRuns';
import { useFlowRun } from './useFlowRun';
import {
  ConfirmDialog,
  FlowHeader,
  FlowLoadError,
  FlowLoading,
  FlowVersions,
  ProblemsTray,
  ShortcutsSheet,
} from './FlowVersions';
import {
  BODY_CARD,
  CARD_WIDTH,
  CONTAINER_SIZE,
  NOTE_SIZE,
  absoluteOf,
  canBeContained,
  applyNodePatch,
  bodySpot,
  clampToBody,
  connectionProblem,
  containerAt,
  editorSize,
  deselect,
  edgeFrom,
  freeSpot,
  growToFit,
  isContainer,
  isDecorative,
  motionMs,
  patchEditorNode,
  reparentNodes,
  roomFor,
  structuralKey,
  toEditorNode,
  toGraph,
  useCanvasEdits,
  useFlowDocument,
  useNarrowScreen,
  withBodies,
} from './flow-history';

const nodeTypes = { flow: FlowNodeCard };
const edgeTypes = { flow: FlowEdge };
const PANEL_WIDTH_KEY = 'thinnspace-flow-panel-width';
const PANEL_WIDTH = { min: 320, max: 480, initial: 360 };
const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.isContentEditable);
/** Popovers inside the properties panel that Escape should close first. */
const INNER_POPOVERS = '.fp-menu-list, .chip-popover, .flow-publish-popover';
/** Dialogs over the canvas (Edit Dot, Delete flow) take the keyboard. */
const MODAL_DIALOGS =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"]';

/** How the step picker was opened; decides where and how the step lands. */
interface PickerState {
  /** Opened from an output handle, a dropped edge or the card '+'. */
  from?: { nodeId: string; port: string; kind: PortKind };
  /** Opened with one step selected: wire from its first compatible output. */
  anchor?: string;
  /** Requested position (flow coordinates); otherwise right of the source
   *  or the canvas centre. */
  at?: { x: number; y: number };
}

function readPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (stored >= PANEL_WIDTH.min && stored <= PANEL_WIDTH.max) return stored;
  } catch {
    // Remembering the panel width is a convenience only.
  }
  return PANEL_WIDTH.initial;
}
/** Moves keyboard focus to a node card once React Flow has rendered it. */
function focusNode(id: string) {
  window.requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
      ?.focus({ preventScroll: true }),
  );
}
function downloadJson(name: string, body: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  const slug = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  link.href = url;
  link.download = `${slug || 'flow'}.flow.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

/**
 * The floating Run button at the bottom of the canvas (n8n's Test workflow).
 * While a run is active it becomes Stop.
 */
function RunBar({
  errors,
  running,
  busy,
  onRun,
  onStop,
  showAdd,
  onAdd,
}: {
  errors: number;
  running: boolean;
  busy: boolean;
  onRun: () => void;
  onStop: () => void;
  showAdd: boolean;
  onAdd: () => void;
}) {
  // Lint errors do not grey the button out: the click opens the Problems
  // tray (startRun re-lints and shows it), the outline says why.
  const hasProblems = !running && errors > 0;
  const blocker = busy ? 'One moment…' : undefined;
  return (
    <div className="flow-run-bar">
      {showAdd && (
        <button type="button" className="flow-run-secondary" onClick={onAdd}>
          <Plus size={14} /> Add a step
        </button>
      )}
      <span className="flow-disabled-wrap" title={blocker}>
        {running ? (
          <button
            type="button"
            className="flow-run-button stopping"
            disabled={!!blocker}
            aria-label="Stop run"
            onClick={onStop}
          >
            <Square size={13} fill="currentColor" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className={`flow-run-button${hasProblems ? ' has-problems' : ''}`}
            disabled={!!blocker}
            aria-label="Run flow"
            title={hasProblems ? 'Fix the problems first' : undefined}
            onClick={onRun}
          >
            <Play size={15} fill="currentColor" />
            Run flow
          </button>
        )}
      </span>
    </div>
  );
}

function FlowEditorInner({
  flowId,
  workspace,
  onBack,
  onRefresh,
  onEditDot,
  onDirty,
  onRun,
}: FlowEditorProps) {
  const doc = useFlowDocument({ flowId, workspace, onDirty, onRefresh });
  const {
    rf,
    flow,
    flowRef,
    nodes,
    edges,
    nodesRef,
    edgesRef,
    setCanvas,
    snapshot,
    graph,
    problems,
    mutate,
    commit,
    undo,
    redo,
    saveNow,
  } = doc;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The run tray shares the bottom slot with the problems tray.
  const [runOpen, setRunOpen] = useState(false);
  /** The manual Start whose run form is open, when it asks for input. */
  const [runDialog, setRunDialog] = useState<FlowNode | null>(null);
  const runState = useFlowRun(flowId);
  // The run-order overlay is pinned to the structure it was computed for:
  // any edit (not a plain move) switches it off again.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  // Below 900px the right slot is a bottom sheet, the minimap goes, and
  // cards stop being draggable so a finger pans the canvas (see the
  // matching media query in flow-editor.css).
  const narrow = useNarrowScreen();
  const noticeTimer = useRef(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  // Workspace arrives fresh on every shell poll; callbacks read it via a ref
  // so the card/edge action context does not churn every few seconds.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const hasSelection = selectedNodes.length > 0;
  const upstream = useMemo(
    () => (selectedNode ? upstreamRefs(graph, selectedNode.id) : []),
    [graph, selectedNode],
  );
  const errorCount = problems.filter((p) => p.level === 'error').length;
  const graphKey = useMemo(() => structuralKey(snapshot), [snapshot]);
  const previewing = previewKey !== null && previewKey === graphKey;
  useEffect(() => {
    if (previewKey !== null && previewKey !== graphKey) setPreviewKey(null);
  }, [graphKey, previewKey]);
  const preview = useMemo(() => {
    if (!previewing) return null;
    const order = runOrder(graph);
    const steps = new Map<string, PreviewStep>(
      order.map((entry) => [
        entry.nodeId,
        {
          step: entry.step,
          wave: entry.wave,
          waitsFor: incomingCount(graph, entry.nodeId),
        },
      ]),
    );
    const waves = order.reduce((max, entry) => Math.max(max, entry.wave), -1);
    return { steps, count: order.length, waves: waves + 1 };
  }, [graph, previewing]);
  const exitPreview = useCallback(() => setPreviewKey(null), []);
  /**
   * Below 900px the properties sheet covers the bottom slot, so a tray
   * opened under it would render nothing while its control reported itself
   * pressed. Opening a tray closes the sheet instead.
   */
  const sheetAside = useCallback(() => {
    if (!narrow) return;
    setPicker(null);
    setCanvas(
      deselect(nodesRef.current),
      edgesRef.current.map((edge) =>
        edge.selected ? { ...edge, selected: false } : edge,
      ),
    );
  }, [edgesRef, narrow, nodesRef, setCanvas]);
  const showProblems = useCallback(() => {
    sheetAside();
    setRunOpen(false);
    setProblemsOpen(true);
  }, [sheetAside]);
  const showRuns = useCallback(() => {
    sheetAside();
    setProblemsOpen(false);
    setRunOpen(true);
  }, [sheetAside]);
  // The badge counts reviews of this flow only; a review on another flow
  // cannot be decided from this canvas.
  const flowReviews = useMemo(
    () => runState.reviews.filter((review) => review.flowId === flowId),
    [flowId, runState.reviews],
  );
  /** The Runs toggle: with no run loaded, a pending review's run is shown. */
  const openRuns = () => {
    showRuns();
    const review = flowReviews[0];
    if (!runState.run && review) void runState.load(review.runId);
  };
  // Opened as `#/flows/:id?run=:runId` from the Reviews inbox or the Flow
  // runs activity list: that run comes up in the tray, so the row that was
  // clicked is the row the editor shows. Read once, on mount.
  const [deepLinkRun] = useState(() =>
    new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('run'),
  );
  const loadRun = runState.load;
  useEffect(() => {
    if (!deepLinkRun) return;
    setRunOpen(true);
    void loadRun(deepLinkRun);
  }, [deepLinkRun, loadRun]);
  // Step statuses from the loaded run are painted onto the cards while the
  // run is active and, once it has finished, until the graph is edited (or
  // the run is cleared from the tray).
  const [paintKey, setPaintKey] = useState<string | null>(null);
  const graphKeyRef = useRef(graphKey);
  graphKeyRef.current = graphKey;
  const loadedRunId = runState.run?.id ?? null;
  const runActive = runState.active;
  useEffect(() => {
    setPaintKey(loadedRunId ? graphKeyRef.current : null);
  }, [loadedRunId]);
  useEffect(() => {
    if (runActive) setPaintKey(graphKey);
  }, [graphKey, runActive]);
  const painting =
    !!runState.run &&
    (runActive || (paintKey !== null && paintKey === graphKey));
  const statusMap = useMemo(
    () =>
      painting && runState.run
        ? stepStatuses(runState.run.steps)
        : new Map<string, EditorNode['data']['status']>(),
    [painting, runState.run],
  );
  const paintedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const status = statusMap.get(node.id) ?? 'idle';
        return status === node.data.status
          ? node
          : { ...node, data: { ...node.data, status } };
      }),
    [nodes, statusMap],
  );
  const stepOrder = useMemo(
    () => runOrder(graph).map((entry) => entry.nodeId),
    [graph],
  );
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // Remembering the panel width is a convenience only.
    }
  }, [panelWidth]);
  // The right slot shows one thing at a time: selecting a step closes the
  // step picker (opening the picker deselects, see openPicker).
  useEffect(() => {
    if (hasSelection) setPicker(null);
  }, [hasSelection]);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  /** Drag the right slot's left edge to resize it (320-480px). */
  const startPanelResize = useCallback((event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidthRef.current;
    const move = (e: PointerEvent) =>
      setPanelWidth(
        Math.min(
          PANEL_WIDTH.max,
          Math.max(PANEL_WIDTH.min, startWidth + (startX - e.clientX)),
        ),
      );
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }, []);

  const notify = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }, []);
  const clearSelection = useCallback(
    () =>
      setCanvas(
        deselect(nodesRef.current),
        edgesRef.current.map((e) =>
          e.selected ? { ...e, selected: false } : e,
        ),
      ),
    [edgesRef, nodesRef, setCanvas],
  );
  /**
   * Opens the step picker in the right slot. With exactly one step selected
   * (and no explicit source or spot) the new step is wired from it.
   */
  const openPicker = useCallback(
    (next: PickerState = {}) => {
      const selected = nodesRef.current.filter((n) => n.selected);
      const anchor =
        !next.from &&
        !next.at &&
        selected.length === 1 &&
        !isDecorative(selected[0].data.node.type)
          ? selected[0].id
          : undefined;
      clearSelection();
      setPicker({ ...next, anchor: next.anchor ?? anchor });
    },
    [clearSelection, nodesRef],
  );
  const closePicker = useCallback(() => setPicker(null), []);

  /* ---------- connections ---------- */
  const isValidConnection = useCallback(
    (c: Connection | EditorEdge) =>
      !connectionProblem(nodesRef.current, edgesRef.current, c),
    [edgesRef, nodesRef],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      const problem =
        connectionProblem(nodesRef.current, edgesRef.current, c) ??
        roomFor(nodesRef.current.length, edgesRef.current.length, 0, 1);
      if (problem) return notify(problem);
      mutate((_nodes, current) => ({
        edges: [
          ...current,
          {
            id: newNodeId('e'),
            source: c.source,
            sourceHandle: c.sourceHandle ?? '',
            target: c.target,
            targetHandle: c.targetHandle ?? '',
            type: 'flow',
          },
        ],
      }));
    },
    [edgesRef, mutate, nodesRef, notify],
  );
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      const from = state.fromHandle;
      if (!from || from.type !== 'source' || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (state.toHandle && state.toNode) {
        if (state.isValid === false)
          notify(
            connectionProblem(nodesRef.current, edgesRef.current, {
              source: state.fromNode.id,
              sourceHandle: from.id ?? null,
              target: state.toNode.id,
              targetHandle: state.toHandle.id ?? null,
            }) ?? 'Those ports do not fit together.',
          );
        return;
      }
      const source = nodesRef.current.find((n) => n.id === state.fromNode?.id);
      const port =
        source && nodeOutputs(source.data.node).find((p) => p.id === from.id);
      if (!source || !port) return;
      const flowPoint = rf.screenToFlowPosition({
        x: point.clientX,
        y: point.clientY,
      });
      openPicker({
        at: { x: flowPoint.x, y: flowPoint.y - 24 },
        from: { nodeId: source.id, port: port.id, kind: port.kind },
      });
    },
    [edgesRef, nodesRef, notify, openPicker, rf],
  );

  /* ---------- adding nodes ---------- */
  const rightOf = useCallback(
    (nodeId: string) => {
      const source = nodesRef.current.find((n) => n.id === nodeId);
      // Absolute: a step inside a For each stores a container-relative spot.
      const at = source && absoluteOf(nodesRef.current, source);
      // Clear of the source's own box, not a fixed step's width: a For each
      // is 480 wide and resizable, so a fixed offset landed the next step
      // inside the loop it was meant to follow.
      const width = source
        ? Math.max(CARD_WIDTH, editorSize(source).width)
        : CARD_WIDTH;
      return freeSpot(
        nodesRef.current,
        at ? { x: at.x + width + 80, y: at.y } : { x: 80, y: 120 },
      );
    },
    [nodesRef],
  );
  /** The canvas centre in flow coordinates, offset so a card lands centred. */
  const centerSpot = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const center = rf.screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
    });
    return { x: center.x - 120, y: center.y - 40 };
  }, [rf]);
  const addNode = useCallback(
    (
      type: string,
      position: { x: number; y: number },
      options: {
        dotId?: string;
        from?: { nodeId: string; port: string };
        anchor?: string;
        /** Lands inside this container; `position` is then relative to it. */
        parentId?: string;
      } = {},
    ) => {
      const spec = NODE_SPECS[type];
      if (!spec) return;
      if (spec.comingSoon)
        return notify(`${spec.label} arrives in a later release.`);
      const node = makeNode(
        type,
        position,
        options.dotId ? { dot: options.dotId } : {},
      );
      if (isDecorative(type)) Object.assign(node, NOTE_SIZE);
      if (isContainer(type)) Object.assign(node, CONTAINER_SIZE);
      // Containers never nest and control flow stays outside a body, so
      // only an ordinary step joins one (see canBeContained).
      if (options.parentId && canBeContained(type)) {
        node.parentId = options.parentId;
      } else if (canBeContained(type)) {
        // No container was asked for, but the spot lands over one: the step
        // joins that body rather than floating above it. A step added from a
        // container's own non-item output is the exception — it is meant to
        // come *after* the loop, so it is never adopted by it.
        const after =
          options.from && options.from.port !== 'item'
            ? options.from.nodeId
            : undefined;
        const host = containerAt(
          nodesRef.current,
          {
            x: position.x + BODY_CARD.width / 2,
            y: position.y + BODY_CARD.height / 2,
          },
          after,
        );
        if (host) {
          node.parentId = host.id;
          node.position = clampToBody(host, BODY_CARD, {
            x: position.x - host.position.x,
            y: position.y - host.position.y,
          });
        }
      }
      let edge = options.from && edgeFrom(nodesRef.current, options.from, node);
      if (!edge && options.anchor) {
        // First output of the anchor step that the new step can take.
        const source = nodesRef.current.find((n) => n.id === options.anchor);
        for (const out of source ? nodeOutputs(source.data.node) : []) {
          edge = edgeFrom(
            nodesRef.current,
            { nodeId: source!.id, port: out.id },
            node,
          );
          if (edge) break;
        }
      }
      const room = roomFor(
        nodesRef.current.length,
        edgesRef.current.length,
        1,
        edge ? 1 : 0,
      );
      if (room) return notify(room);
      mutate((current, currentEdges) => ({
        nodes: [
          // A step added into a full loop body grows the loop rather than
          // landing on top of the row above it.
          ...deselect(current).map((n) =>
            n.id === node.parentId
              ? { ...n, ...growToFit(n, node.position) }
              : n,
          ),
          { ...toEditorNode(node, workspaceRef.current, []), selected: true },
        ],
        edges: edge ? [...currentEdges, edge] : currentEdges,
      }));
      setPicker(null);
      focusNode(node.id);
    },
    [edgesRef, mutate, nodesRef, notify],
  );
  /** The picker's choice: wired from the source, the anchor, or free-standing. */
  const pickNode = useCallback(
    (type: string, dotId?: string) => {
      const state = picker ?? {};
      const sourceId = state.from?.nodeId ?? state.anchor;
      const source = sourceId
        ? nodesRef.current.find((n) => n.id === sourceId)
        : undefined;
      // A step added while a For each is selected (or from its per-item
      // output) lands inside the loop, and one added from a step that is
      // already inside joins it there.
      const host =
        source && canBeContained(type)
          ? isContainer(source.data.node.type)
            ? !state.from || state.from.port === 'item'
              ? source.id
              : undefined
            : source.parentId
          : undefined;
      const wanted = host
        ? bodySpot(nodesRef.current, host)
        : state.at
          ? freeSpot(nodesRef.current, state.at)
          : sourceId
            ? rightOf(sourceId)
            : freeSpot(nodesRef.current, centerSpot());
      addNode(type, wanted, {
        dotId,
        from: state.from,
        anchor: state.anchor,
        parentId: host,
      });
    },
    [addNode, centerSpot, nodesRef, picker, rightOf],
  );

  /* ---------- removing, copying, moving ---------- */
  const {
    removeNodes,
    copySelection,
    paste,
    duplicateNodes,
    nudge,
    collapseSelected,
    tidy,
    focusProblem,
  } = useCanvasEdits(doc, workspace, notify);
  /**
   * The container a dragged card would join if it were dropped now. Adoption
   * is decided by the card's centre, so without this the outcome near a
   * container's edge is not readable from what is on screen.
   */
  const [dropHost, setDropHost] = useState<string | null>(null);
  /** Set while a container with a body waits for the delete to be confirmed. */
  const [removeAsk, setRemoveAsk] = useState<{
    ids: string[];
    edgeIds: string[];
    title: string;
  } | null>(null);
  /**
   * Deleting a container takes the steps inside it with it, so that one is
   * confirmed first; everything else goes straight away.
   */
  const requestRemove = useCallback(
    (ids: string[], edgeIds: string[] = []) => {
      const container = nodesRef.current.find(
        (n) =>
          ids.includes(n.id) &&
          isContainer(n.data.node.type) &&
          nodesRef.current.some((item) => item.parentId === n.id),
      );
      if (!container) return removeNodes(ids, edgeIds);
      // Count the bodies themselves, not what the selection happens to miss:
      // selecting a loop *and* one of its steps used to undercount, while
      // removeNodes takes the whole body either way.
      const containers = nodesRef.current.filter(
        (n) =>
          ids.includes(n.id) &&
          isContainer(n.data.node.type) &&
          nodesRef.current.some((item) => item.parentId === n.id),
      );
      const steps = containers.reduce(
        (total, item) =>
          total + withBodies(nodesRef.current, [item.id]).length - 1,
        0,
      );
      const inside = `the ${steps} ${steps === 1 ? 'step' : 'steps'} inside`;
      setRemoveAsk({
        ids,
        edgeIds,
        title:
          containers.length > 1
            ? `Delete ${containers.length} For each containers and ${inside} them?`
            : `Delete “${nodeLabel(container.data.node)}” and ${inside} it?`,
      });
    },
    [nodesRef, removeNodes],
  );
  const requestRemoveSelected = useCallback(
    () =>
      requestRemove(
        nodesRef.current.filter((n) => n.selected).map((n) => n.id),
        edgesRef.current.filter((e) => e.selected).map((e) => e.id),
      ),
    [edgesRef, nodesRef, requestRemove],
  );
  /**
   * A drag has landed. Membership is recomputed first — a step whose centre
   * is now inside a For each joins its body (its position becoming
   * container-relative), one whose centre left goes back to canvas
   * coordinates — and the move and the membership change are recorded as one
   * undo step. Deferred a task like `commit`, so React Flow's own position
   * change for this drag is already in.
   */
  const trackDrag = useCallback(
    (node: EditorNode) => {
      if (!canBeContained(node.data.node.type)) return setDropHost(null);
      const at = absoluteOf(nodesRef.current, node);
      const size = editorSize(node);
      const host = containerAt(
        nodesRef.current,
        { x: at.x + size.width / 2, y: at.y + size.height / 2 },
        node.id,
      );
      setDropHost(host?.id ?? null);
    },
    [nodesRef],
  );
  const finishDrag = useCallback(
    (ids: string[]) => {
      window.setTimeout(() => {
        const moved = reparentNodes(nodesRef.current, ids);
        if (moved.refused)
          notify(
            moved.refusedKind === 'control'
              ? 'Start and Finish stay outside a For each.'
              : 'A For each cannot go inside another For each.',
          );
        setDropHost(null);
        mutate(() => ({ nodes: moved.nodes }));
      }, 0);
    },
    [mutate, nodesRef, notify],
  );

  /* ---------- card and edge actions (context) ---------- */
  const actions = useMemo<EditorActions>(
    () => ({
      renamingId,
      setRenamingId,
      // A rename also repairs the {{chips}} downstream that named this
      // card, in the same edit, so one undo takes both back.
      rename: (id, label) =>
        mutate(
          (current) => ({
            nodes: applyNodePatch(
              current,
              edgesRef.current,
              id,
              { label: label.trim().slice(0, NODE_LABEL_MAX) || undefined },
              workspaceRef.current,
            ),
          }),
          `rename:${id}`,
        ),
      patchNode: (id, patch, commitNow = true) => {
        const apply = (current: EditorNode[]) =>
          applyNodePatch(
            current,
            edgesRef.current,
            id,
            patch,
            workspaceRef.current,
          );
        if (commitNow)
          mutate((current) => ({ nodes: apply(current) }), `patch:${id}`);
        else setCanvas(apply(nodesRef.current), edgesRef.current);
      },
      commit,
      toggleCollapsed: (id) =>
        mutate((current) => ({
          nodes: current.map((n) =>
            n.id === id
              ? patchEditorNode(
                  n,
                  { collapsed: !n.data.node.collapsed },
                  workspaceRef.current,
                )
              : n,
          ),
        })),
      duplicate: (id) => duplicateNodes([id]),
      remove: (id) => requestRemove([id]),
      removeEdge: (id) => removeNodes([], [id]),
      detach: (id) => {
        const moved = reparentNodes(nodesRef.current, [id], { detach: true });
        if (!moved.changed.length) return;
        mutate(() => ({ nodes: moved.nodes }));
        notify('Moved out of the loop.');
      },
      // The card's output '+': the picker opens in the right slot and the
      // step lands to the right of the source.
      addFrom: (id, port, kind) =>
        openPicker({ from: { nodeId: id, port, kind } }),
      dropHost,
    }),
    [
      commit,
      dropHost,
      duplicateNodes,
      edgesRef,
      mutate,
      nodesRef,
      notify,
      openPicker,
      removeNodes,
      renamingId,
      requestRemove,
      setCanvas,
    ],
  );

  /* ---------- keyboard map ---------- */
  // Captured on window so React Flow's own key handling never doubles up.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event) => {
    if (!flow) return;
    const root = editorRef.current;
    const target = event.target;
    // Shortcuts belong to the editor: nothing fires while focus is in the
    // sidebar, or while a dialog (Edit Dot, Delete flow) is open over it.
    if (
      target instanceof Node &&
      root &&
      !root.contains(target) &&
      target !== document.body
    )
      return;
    if (document.querySelector(MODAL_DIALOGS)) return;
    const mod = event.metaKey || event.ctrlKey;
    const k = event.key.toLowerCase();
    if (mod && k === 's') {
      event.preventDefault();
      void saveNow();
      return;
    }
    if (mod && k === 'k') {
      event.preventDefault();
      if (picker) closePicker();
      else openPicker();
      return;
    }
    if (event.key === 'Escape') {
      if (picker) closePicker();
      else if (shortcutsOpen) setShortcutsOpen(false);
      else if (versionsOpen) setVersionsOpen(false);
      else if (renamingId || isEditable(target)) return;
      else if (root?.querySelector(INNER_POPOVERS)) return;
      else if (problemsOpen) setProblemsOpen(false);
      else if (runOpen) setRunOpen(false);
      else if (selectedNodes.length) clearSelection();
      else if (previewing) exitPreview();
      return;
    }
    // The right slot (picker or properties panel) drives its own keys:
    // arrows walk the picker or resize the panel grip, F2 renames in place.
    const inSlot =
      target instanceof Node && !!slotRef.current?.contains(target);
    if (isEditable(target) || shortcutsOpen || inSlot) return;
    // Backspace on a focused panel control must not delete the step behind it.
    const active = document.activeElement;
    const inCanvas =
      !active ||
      active === document.body ||
      !!canvasRef.current?.contains(active);
    const selected = selectedNodes.length > 0;
    if (mod && k === 'z') {
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') redo();
    else if (mod && k === 'a')
      setCanvas(
        nodesRef.current.map((n) => ({ ...n, selected: true })),
        edgesRef.current,
      );
    else if (mod && k === 'c') copySelection();
    else if (mod && k === 'v') paste();
    else if (mod && k === 'd') duplicateNodes(selectedNodes.map((n) => n.id));
    else if (mod && event.key === '.' && selected) collapseSelected();
    else if (mod && k === 'g') tidy();
    else if (!mod && (event.key === 'Backspace' || event.key === 'Delete')) {
      if (!inCanvas) return;
      requestRemoveSelected();
    } else if (!mod && event.key.startsWith('Arrow') && selected && inCanvas) {
      const step = event.shiftKey ? 50 : 10;
      const dx = { ArrowLeft: -step, ArrowRight: step }[event.key] ?? 0;
      const dy = { ArrowUp: -step, ArrowDown: step }[event.key] ?? 0;
      nudge(dx, dy);
    } else if (!mod && event.key === '1')
      void rf.fitView({ padding: 0.2, maxZoom: 1, duration: motionMs() });
    else if (!mod && event.key === '0')
      void rf.zoomTo(1, { duration: motionMs() });
    else if (
      event.key === 'F2' &&
      inCanvas &&
      selectedNode &&
      !isDecorative(selectedNode.data.node.type)
    )
      setRenamingId(selectedNode.id);
    else if (!mod && event.key === '/') openPicker();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  /* ---------- flow-level commands ---------- */
  const validate = async () => {
    const saved = await saveNow();
    if (!saved && doc.hasUnsaved())
      return notify(
        'Your latest changes could not be saved, so validation was skipped.',
      );
    const current = flowRef.current;
    if (!current) return;
    try {
      const result = await api<{ problems: FlowProblem[] }>(
        `/flows/${current.id}/validate`,
        'POST',
      );
      doc.setProblems(result.problems);
      showProblems();
      if (!result.problems.length)
        notify('No problems found. This flow is ready.');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Validation failed.');
    }
  };
  /** The linter as of this keystroke, not the debounced copy in state. */
  const lintNow = () => {
    const found = lintFlow(graph, {
      dots: workspaceRef.current.dots,
      spaces: workspaceRef.current.spaces,
      // Enough for "a flow cannot run itself"; the whole-graph walk that
      // catches a loop through another flow needs every flow's graph, which
      // only the server has, so publish and run are where that is refused.
      flowId,
    });
    doc.setProblems(found);
    return found;
  };
  const togglePreview = () => {
    if (previewing) return exitPreview();
    if (lintNow().some((problem) => problem.level === 'error')) {
      showProblems();
      return;
    }
    setPreviewKey(graphKey);
  };
  /**
   * "Run flow": flush autosave, then either open the run form (when the
   * manual Start asks for input) or start straight away. While a run is
   * active the same button stops it.
   */
  const startRun = async () => {
    if (runState.active) return runState.cancel();
    if (lintNow().some((problem) => problem.level === 'error'))
      return showProblems();
    const saved = await saveNow();
    if (!saved && doc.hasUnsaved())
      return notify(
        'Your latest changes could not be saved, so the run was not started.',
      );
    const start = manualStart(graph);
    if (!start) return notify('Add a Start step first.');
    if (needsRunDialog(start)) setRunDialog(start);
    else await launchRun('', {});
  };
  const launchRun = async (input: string, fields: Record<string, unknown>) => {
    try {
      await runState.start(input, fields);
      setRunDialog(null);
      showRuns();
      onRun?.();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        // The server linted a problem this canvas missed; show its list.
        setRunDialog(null);
        try {
          const result = await api<{ problems: FlowProblem[] }>(
            `/flows/${flowId}/validate`,
            'POST',
          );
          doc.setProblems(result.problems);
        } catch {
          // The tray still opens with the problems known locally.
        }
        showProblems();
        notify(cause.message);
        return;
      }
      // Network and server errors stay visible inline in the run dialog or
      // the tray (runState.error); the notice covers a closed tray.
      if (!runDialog)
        notify(
          cause instanceof Error && cause.message
            ? cause.message
            : 'The run could not be started.',
        );
    }
  };
  /** Selects and centres a step's card from the run tray. */
  const focusRunStep = (nodeId: string) =>
    focusProblem({ level: 'warning', code: 'run', message: '', nodeId });
  /** Publishes the saved revision; the popover shows a rejection inline. */
  const publish = async (label: string) => {
    const saved = await saveNow();
    const current = saved ?? flowRef.current;
    if (!current || (!saved && doc.hasUnsaved()))
      throw new Error('Save the flow before publishing.');
    try {
      const published = await api<Flow>(
        `/flows/${current.id}/publish`,
        'POST',
        {
          revision: current.revision,
          label,
        },
      );
      doc.adoptMeta(published);
      onRefresh();
      notify(`Published as “${label}”. Triggers now run this version.`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        // The server linted a problem this canvas missed; show its list.
        try {
          const result = await api<{ problems: FlowProblem[] }>(
            `/flows/${current.id}/validate`,
            'POST',
          );
          doc.setProblems(result.problems);
        } catch {
          // The tray still opens with the problems known locally.
        }
        showProblems();
      }
      throw cause;
    }
  };
  const unpublish = async () => {
    const current = flowRef.current;
    if (!current) return;
    try {
      doc.adoptMeta(await api<Flow>(`/flows/${current.id}/unpublish`, 'POST'));
      onRefresh();
      notify('Unpublished. Triggers are off until you publish again.');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not unpublish.');
    }
  };
  const rename = (value: string) => {
    const trimmed = value.trim().slice(0, FLOW_LIMITS.name);
    if (!trimmed || !flowRef.current || trimmed === flowRef.current.name)
      return;
    // Shown immediately; the document reverts it if the save fails.
    doc.setName(trimmed);
    void saveNow({ name: trimmed });
  };
  /** Back flushes pending edits first so the shell never has to ask. */
  const back = async () => {
    await saveNow();
    onBack();
  };
  const duplicateFlow = async () => {
    await saveNow();
    try {
      const copy = await api<Flow>(`/flows/${flowId}/duplicate`, 'POST');
      onRefresh();
      notify(`Duplicated as “${copy.name}”.`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Could not duplicate.');
    }
  };
  /** Confirmed in the dialog: the flow, its versions and runs are gone. */
  const deleteFlow = async () => {
    await api(`/flows/${flowId}`, 'DELETE');
    setDeleteOpen(false);
    onDirty(false);
    onRefresh();
    onBack();
  };
  const restoreVersion = async (versionId: string) => {
    const saved = await saveNow();
    const revision = (saved ?? flowRef.current)?.revision;
    if (revision === undefined) throw new Error('The flow is not loaded.');
    doc.adopt(
      await api<Flow>(
        `/flows/${flowId}/versions/${versionId}/restore`,
        'POST',
        {
          revision,
        },
      ),
    );
    setProblemsOpen(false);
    onRefresh();
  };

  if (doc.loadError)
    return (
      <FlowLoadError
        message={doc.loadError}
        onRetry={() => void doc.load()}
        onBack={onBack}
      />
    );
  if (!flow) return <FlowLoading />;

  // What the picker says it connects from: the output it was opened from,
  // or the first output of the step that was selected (the anchor), which
  // is where addNode wires the new step.
  const pickerSourceId = picker?.from?.nodeId ?? picker?.anchor;
  const pickerSource =
    pickerSourceId && nodesRef.current.find((n) => n.id === pickerSourceId);
  const pickerPort = pickerSource
    ? picker?.from
      ? nodeOutputs(pickerSource.data.node).find(
          (p) => p.id === picker.from?.port,
        )
      : nodeOutputs(pickerSource.data.node)[0]
    : undefined;
  const pickerFrom =
    pickerSource && pickerPort
      ? {
          label: nodeLabel(pickerSource.data.node),
          port: pickerPort.label,
          kind: pickerPort.kind,
        }
      : undefined;
  const slotOpen = !!picker || !!selectedNode;

  return (
    <div className="flow-editor" ref={editorRef}>
      <FlowHeader
        name={doc.name}
        onRename={rename}
        saveState={doc.saveState}
        onRetry={() => void saveNow()}
        dirty={doc.dirty}
        status={flowStatus(flow)}
        revision={flow.revision}
        problems={problems}
        problemsOpen={problemsOpen}
        onToggleProblems={() =>
          problemsOpen ? setProblemsOpen(false) : showProblems()
        }
        canUndo={doc.canUndo}
        canRedo={doc.canRedo}
        onUndo={undo}
        onRedo={redo}
        onBack={() => void back()}
        onValidate={() => void validate()}
        previewing={previewing}
        onPreview={togglePreview}
        onPublish={publish}
        onUnpublish={() => void unpublish()}
        onShortcuts={() => setShortcutsOpen(true)}
        onDuplicate={() => void duplicateFlow()}
        onVersions={() => setVersionsOpen(true)}
        onExport={() =>
          downloadJson(doc.name, {
            name: doc.name,
            description: flow.description,
            graph: toGraph(snapshot, rf.getViewport()),
          })
        }
        onDelete={() => setDeleteOpen(true)}
        workspace={workspace}
        // Importing from inside the editor lands on the new flow; the shell
        // reloads its flow list so the sidebar does not lag behind.
        onImported={(created) => {
          onRefresh();
          window.location.hash = flowRoute(created.id);
        }}
      />
      {doc.saveState.status === 'conflict' && (
        <div className="flow-banner" role="alert">
          This flow changed elsewhere. Reload to pick up the latest version;
          unsaved edits here will be lost.
          <button type="button" onClick={() => void doc.load()}>
            Reload
          </button>
        </div>
      )}
      <div className={`flow-body${slotOpen ? ' with-slot' : ''}`}>
        <div className="flow-center">
          {preview && (
            <div className="flow-preview-banner" role="status">
              <strong>
                Preview: {preview.count}{' '}
                {preview.count === 1 ? 'step' : 'steps'} in {preview.waves}{' '}
                {preview.waves === 1 ? 'wave' : 'waves'}.
              </strong>
              <span>This is how the engine will run it.</span>
              <button type="button" onClick={exitPreview}>
                <X size={13} />
                Exit preview
              </button>
            </div>
          )}
          <div
            className={`flow-canvas${preview ? ' previewing' : ''}`}
            ref={canvasRef}
          >
            <EditorActionsContext.Provider value={actions}>
              <PreviewContext.Provider value={preview?.steps ?? null}>
                <ReactFlow<EditorNode, EditorEdge>
                  nodes={paintedNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={(changes: NodeChange<EditorNode>[]) =>
                    setCanvas(
                      applyNodeChanges(changes, nodesRef.current),
                      edgesRef.current,
                    )
                  }
                  onEdgesChange={(changes: EdgeChange<EditorEdge>[]) =>
                    setCanvas(
                      nodesRef.current,
                      applyEdgeChanges(changes, edgesRef.current),
                    )
                  }
                  nodesDraggable={!narrow}
                  onConnect={onConnect}
                  onConnectEnd={onConnectEnd}
                  isValidConnection={isValidConnection}
                  onNodeDrag={(_event, node) => trackDrag(node)}
                  onNodeDragStop={(_event, node, dragged) =>
                    finishDrag(
                      (dragged?.length ? dragged : [node]).map((n) => n.id),
                    )
                  }
                  onSelectionDragStop={(_event, dragged) =>
                    finishDrag(dragged.map((n) => n.id))
                  }
                  onPaneClick={closePicker}
                  onPaneContextMenu={(event) => {
                    event.preventDefault();
                    const point = rf.screenToFlowPosition({
                      x: event.clientX,
                      y: event.clientY,
                    });
                    openPicker({ at: { x: point.x - 120, y: point.y - 24 } });
                  }}
                  deleteKeyCode={null}
                  selectionMode={SelectionMode.Partial}
                  panOnScroll
                  multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
                  elevateNodesOnSelect={false}
                  minZoom={0.2}
                  maxZoom={2}
                  connectionLineStyle={{ stroke: '#ff6a1f', strokeWidth: 2 }}
                  proOptions={{ hideAttribution: true }}
                  aria-label="Flow canvas"
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={20}
                    size={1.3}
                  />
                  {!narrow && (
                    <MiniMap
                      position="bottom-right"
                      pannable
                      zoomable
                      style={{ width: 160, height: 104 }}
                      nodeStrokeWidth={0}
                      nodeColor={(node) =>
                        categoryColor((node as EditorNode).data.node.type)
                      }
                    />
                  )}
                  <Controls
                    position="bottom-left"
                    fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                    // The lock toggles dragging, which the width already
                    // decides on a narrow screen.
                    showInteractive={!narrow}
                  >
                    <ControlButton
                      onClick={tidy}
                      title="Tidy up (⌘G)"
                      aria-label="Tidy up"
                    >
                      <WandSparkles size={13} />
                    </ControlButton>
                    {/* The header drops its secondary actions below 900px;
                        these two keep working from the canvas. */}
                    {narrow && (
                      <ControlButton
                        onClick={togglePreview}
                        title={
                          previewing
                            ? 'Exit the run-order preview'
                            : 'Preview run order'
                        }
                        aria-label={
                          previewing ? 'Exit preview' : 'Preview run order'
                        }
                        aria-pressed={previewing}
                      >
                        <ListOrdered size={13} />
                      </ControlButton>
                    )}
                    {narrow && (
                      <ControlButton
                        onClick={() => void validate()}
                        title="Validate"
                        aria-label="Validate"
                      >
                        <ShieldCheck size={13} />
                      </ControlButton>
                    )}
                  </Controls>
                  <Panel position="top-right">
                    <RunsButton
                      open={runOpen}
                      active={runState.active}
                      reviews={flowReviews.length}
                      onClick={() => (runOpen ? setRunOpen(false) : openRuns())}
                    />
                    <button
                      type="button"
                      className={`flow-add-fab${picker ? ' open' : ''}`}
                      aria-label={picker ? 'Close step picker' : 'Add a step'}
                      aria-expanded={!!picker}
                      title={picker ? 'Close (Esc)' : 'Add a step (/ or ⌘K)'}
                      onClick={() => (picker ? closePicker() : openPicker())}
                    >
                      <Plus size={24} strokeWidth={2.25} />
                    </button>
                  </Panel>
                  <Panel position="bottom-center">
                    <RunBar
                      errors={errorCount}
                      running={runState.active}
                      busy={runState.busy}
                      onRun={() => void startRun()}
                      onStop={() => void runState.cancel()}
                      showAdd={nodes.length <= 1 && !picker}
                      onAdd={() => openPicker()}
                    />
                  </Panel>
                  {notice && (
                    <Panel position="top-center">
                      <div className="flow-notice" role="status">
                        {notice}
                      </div>
                    </Panel>
                  )}
                </ReactFlow>
              </PreviewContext.Provider>
            </EditorActionsContext.Provider>
          </div>
          {/* One panel at a time below 900px: the bottom sheet and a tray
              together would leave no canvas, so the tray is hidden while the
              sheet is open and comes back when it closes. It stays mounted,
              so a half-typed approval note survives the detour (the wrapper
              is `display: contents` until `hidden`, see flow-editor.css). */}
          <div className="flow-tray-slot" hidden={narrow && slotOpen}>
            {runOpen ? (
              <RunTray
                run={runState.run}
                runs={runState.runs}
                runsLoaded={runState.runsLoaded}
                busy={runState.busy}
                error={runState.error}
                order={stepOrder}
                onClose={() => setRunOpen(false)}
                onStop={() => void runState.cancel()}
                onSelectRun={(runId) => void runState.load(runId)}
                onDecide={runState.decide}
                onDismiss={runState.dismiss}
                onFocusNode={focusRunStep}
              />
            ) : problemsOpen ? (
              <ProblemsTray
                problems={problems}
                nodes={snapshot.nodes}
                onSelect={focusProblem}
                onClose={() => setProblemsOpen(false)}
              />
            ) : null}
          </div>
        </div>
        {slotOpen && (
          <div
            className="flow-properties-slot"
            style={{ width: panelWidth }}
            ref={slotRef}
          >
            <div
              className="flow-panel-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              aria-valuemin={PANEL_WIDTH.min}
              aria-valuemax={PANEL_WIDTH.max}
              aria-valuenow={panelWidth}
              tabIndex={0}
              onPointerDown={startPanelResize}
              onKeyDown={(event) => {
                const delta = { ArrowLeft: 16, ArrowRight: -16 }[event.key];
                if (!delta) return;
                event.preventDefault();
                setPanelWidth((width) =>
                  Math.min(
                    PANEL_WIDTH.max,
                    Math.max(PANEL_WIDTH.min, width + delta),
                  ),
                );
              }}
            />
            {picker ? (
              <NodePanel
                workspace={workspace}
                from={pickerFrom}
                onPick={pickNode}
                onClose={closePicker}
                onReturnFocus={() => {
                  if (pickerSourceId) focusNode(pickerSourceId);
                }}
              />
            ) : selectedNode ? (
              <FlowProperties
                flow={flow}
                node={selectedNode.data.node}
                graph={graph}
                workspace={workspace}
                problems={selectedNode.data.problems}
                upstream={upstream}
                onChange={(
                  nodeId: string,
                  patch: Partial<
                    Pick<FlowNode, 'label' | 'config' | 'typeVersion'>
                  >,
                ) => actions.patchNode(nodeId, patch)}
                onDuplicate={(nodeId: string) => duplicateNodes([nodeId])}
                onDelete={(nodeId: string) => requestRemove([nodeId])}
                onClose={clearSelection}
                // "Next step" '+': the picker replaces the properties panel
                // in the right slot, filtered to what this output can feed.
                onAddNext={(nodeId: string, port: string) => {
                  const source = nodesRef.current.find((n) => n.id === nodeId);
                  const out =
                    source &&
                    nodeOutputs(source.data.node).find((p) => p.id === port);
                  if (out)
                    openPicker({ from: { nodeId, port, kind: out.kind } });
                }}
                onEditDot={onEditDot}
              />
            ) : null}
          </div>
        )}
      </div>
      <FlowVersions
        flowId={flowId}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        onRestore={restoreVersion}
      />
      <ShortcutsSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      {runDialog && (
        <RunDialog
          start={runDialog}
          busy={runState.busy}
          error={runState.error}
          onSubmit={(input, fields) => void launchRun(input, fields)}
          onCancel={() => setRunDialog(null)}
        />
      )}
      {removeAsk && (
        <ConfirmDialog
          title={removeAsk.title}
          body="The steps in the loop body are removed with it. Undo (⌘Z) brings them back."
          confirmLabel="Delete"
          onConfirm={() => {
            removeNodes(removeAsk.ids, removeAsk.edgeIds);
            setRemoveAsk(null);
          }}
          onCancel={() => setRemoveAsk(null)}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={`Delete “${doc.name}”?`}
          body="Its versions and runs are removed. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={deleteFlow}
          onCancel={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}
