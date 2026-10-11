/**
 * The card drawn for every node on the Flows canvas, plus the actions context
 * the editor provides so cards (and edges) can rename, duplicate, delete, and
 * add-from-handle without prop drilling.
 *
 * Cards are icon-centric like n8n: a 96px rounded square holding the category
 * icon (or the Dot's avatar), the name and a one-line summary under it, an
 * input rectangle on the left edge and port-coloured output circles on the
 * right. Styles live in flow-cards.css.
 */
import './flow-cards.css';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useStore,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Check,
  Clock,
  Copy,
  FilePlus2,
  FileText,
  Flag,
  GitFork,
  Globe,
  LoaderCircle,
  LogOut,
  Merge,
  Monitor,
  Play,
  Plug,
  Plus,
  Repeat,
  Send,
  Sparkles,
  Split,
  StickyNote,
  Trash,
  User,
  UserCheck,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  NODE_SPECS,
  PORT_COLORS,
  configWithDefaults,
  nodeCategory,
  optionUnavailable,
  nodeInputs,
  nodeLabel,
  nodeOutputs,
  type FlowNode,
  type PortKind,
  type PortSpec,
} from '../../shared/flows';
import type { Dot } from '../../shared/types';
import { Mascot } from '../Mascot';
import type { FlowNodeData } from './contract';
import { describeSchedule } from './format';
import { CONTAINER_MIN, isContainer } from './flow-history';

export type EditorNode = Node<FlowNodeData, 'flow'>;
/** Server caps for what a card stores; mirrored here so saves never 400. */
export const NODE_LABEL_MAX = 80;
export const NOTE_MAX_SIZE = 2000;

/** What a card can ask the editor to do. */
export interface EditorActions {
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  rename: (id: string, label: string) => void;
  /** `commit` false keeps typing out of the undo stack until blur. */
  patchNode: (id: string, patch: Partial<FlowNode>, commit?: boolean) => void;
  commit: () => void;
  /** Kept for the editor's keyboard map; compact cards no longer collapse. */
  toggleCollapsed: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  removeEdge: (id: string) => void;
  addFrom: (
    id: string,
    port: string,
    kind: PortKind,
    screen: { x: number; y: number },
  ) => void;
  /** Take a step out of the loop it sits in, keeping its place on the canvas. */
  detach?: (id: string) => void;
  /**
   * The container a card being dragged would join if it were dropped now.
   * Adoption is decided by the card's centre, so near a container's edge the
   * outcome is not readable from the screen without this.
   */
  dropHost?: string | null;
}
export const EditorActionsContext = createContext<EditorActions | null>(null);

/** One executable node's place in the run-order preview. */
export interface PreviewStep {
  step: number;
  wave: number;
  /** Live incoming edges; more than one means the step waits for them all. */
  waitsFor: number;
}
/** Set by the editor while the run-order preview is on; null otherwise. */
export const PreviewContext = createContext<Map<string, PreviewStep> | null>(
  null,
);
/** Parallel groups cycle through this many tints (see flow-cards.css). */
export const WAVE_TINTS = 6;

const ICONS: Record<string, LucideIcon> = {
  Play,
  Flag,
  Sparkles,
  Split,
  FileText,
  FilePlus2,
  Globe,
  Plug,
  Send,
  Merge,
  GitFork,
  UserCheck,
  StickyNote,
  Users,
  Monitor,
  Repeat,
  Workflow,
  Clock,
};
export function nodeIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Workflow;
}
export function categoryColor(type: string) {
  return nodeCategory(type)?.color ?? '#94a3b8';
}
/**
 * A container's colour. Now that every node filed under Advanced ships, the
 * category carries a real colour and a container reads like its own kind on
 * the card, in the palette and on the minimap alike — no special case.
 */
export function containerColor(type: string) {
  return categoryColor(type);
}
/** First sentence of a Dot's instructions, kept short. */
export function dotRole(dot: Dot | undefined) {
  const first = (dot?.instructions ?? '')
    .trim()
    .split(/(?<=[.!?])\s+|\n/)[0]
    ?.trim();
  if (!first) return '';
  return first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first;
}
/** The stored title of a picked page or tool, falling back to a neutral label. */
function pickedName(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}
function optionLabel(type: string, key: string, value: unknown) {
  const field = NODE_SPECS[type]?.config.find((f) => f.key === key);
  return (
    field?.options?.find((o) => o.value === String(value))?.label ??
    String(value ?? '')
  );
}
function firstLine(value: unknown, fallback: string) {
  const text = String(value ?? '')
    .trim()
    .split('\n')[0];
  return text || fallback;
}

/** One-line summary and chips derived from a node's configuration. */
export function describeNode(
  node: FlowNode,
  dot?: Dot,
  spaceName?: string,
): { summary: string; chips: string[] } {
  const c = configWithDefaults(node.type, node.config);
  const chips: string[] = [];
  const space = spaceName ?? 'Choose a Space';
  let summary: string;
  switch (node.type) {
    case 'start': {
      const trigger = String(c.trigger);
      if (trigger === 'schedule')
        summary = describeSchedule(c, 'schedule').replace(/\.$/, '');
      else if (trigger === 'slack')
        summary = `A Slack mention${c.slackChannel ? ` in ${c.slackChannel}` : ''}${c.slackKeyword ? ` containing “${c.slackKeyword}”` : ''}`;
      else if (trigger === 'webhook')
        summary = `A webhook call${c.webhookAuth === 'none' ? ' (no token)' : ''}`;
      else if (trigger === 'page')
        summary = `A page is ${c.pageEvent === 'updated' ? 'created or updated' : 'created'} in ${spaceName ?? 'a Space'}`;
      else
        summary = `Run manually${c.inputLabel ? ` · asks for ${c.inputLabel}` : ''}`;
      chips.push(optionLabel('start', 'trigger', trigger));
      if (c.active === false) chips.push('Paused');
      break;
    }
    case 'finish':
      summary = c.label ? String(c.label) : 'The result of the run';
      chips.push(`Returns ${optionLabel('finish', 'format', c.format)}`);
      break;
    case 'dot-task':
      summary = firstLine(c.task, 'Describe the task for this step');
      if (c.outputFormat === 'json') chips.push('JSON');
      if (c.perItem) chips.push('Per item');
      if (c.reviewBeforeSave) chips.push('Asks before saving');
      if (c.thread === 'continue') chips.push('Shared thread');
      break;
    case 'dot-decide':
      summary = firstLine(c.question, 'Ask the Dot a question');
      break;
    case 'read-page':
      summary = `${space} / ${
        c.mode === 'all'
          ? 'All pages'
          : c.mode === 'newest'
            ? `Newest ${Number(c.limit) || 5} pages`
            : c.page
              ? pickedName(c.pageName, 'Chosen page')
              : 'Choose a page'
      }`;
      break;
    case 'save-page':
      summary = `${space} / ${String(
        c.title ||
          (c.page ? pickedName(c.pageName, 'Chosen page') : 'New page'),
      )}`;
      chips.push(optionLabel('save-page', 'mode', c.mode));
      if (c.review !== false) chips.push('Review first');
      if (c.perItem) chips.push('Per item');
      break;
    case 'web-research':
      summary = firstLine(c.query, 'What should be researched?');
      chips.push(c.depth === 'thorough' ? 'Thorough' : 'Quick');
      if (c.maxSources) chips.push(`Up to ${c.maxSources} sources`);
      break;
    case 'mcp-tool': {
      const tool = String(c.tool || '');
      summary = tool
        ? pickedName(c.toolTitle, tool.split(':').pop() || tool)
        : 'Choose a tool';
      if (tool && typeof c.toolConnection === 'string' && c.toolConnection)
        chips.push(c.toolConnection);
      if (dot) chips.push(`Via ${dot.name}`);
      if (c.approval === 'always') chips.push('Asks first');
      if (c.approval === 'never') chips.push('No approval');
      break;
    }
    case 'send-message':
      summary = firstLine(c.message, 'What should be sent?');
      // Replying in the thread that started the run works; posting into an
      // arbitrary channel does not, so say so rather than promise it.
      chips.push(
        optionUnavailable('send-message', 'destination', c.destination)
          ? 'Coming soon'
          : optionLabel('send-message', 'destination', c.destination),
      );
      break;
    case 'branch':
      summary = `${String(c.field || 'value')} ${optionLabel('branch', 'operator', c.operator)}${c.operator === 'empty' ? '' : ` ${String(c.value ?? '')}`}`;
      break;
    case 'for-each': {
      summary = 'Runs the steps inside once for every item of the list';
      const max = Number(c.maxItems);
      if (Number.isFinite(max) && max > 0) chips.push(`Max ${max} items`);
      const at = Number(c.concurrency);
      if (Number.isFinite(at) && at > 1) chips.push(`${at} at a time`);
      else if (c.concurrency) chips.push('One at a time');
      break;
    }
    case 'human-review':
      summary = firstLine(c.message, 'What should the reviewer look at?');
      chips.push(optionLabel('human-review', 'actions', c.actions));
      if (c.notify !== 'app') chips.push('Coming soon');
      if (c.timeoutHours) chips.push(`Times out after ${c.timeoutHours}h`);
      break;
    default:
      summary = NODE_SPECS[node.type]?.description ?? '';
  }
  if (NODE_SPECS[node.type]?.comingSoon) chips.push('Coming soon');
  return { summary, chips };
}
/** Renders {{tokens}} in a summary as inline chips. */
export function renderTokens(text: string): ReactNode[] {
  return text.split(/(\{\{[^}]+\}\})/g).map((part, index) =>
    part.startsWith('{{') ? (
      <span className="fnode-token" key={index}>
        {part.slice(2, -2).trim()}
      </span>
    ) : (
      part
    ),
  );
}

/** Keeps the hover toolbar alive while the pointer travels to it. */
function useHoverIntent() {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number>(0);
  const enter = () => {
    window.clearTimeout(timer.current);
    setHovered(true);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(false), 160);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { hovered, enter, leave };
}

/** A flow keeps at least one Start; only the last one is protected. */
const countStarts = (nodes: Node[]) =>
  nodes.filter((n) => (n.data as FlowNodeData).node.type === 'start').length;

/** Chips shown under the subtitle; the rest live in the properties panel. */
const CHIP_MAX = 3;
/** Static handle styles, one per port kind, so renders allocate nothing. */
const PORT_STYLE: Record<PortKind, CSSProperties> = Object.fromEntries(
  Object.entries(PORT_COLORS).map(([kind, color]) => [
    kind,
    { background: color },
  ]),
) as Record<PortKind, CSSProperties>;
const STATUS_BADGE: Partial<
  Record<FlowNodeData['status'], { Icon: LucideIcon; label: string }>
> = {
  running: { Icon: LoaderCircle, label: 'Running' },
  waiting: { Icon: User, label: 'Waiting for a person' },
  completed: { Icon: Check, label: 'Completed' },
  failed: { Icon: X, label: 'Failed' },
};

function CardToolbar({
  id,
  visible,
  isStart,
  member,
  enter,
  leave,
}: {
  id: string;
  visible: boolean;
  isStart: boolean;
  /** Inside a For each: the toolbar offers a way back out of the body. */
  member?: boolean;
  enter: () => void;
  leave: () => void;
}) {
  const actions = useContext(EditorActionsContext);
  const lastStart = useStore((state) =>
    isStart ? countStarts(state.nodes) <= 1 : false,
  );
  return (
    <NodeToolbar
      isVisible={visible}
      position={Position.Top}
      align="end"
      offset={8}
      className="fnode-toolbar"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {member && (
        <button
          type="button"
          aria-label="Move out of the loop"
          title="Move out of the loop"
          onClick={() => actions?.detach?.(id)}
        >
          <LogOut size={13} />
        </button>
      )}
      <button
        type="button"
        aria-label="Duplicate"
        title="Duplicate"
        onClick={() => actions?.duplicate(id)}
      >
        <Copy size={13} />
      </button>
      <button
        type="button"
        aria-label="Delete"
        title={lastStart ? 'Every flow begins with a Start' : 'Delete'}
        disabled={lastStart}
        onClick={() => actions?.remove(id)}
      >
        <Trash size={13} />
      </button>
    </NodeToolbar>
  );
}

function NoteCard({ id, data, selected }: NodeProps<EditorNode>) {
  const actions = useContext(EditorActionsContext);
  const previewing = useContext(PreviewContext) !== null;
  const { hovered, enter, leave } = useHoverIntent();
  const text = String(data.node.config.text ?? '');
  const tone = String(data.node.config.color ?? 'amber');
  return (
    <div
      className={`fnote tone-${tone}${selected ? ' selected' : ''}${previewing ? ' previewing' : ''}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <NodeResizer
        minWidth={160}
        minHeight={90}
        maxWidth={NOTE_MAX_SIZE}
        maxHeight={NOTE_MAX_SIZE}
        isVisible={selected}
        lineClassName="fnote-resize-line"
        handleClassName="fnote-resize-handle"
        onResizeEnd={() => actions?.commit()}
      />
      <CardToolbar
        id={id}
        visible={selected || hovered}
        isStart={false}
        enter={enter}
        leave={leave}
      />
      <div className="fnote-grip" aria-hidden="true">
        <StickyNote size={12} />
      </div>
      <textarea
        className="nodrag nowheel"
        aria-label="Note text"
        placeholder="Explain what this part of the flow does."
        value={text}
        onChange={(event) =>
          actions?.patchNode(
            id,
            { config: { ...data.node.config, text: event.target.value } },
            false,
          )
        }
        onBlur={() => actions?.commit()}
      />
    </div>
  );
}

function InputPort({ port, labelled }: { port: PortSpec; labelled: boolean }) {
  return (
    <div className="fnode-in">
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        className="fnode-handle in"
        aria-label={`${port.label} input (${port.kind})`}
        title={`${port.label} · ${port.kind}${port.multiple ? ' · accepts several' : ''}`}
      />
      {labelled && (
        <span className="fnode-in-tail">
          <span className="fnode-port-label">{port.label}</span>
        </span>
      )}
    </div>
  );
}

function OutputPort({
  id,
  port,
  labelled,
}: {
  id: string;
  port: PortSpec;
  labelled: boolean;
}) {
  const actions = useContext(EditorActionsContext);
  return (
    <div className="fnode-out">
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        className="fnode-handle out"
        style={PORT_STYLE[port.kind]}
        aria-label={`${port.label} output (${port.kind})`}
        title={`${port.label} · ${port.kind}`}
      />
      <span className="fnode-out-tail">
        {labelled && <span className="fnode-port-label">{port.label}</span>}
        <button
          type="button"
          className="fnode-out-add nodrag"
          aria-label={`Add a step after ${port.label}`}
          title="Add a step"
          onClick={(event) => {
            // Kept from React Flow's node wrapper: its click would select the
            // card, and a selection closes the picker this is opening.
            event.stopPropagation();
            actions?.addFrom(id, port.id, port.kind, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <Plus size={10} />
        </button>
      </span>
    </div>
  );
}

/**
 * A For each container: the dashed body the steps of one iteration live in,
 * drawn behind them (toEditorNode gives it a lower z-index). Its list input
 * and results output sit on the outer edges beside the header, and the
 * per-item output sits inside the body at the left, the way n8n and Langflow
 * draw a loop. The children are ordinary cards React Flow renders on top.
 */
function ContainerCard({ id, data, selected }: NodeProps<EditorNode>) {
  const actions = useContext(EditorActionsContext);
  const preview = useContext(PreviewContext);
  const previewStep = preview?.get(id);
  const { hovered, enter, leave } = useHoverIntent();
  const { node, problems, status } = data;
  const spec = NODE_SPECS[node.type];
  const Icon = nodeIcon(spec?.icon);
  const color = containerColor(node.type);
  const renaming = actions?.renamingId === id;
  const title = nodeLabel(node);
  const { summary, chips } = describeNode(node);
  const errors = problems.filter((p) => p.level === 'error').length;
  const badge = STATUS_BADGE[status];
  const inside = useStore(
    (state) =>
      state.nodes.filter((item) => (item as EditorNode).parentId === id).length,
  );
  const inputs = nodeInputs(node);
  const outputs = nodeOutputs(node);
  // The per-item output is declared `item` by the catalog; everything else
  // leaves the loop and belongs on the right edge.
  const itemPort = outputs.find((port) => port.id === 'item');
  const outerPorts = outputs.filter((port) => port.id !== 'item');
  const style = useMemo<CSSProperties>(
    () => ({ ['--fnode-color' as string]: color }),
    [color],
  );
  const finishRename = (value: string) => {
    actions?.rename(id, value);
    actions?.setRenamingId(null);
  };
  return (
    <div
      className={`fcontainer${selected ? ' selected' : ''}${
        spec?.comingSoon ? ' is-soon' : ''
      }${actions?.dropHost === id ? ' drop-target' : ''}${
        previewStep ? ` previewing wave-${previewStep.wave % WAVE_TINTS}` : ''
      }`}
      style={style}
      data-status={status}
      data-step={previewStep?.step}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {/* Dragging a top or left handle moves the container's origin: React
          Flow corrects its children's relative positions in the same batch
          of changes, so the steps inside hold their place on the canvas and
          the container cannot be shrunk smaller than the body it holds. The
          whole resize is recorded as one undo step when it ends. */}
      <NodeResizer
        minWidth={CONTAINER_MIN.width}
        minHeight={CONTAINER_MIN.height}
        isVisible={selected}
        lineClassName="fcontainer-resize-line"
        handleClassName="fcontainer-resize-handle"
        onResizeEnd={() => actions?.commit()}
      />
      <CardToolbar
        id={id}
        visible={selected || hovered}
        isStart={false}
        enter={enter}
        leave={leave}
      />
      <div className="fcontainer-head">
        <span className="fcontainer-glyph" aria-hidden="true">
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="fcontainer-titles">
          {renaming ? (
            <input
              className="fnode-rename nodrag"
              aria-label="Node name"
              autoFocus
              maxLength={NODE_LABEL_MAX}
              defaultValue={node.label ?? ''}
              placeholder={spec?.label ?? node.type}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  finishRename(event.currentTarget.value);
                if (event.key === 'Escape') actions?.setRenamingId(null);
              }}
              onBlur={(event) => finishRename(event.currentTarget.value)}
            />
          ) : (
            <strong
              className="fcontainer-label"
              title="Double-click to rename"
              onDoubleClick={() => actions?.setRenamingId(id)}
            >
              {title}
            </strong>
          )}
          <span className="fcontainer-sub" title={summary}>
            {renderTokens(summary)}
          </span>
        </span>
        <span className="fcontainer-meta">
          {chips.slice(0, CHIP_MAX).map((chip) => (
            <span className="fnode-chip" key={chip} title={chip}>
              {chip}
            </span>
          ))}
          {problems.length > 0 && (
            <span
              className={`fnode-problem ${errors ? 'error' : 'warning'}`}
              role="img"
              aria-label={`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`}
              title={problems.map((p) => p.message).join('\n')}
            />
          )}
          {badge && (
            <span
              className={`fnode-status ${status}`}
              role="img"
              aria-label={badge.label}
              title={badge.label}
            >
              <badge.Icon size={12} strokeWidth={2.5} />
            </span>
          )}
        </span>
      </div>
      <div className="fcontainer-body">
        {inside === 0 && (
          <span className="fcontainer-empty">
            Drag the steps that run for each item in here
          </span>
        )}
      </div>
      {inputs.length > 0 && (
        <div className="fcontainer-ports in">
          {inputs.map((port) => (
            <InputPort key={port.id} port={port} labelled />
          ))}
        </div>
      )}
      {outerPorts.length > 0 && (
        <div className="fcontainer-ports out">
          {outerPorts.map((port) => (
            <OutputPort key={port.id} id={id} port={port} labelled />
          ))}
        </div>
      )}
      {itemPort && (
        <span className="fcontainer-item">
          {/* Declared as a right-side handle although it sits at the body's
              left edge, so the line to the first step inside leaves towards
              it instead of looping back around the container. */}
          <Handle
            type="source"
            position={Position.Right}
            id={itemPort.id}
            className="fnode-handle out"
            style={{
              ...PORT_STYLE[itemPort.kind],
              position: 'relative',
              top: 'auto',
              right: 'auto',
              transform: 'none',
            }}
            aria-label={`${itemPort.label} output (${itemPort.kind})`}
            title={`${itemPort.label} · ${itemPort.kind}`}
          />
          <span className="fnode-port-label">{itemPort.label}</span>
          <button
            type="button"
            className="fnode-out-add nodrag"
            aria-label={`Add a step inside ${title}`}
            title="Add a step inside the loop"
            onClick={(event) => {
              // React Flow's wrapper would select the container, and a
              // selection closes the picker this is opening.
              event.stopPropagation();
              actions?.addFrom(id, itemPort.id, itemPort.kind, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <Plus size={10} />
          </button>
        </span>
      )}
    </div>
  );
}

function StepCard({ id, data, selected, parentId }: NodeProps<EditorNode>) {
  const actions = useContext(EditorActionsContext);
  const preview = useContext(PreviewContext);
  const previewStep = preview?.get(id);
  const updateInternals = useUpdateNodeInternals();
  const { hovered, enter, leave } = useHoverIntent();
  const { node, problems, dot, spaceName, status } = data;
  const spec = NODE_SPECS[node.type];
  const color = categoryColor(node.type);
  const Icon = nodeIcon(spec?.icon);
  const inputs = nodeInputs(node);
  const outputs = nodeOutputs(node);
  const renaming = actions?.renamingId === id;
  const isStart = node.type === 'start';
  const showsAvatar =
    !!dot && (node.type === 'dot-task' || node.type === 'dot-decide');
  const title = nodeLabel(node);
  const described = describeNode(node, dot, spaceName);
  const summary = showsAvatar
    ? `${dot!.name} · ${described.summary}`
    : described.summary;
  const chips =
    described.chips.length > CHIP_MAX
      ? described.chips.slice(0, CHIP_MAX)
      : described.chips;
  const errors = problems.filter((p) => p.level === 'error').length;
  const badge = STATUS_BADGE[status];
  const note =
    typeof node.config.cardNote === 'string' ? node.config.cardNote.trim() : '';
  const ports = Math.max(inputs.length, outputs.length, 1);
  const cardStyle = useMemo<CSSProperties>(
    () => ({
      ['--fnode-color' as string]: color,
      ['--fnode-ports' as string]: ports,
    }),
    [color, ports],
  );
  const portsKey = `${inputs.map((p) => p.id).join()}|${outputs.map((p) => p.id).join()}`;
  useEffect(() => {
    updateInternals(id);
  }, [id, portsKey, updateInternals]);

  const finishRename = (value: string) => {
    actions?.rename(id, value);
    actions?.setRenamingId(null);
  };

  return (
    <div
      className={`fnode${selected ? ' selected' : ''}${isStart ? ' is-start' : ''}${
        showsAvatar ? ' has-avatar' : ''
      }${spec?.comingSoon ? ' is-soon' : ''}${
        previewStep ? ` previewing wave-${previewStep.wave % WAVE_TINTS}` : ''
      }`}
      style={cardStyle}
      data-status={status}
      data-step={previewStep?.step}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <CardToolbar
        id={id}
        visible={selected || hovered}
        isStart={isStart}
        member={!!parentId}
        enter={enter}
        leave={leave}
      />
      <div className="fnode-square">
        {inputs.length > 0 && (
          <div className="fnode-ins">
            {inputs.map((port) => (
              <InputPort
                key={port.id}
                port={port}
                labelled={inputs.length > 1}
              />
            ))}
          </div>
        )}
        <span className="fnode-glyph" aria-hidden="true">
          {showsAvatar ? (
            <Mascot
              avatar={dot!.avatar}
              identity={dot!.id}
              name={dot!.name}
              small
              decorative
            />
          ) : (
            <Icon size={36} strokeWidth={1.75} />
          )}
        </span>
        {showsAvatar && (
          <span className="fnode-cat" aria-hidden="true">
            <Icon size={11} />
          </span>
        )}
        {problems.length > 0 && (
          <span
            className={`fnode-problem ${errors ? 'error' : 'warning'}`}
            role="img"
            aria-label={`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`}
            title={problems.map((p) => p.message).join('\n')}
          />
        )}
        {badge && (
          <span
            className={`fnode-status ${status}`}
            role="img"
            aria-label={badge.label}
            title={badge.label}
          >
            <badge.Icon size={12} strokeWidth={2.5} />
          </span>
        )}
        {previewStep && (
          <span
            className="fnode-step"
            role="img"
            aria-label={`Step ${previewStep.step}, wave ${previewStep.wave + 1}`}
            title={`Step ${previewStep.step} · runs in wave ${previewStep.wave + 1}`}
          >
            {previewStep.step}
          </span>
        )}
        {previewStep && previewStep.waitsFor > 1 && (
          <span
            className="fnode-waits"
            title="Runs once every incoming step has finished"
          >
            waits for {previewStep.waitsFor}
          </span>
        )}
        {outputs.length > 0 && (
          <div className="fnode-outs">
            {outputs.map((port) => (
              <OutputPort
                key={port.id}
                id={id}
                port={port}
                labelled={outputs.length > 1}
              />
            ))}
          </div>
        )}
      </div>
      <div className="fnode-text">
        {renaming ? (
          <input
            className="fnode-rename nodrag"
            aria-label="Node name"
            autoFocus
            maxLength={NODE_LABEL_MAX}
            defaultValue={node.label ?? ''}
            placeholder={spec?.label ?? node.type}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter')
                finishRename(event.currentTarget.value);
              if (event.key === 'Escape') actions?.setRenamingId(null);
            }}
            onBlur={(event) => finishRename(event.currentTarget.value)}
          />
        ) : (
          <strong
            className="fnode-label"
            title="Double-click to rename"
            onDoubleClick={() => actions?.setRenamingId(id)}
          >
            {title}
          </strong>
        )}
        <span className="fnode-sub" title={summary}>
          {renderTokens(summary)}
        </span>
        {chips.length > 0 && (
          <div className="fnode-chips">
            {chips.map((chip) => (
              <span className="fnode-chip" key={chip} title={chip}>
                {chip}
              </span>
            ))}
          </div>
        )}
        {note && (
          <span className="fnode-note" title={note}>
            {note}
          </span>
        )}
      </div>
    </div>
  );
}

export const FlowNodeCard = memo(function FlowNodeCard(
  props: NodeProps<EditorNode>,
) {
  const { type } = props.data.node;
  if (NODE_SPECS[type]?.decorative) return <NoteCard {...props} />;
  if (isContainer(type)) return <ContainerCard {...props} />;
  return <StepCard {...props} />;
});
