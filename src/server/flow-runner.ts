/**
 * FlowRunner: executes a run's graph snapshot in-process.
 *
 * Readiness follows the universal rule from docs/FLOWS.md section 9: each
 * output port yields {kind, value}; an edge is settled once its source
 * completed (value present for that port), was skipped, or did not take that
 * port; a node runs when every incoming edge is settled (Start when = all) or
 * when the first value arrives (first). A node whose incoming edges are all
 * inactive is skipped, and skipping propagates, which is how exclusive arms
 * (Branch, Dot decides, Human review, Save page declined) rejoin downstream
 * without a Join node.
 *
 * The pure helpers (edgeState, readiness, renderTokens, nextScheduleAt) carry
 * the semantics; RunExecution holds one run's in-memory state and persists
 * every change through FlowRunStore so a waiting run can be resumed later,
 * even after a restart.
 */
import { randomUUID } from 'node:crypto';
import type { Platform } from './platform.js';
import type { RunRecord, TriggerRow } from './flow-run-store.js';
import {
  executorFor,
  toText,
  type ChildRun,
  type Decision,
  type PortValue,
  type StepContext,
  type StepOutcome,
  type ThreadMode,
} from './flow-executors.js';
import {
  FOR_EACH_MAX_CONCURRENCY,
  MAX_FLOW_DEPTH,
  NODE_SPECS,
  bodyNodes,
  listValues,
  nodeFields,
  nodeInputs,
  nodeLabel,
  nodeOutputs,
  tokenSlug,
  upstreamRefs,
  type Flow,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '../shared/flows.js';
import {
  RUN_LIMITS,
  runIsActive,
  type FlowApproval,
  type FlowRun,
  type RunResult,
  type RunTrigger,
  type StepOutput,
} from '../shared/flow-runs.js';

export const CANCELLED_MESSAGE = 'The run was cancelled.';
export const STOPPED_MESSAGE =
  'The server stopped while this run was in progress.';
/** How often the scheduler looks for due schedule triggers. */
export const SCHEDULER_INTERVAL_MS = 30_000;
/** Concurrent items for a per-item step. */
const ITEM_CONCURRENCY = 5;
/**
 * How often Run flow checks whether its child has parked. Only that case
 * needs polling: finishing and aborting are both observed directly.
 */
const CHILD_POLL_MS = 250;

// Pure helpers ------------------------------------------------------------

export type NodeState =
  'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
/** What the engine knows about one node of a run. */
export interface NodeRun {
  state: NodeState;
  /** Present once the step completed, or failed with "continue". */
  output: StepOutput | null;
}
export type EdgeState = 'pending' | 'value' | 'inactive';
/** Whether an edge carries a value, will never carry one, or is still open. */
export function edgeState(
  edge: Pick<FlowEdge, 'sourceHandle'>,
  source: NodeRun | undefined,
): EdgeState {
  if (!source || source.state === 'skipped') return 'inactive';
  if (source.state === 'completed' || source.state === 'failed')
    return source.output && edge.sourceHandle in source.output
      ? 'value'
      : 'inactive';
  return 'pending';
}
export type Readiness = 'ready' | 'wait' | 'skip';
/** The readiness of a non-Start node given the state of its sources. */
export function readiness(
  graph: Pick<FlowGraph, 'edges'>,
  nodeId: string,
  states: Map<string, NodeRun>,
  startWhen: 'all' | 'first',
): Readiness {
  const incoming = graph.edges.filter((edge) => edge.target === nodeId);
  if (!incoming.length) return 'skip';
  const settled = incoming.map((edge) =>
    edgeState(edge, states.get(edge.source)),
  );
  const values = settled.filter((state) => state === 'value').length;
  const pending = settled.filter((state) => state === 'pending').length;
  if (startWhen === 'first')
    return values ? 'ready' : pending ? 'wait' : 'skip';
  if (pending) return 'wait';
  return values ? 'ready' : 'skip';
}

/** Where a {{slug.port}} chip reads from, built with upstreamRefs. */
export interface TokenRef {
  nodeId: string;
  nodeType: string;
  port: string;
}
export interface TokenScope {
  trigger: RunTrigger;
  refs: Map<string, TokenRef>;
  outputOf: (nodeId: string) => StepOutput | null | undefined;
}
export const TOKEN_PATTERN =
  /\{\{\s*([\w-]+)\.([\w:-]+)((?:\.[\w-]+)*)\s*\}\}/g;
export function tokenScope(
  graph: FlowGraph,
  nodeId: string,
  trigger: RunTrigger,
  outputOf: TokenScope['outputOf'],
): TokenScope {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const refs = new Map<string, TokenRef>();
  for (const ref of upstreamRefs(graph, nodeId)) {
    const key = ref.token.replace(/[{}\s]/g, '');
    const nodeType = byId.get(ref.nodeId)?.type ?? '';
    refs.set(key, { nodeId: ref.nodeId, nodeType, port: ref.port });
    // A Start also exposes the run-form fields: {{start.<field>}}.
    if (nodeType === 'start')
      for (const field of Object.keys(trigger.fields ?? {}))
        refs.set(`${key.split('.')[0]}.${field}`, {
          nodeId: ref.nodeId,
          nodeType,
          port: field,
        });
  }
  return { trigger, refs, outputOf };
}
function index(value: unknown, key: string): unknown {
  let current = value;
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(current)) return current[Number(key)];
  if (current && typeof current === 'object')
    return (current as Record<string, unknown>)[key];
  return undefined;
}
/**
 * Substitutes chips: {{slug.port}}, {{start.input}}, {{start.<field>}} and
 * {{slug.port.key}}. A chip whose source did not run resolves to '' and is
 * reported through `onMissing` so the run log can say so.
 */
export function renderTokens(
  text: string,
  scope: TokenScope,
  onMissing?: (token: string) => void,
): string {
  return text.replace(
    TOKEN_PATTERN,
    (token, slug: string, port: string, path: string) => {
      const ref = scope.refs.get(`${slug}.${port}`);
      let value: unknown;
      if (ref && ref.nodeType !== 'start') {
        const entry = scope.outputOf(ref.nodeId)?.[ref.port];
        if (!entry) {
          onMissing?.(token);
          return '';
        }
        value = entry.value;
      } else if (ref || slug === 'start') {
        value =
          port === 'input' || port === 'started'
            ? scope.trigger.input
            : scope.trigger.fields?.[port];
        if (value === undefined) {
          onMissing?.(token);
          return '';
        }
      } else {
        onMissing?.(token);
        return '';
      }
      for (const key of path.split('.').filter(Boolean))
        value = index(value, key);
      return toText(value);
    },
  );
}

/** When a schedule Start fires next: an interval in seconds, or weekdays at HH:MM. */
export function nextScheduleAt(
  config: Record<string, unknown>,
  now: number,
): number {
  const seconds = Number(config.schedule) || 86400;
  if (config.scheduleDays !== 'weekdays') return now + seconds * 1000;
  const [hours, minutes] = String(config.scheduleAt || '09:00')
    .split(':')
    .map(Number);
  const next = new Date(now);
  next.setHours(hours || 0, minutes || 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6)
    next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** A node's configuration with catalog and shared-settings defaults filled in. */
export function mergedConfig(node: FlowNode): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of nodeFields(node.type))
    if (field.default !== undefined) merged[field.key] = field.default;
  for (const [key, value] of Object.entries(node.config))
    if (value !== undefined && value !== null && value !== '')
      merged[key] = value;
  return merged;
}
function executable(graph: FlowGraph) {
  return graph.nodes.filter((node) => !NODE_SPECS[node.type]?.decorative);
}
/** Steps whose outputs are exclusive arms, and the arm a failure falls to. */
const FALLBACK_ARM: Record<string, string> = {
  branch: 'no',
  'dot-decide': 'otherwise',
  'human-review': 'declined',
  'save-page': 'declined',
};
/**
 * What a step emits when it fails but its node continues on error: every
 * port empty for ordinary steps, only the fallback arm (No, Otherwise,
 * Declined) for steps whose outputs are exclusive, so one failure never
 * fires every branch at once. A Dot decides without Otherwise emits nothing
 * and the steps after it are skipped.
 */
export function fallbackOutput(node: FlowNode): StepOutput {
  const ports = nodeOutputs(node);
  const arm = FALLBACK_ARM[node.type];
  const chosen = arm ? ports.filter((port) => port.id === arm) : ports;
  const output: StepOutput = {};
  for (const port of chosen)
    output[port.id] = {
      kind: port.kind,
      value: port.kind === 'json' ? null : '',
    };
  return output;
}
function fallbackText(node: FlowNode, output: StepOutput) {
  if (!(node.type in FALLBACK_ARM)) return 'continuing with an empty result.';
  const arm = Object.keys(output)[0];
  const label = nodeOutputs(node).find((port) => port.id === arm)?.label;
  return label
    ? `continuing down the ${label} arm with an empty value.`
    : 'continuing, but no arm was taken, so the steps after it are skipped.';
}
/** The list a For each works through, or an error the owner can act on. */
export function containerItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: fall through to the error below.
    }
  }
  throw new Error('For each needs a list on its List input.');
}
/** The steps of a container's body, in stable order, decoration aside. */
function bodySteps(graph: FlowGraph, containerId: string) {
  return bodyNodes(graph, containerId).filter(
    (node) => !NODE_SPECS[node.type]?.decorative,
  );
}
/**
 * What one pass through a body produced: the value of its last steps, the
 * ones nothing else inside reads. A single ending step contributes its value
 * directly; several contribute an object keyed by their chip name, so the
 * Results array stays readable either way.
 */
export function iterationResult(
  graph: FlowGraph,
  body: FlowNode[],
  states: Map<string, NodeRun>,
): unknown {
  const inside = new Set(body.map((node) => node.id));
  const endings = body.filter(
    (node) =>
      !graph.edges.some(
        (edge) => edge.source === node.id && inside.has(edge.target),
      ),
  );
  const valueOf = (node: FlowNode) => {
    const output = states.get(node.id)?.output;
    if (!output) return null;
    const port =
      nodeOutputs(node).find((candidate) => candidate.id in output) ??
      Object.keys(output).map((id) => ({ id }))[0];
    return port ? (output[port.id]?.value ?? null) : null;
  };
  if (endings.length === 1) return valueOf(endings[0]);
  return Object.fromEntries(
    endings.map((node) => [tokenSlug(node), valueOf(node)]),
  );
}
/** One attempt counter per node, and per item of a per-item step. */
function attemptKey(nodeId: string, item?: { index: number }) {
  return item ? `${nodeId}:${item.index}` : nodeId;
}
function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function triggerText(trigger: RunTrigger) {
  return {
    manual: 'by hand',
    schedule: 'on schedule',
    webhook: 'by a webhook',
    slack: 'from Slack',
    page: 'by a page change',
  }[trigger.source];
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
/**
 * A step inside a For each tried to park. The body is run to completion once
 * per item, so there is no worker to hand back and nothing to resume: this is
 * the body's shape being wrong rather than one item failing, which is why it
 * is fatal for the container whatever `onItemError` and `onError` say. The
 * linter refuses the shape while the flow is drawn (`body-not-supported`).
 */
class BodyCannotPause extends Error {
  constructor(label: string) {
    super(`${label} cannot pause inside a For each.`);
  }
}
/** Why a run stopped early; also the abort reason handed to executors. */
class RunStop extends Error {
  constructor(
    readonly outcome: 'failed' | 'cancelled' | 'interrupted',
    text: string,
  ) {
    super(text);
  }
}

// One run -----------------------------------------------------------------

interface RunSettings {
  timeoutMinutes: number;
  maxDotTurns: number;
}

class RunExecution {
  readonly id: string;
  readonly graph: FlowGraph;
  readonly states = new Map<string, NodeRun>();
  private readonly running = new Set<string>();
  /**
   * Executor calls driven by a container's or a per-item fan-out's own
   * workers. They are not in `running` (they are not outer steps), so `pump`
   * counts them here; without this a loop with concurrency 5 would run five
   * executors while pump still believed one slot was taken.
   */
  private inner = 0;
  private readonly controller = new AbortController();
  private readonly threads = new Map<string, string>();
  /** The attempt in progress (or last recorded) per node and item. */
  private readonly attempts = new Map<
    string,
    { attempt: number; startedAt: number }
  >();
  private readonly settings: RunSettings;
  private result: RunResult | null;
  private stop: RunStop | null = null;
  private finished = false;
  /** Set when the flow was deleted under the run: nothing is written again. */
  private discarded = false;
  private timer?: ReturnType<typeof setTimeout>;
  private armedAt: number | null = null;
  private usedMs = 0;
  private readonly done: Promise<void>;
  private settle!: () => void;

  constructor(
    private readonly runner: FlowRunner,
    readonly record: RunRecord,
  ) {
    this.id = record.id;
    this.graph = record.graph;
    this.result = record.result;
    const graphSettings =
      (record.graph as { settings?: Record<string, unknown> }).settings ?? {};
    this.settings = {
      timeoutMinutes:
        Number(graphSettings.timeoutMinutes) || RUN_LIMITS.timeoutMinutes,
      maxDotTurns: Number(graphSettings.maxDotTurns) || RUN_LIMITS.maxDotTurns,
    };
    this.done = new Promise((resolve) => (this.settle = resolve));
    // Rehydrate from the step rows so a waiting run resumes after a restart.
    for (const node of executable(this.graph))
      this.states.set(node.id, { state: 'pending', output: null });
    for (const step of this.runner.store.steps(this.id)) {
      if (step.iterationKey !== '') continue;
      const current = this.states.get(step.nodeId);
      if (!current) continue;
      const known = this.attempts.get(step.nodeId);
      if (known && known.attempt > step.attempt) continue;
      this.attempts.set(step.nodeId, {
        attempt: step.attempt,
        startedAt: step.startedAt ?? Date.now(),
      });
      const state: NodeState =
        step.status === 'running' ? 'pending' : step.status;
      this.states.set(step.nodeId, { state, output: step.output });
    }
  }
  /** True while a step is executing (as opposed to waiting on a person). */
  get busy() {
    return this.running.size > 0;
  }
  /** Whether a decision on this node can be applied right now. */
  canResume(nodeId: string) {
    return this.states.get(nodeId)?.state === 'waiting';
  }
  /** The attempt a step row belongs to; the first attempt when none began. */
  private attemptOf(
    node: FlowNode,
    startedAt: number,
    item?: { index: number },
  ) {
    return (
      this.attempts.get(attemptKey(node.id, item)) ?? { attempt: 1, startedAt }
    );
  }
  /** Resolves once the run reached a final status. */
  settled() {
    return this.done;
  }
  private get store() {
    return this.runner.store;
  }
  private node(id: string) {
    return this.graph.nodes.find((node) => node.id === id);
  }
  private event(
    nodeId: string | null,
    kind: 'run' | 'step' | 'log' | 'approval' | 'message',
    text: string,
  ) {
    if (this.discarded) return;
    this.store.event(this.id, nodeId, kind, text);
  }

  /** Marks the run running and fires the Start node that triggered it. */
  begin() {
    this.store.setStatus(this.id, 'running');
    this.event(null, 'run', `Run started ${triggerText(this.record.trigger)}.`);
    const trigger = this.record.trigger;
    const starts = this.graph.nodes.filter((node) => node.type === 'start');
    const fired =
      starts.find((node) => node.id === trigger.nodeId) ?? starts[0];
    if (!fired) {
      this.halt(new RunStop('failed', 'This flow has no Start node.'));
      return;
    }
    for (const node of starts)
      if (node !== fired) this.skip(node, 'this Start did not fire');
    this.launch(fired);
    this.pump();
  }

  /** Schedules every ready node, skips dead ones, and finishes when nothing is left. */
  private pump() {
    if (this.finished) return;
    try {
      if (!this.stop) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of executable(this.graph)) {
            if (this.states.get(node.id)?.state !== 'pending') continue;
            if (node.type === 'start') continue;
            // A For each body is driven by its container, once per item, so
            // the outer pass leaves those steps alone.
            if (node.parentId) continue;
            const config = mergedConfig(node);
            const state = readiness(
              this.graph,
              node.id,
              this.states,
              config.startWhen === 'first' ? 'first' : 'all',
            );
            if (state === 'skip') {
              this.skip(node, 'no input arrived');
              changed = true;
            } else if (
              state === 'ready' &&
              this.running.size + this.inner < RUN_LIMITS.concurrency
            ) {
              this.launch(node);
              changed = true;
            }
          }
        }
      }
      if (this.running.size) return;
      this.disarmTimer();
      if (this.stop) {
        this.finish();
        return;
      }
      const waiting = [...this.states.entries()].find(
        ([, run]) => run.state === 'waiting',
      );
      if (waiting) {
        this.store.setStatus(this.id, 'waiting', { waitingNodeId: waiting[0] });
        return;
      }
      this.finish();
    } catch (error) {
      this.halt(new RunStop('failed', message(error)));
    }
  }

  /**
   * Runs one inner worker (a container iteration or a per-item fan-out) with
   * its executor call counted against the run's step concurrency, so every
   * path through the engine shares the one documented cap.
   */
  private async innerWorker<T>(work: () => Promise<T>): Promise<T> {
    this.inner += 1;
    try {
      return await work();
    } finally {
      this.inner -= 1;
    }
  }
  private launch(node: FlowNode) {
    this.running.add(node.id);
    this.states.set(node.id, { state: 'running', output: null });
    this.armTimer();
    void this.runNode(node).finally(() => {
      this.running.delete(node.id);
      this.pump();
    });
  }
  private armTimer() {
    if (this.timer || this.finished) return;
    const remaining = this.settings.timeoutMinutes * 60_000 - this.usedMs;
    this.armedAt = Date.now();
    this.timer = setTimeout(
      () =>
        this.halt(
          new RunStop(
            'failed',
            `The run exceeded its ${this.settings.timeoutMinutes} minute time limit.`,
          ),
        ),
      Math.max(0, remaining),
    );
  }
  private disarmTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.armedAt != null) this.usedMs += Date.now() - this.armedAt;
    this.armedAt = null;
  }

  /**
   * Live values per input port, in connection order. A For each body passes
   * its own states, where the container stands completed with the item it is
   * handling, so a body step reads that item instead of the whole list.
   */
  private collectInputs(
    node: FlowNode,
    states: Map<string, NodeRun> = this.states,
  ): Record<string, PortValue[]> {
    const inputs: Record<string, PortValue[]> = {};
    for (const edge of this.graph.edges) {
      if (edge.target !== node.id) continue;
      const source = states.get(edge.source);
      if (edgeState(edge, source) !== 'value') continue;
      const entry = source!.output![edge.sourceHandle];
      const from = this.node(edge.source);
      (inputs[edge.targetHandle] ??= []).push({
        kind: entry.kind,
        value: entry.value,
        from: from ? nodeLabel(from) : edge.source,
      });
    }
    return inputs;
  }
  private context(
    node: FlowNode,
    inputs: Record<string, PortValue[]>,
    signal: AbortSignal,
    item?: { index: number; value: unknown },
    /** Chip lookup for a For each body, where the container holds one item. */
    resolve?: (id: string) => StepOutput | null | undefined,
  ): StepContext {
    const label = nodeLabel(node);
    const reported = new Set<string>();
    const scope = tokenScope(this.graph, node.id, this.record.trigger, (id) =>
      resolve ? resolve(id) : this.states.get(id)?.output,
    );
    return {
      runId: this.id,
      flowId: this.record.flowId,
      flowName: this.record.flowName,
      node,
      label,
      config: mergedConfig(node),
      trigger: this.record.trigger,
      inputs,
      item,
      signal,
      render: (text) =>
        renderTokens(text, scope, (token) => {
          if (reported.has(token)) return;
          reported.add(token);
          this.event(
            node.id,
            'log',
            `${label}: ${token} has no value because its source did not run; using an empty value.`,
          );
        }),
      log: (text) => this.event(node.id, 'log', text),
      message: (text) => this.event(node.id, 'message', text),
      setResult: (name, part) => this.setResult(name, part),
      replyToTrigger: (text) => this.runner.replyToTrigger(this.id, text),
      thread: (dotId, title, mode, key) => this.thread(dotId, title, mode, key),
      turn: (threadId, prompt) => this.turn(node, threadId, prompt, signal),
      child: (flowId, input, fields) =>
        this.runner.runChild({
          parentRunId: this.id,
          flowId,
          input,
          fields,
          signal,
          log: (text) => this.event(node.id, 'log', `${label}: ${text}`),
        }),
      platform: this.runner.platform,
    };
  }
  private async thread(
    dotId: string,
    title: string,
    mode: ThreadMode,
    key?: string,
  ) {
    const bind = () =>
      this.runner.platform.workspace.bindThread(randomUUID(), dotId, title).id;
    if (mode === 'continue') {
      const existing = this.threads.get(dotId);
      if (existing) return existing;
      const id = bind();
      this.threads.set(dotId, id);
      return id;
    }
    if (mode === 'keyed' && key) {
      // Remembered across runs and restarts; a thread the owner deleted
      // meanwhile is replaced by a fresh one.
      const flowId = this.record.flowId;
      const existing = this.store.keyedThread(flowId, dotId, key);
      if (existing)
        try {
          this.runner.platform.workspace.requireThread(existing, dotId);
          return existing;
        } catch {
          // Fall through and bind a new thread for this key.
        }
      const id = bind();
      this.store.saveKeyedThread(flowId, dotId, key, id);
      return id;
    }
    return bind();
  }
  private async turn(
    node: FlowNode,
    threadId: string,
    prompt: string,
    signal: AbortSignal,
  ) {
    const turns = this.store.countDotTurn(this.id);
    if (turns > this.settings.maxDotTurns)
      throw new Error(
        `This run reached its limit of ${this.settings.maxDotTurns} Dot turns.`,
      );
    const config = mergedConfig(node);
    return this.runner.platform.turn(threadId, prompt, signal, {
      opendotsSource: 'flow',
      runId: this.id,
      nodeId: node.id,
      flowId: this.record.flowId,
      // Honoured by DotAgent: connected tools outside the allowlist are not
      // offered, and page writes are withheld when the owner wants to be asked.
      tools: listValues(config.tools),
      reviewBeforeSave: !!config.reviewBeforeSave,
    });
  }
  private setResult(label: string, part: Omit<RunResult, 'parts'>) {
    const parts = { ...(this.result?.parts ?? {}), [label]: part.text };
    const seen = new Set((this.result?.sources ?? []).map((s) => s.url));
    const sources = [
      ...(this.result?.sources ?? []),
      ...part.sources.filter((source) => !seen.has(source.url)),
    ];
    const labels = Object.keys(parts);
    this.result = {
      text:
        labels.length === 1
          ? parts[labels[0]]
          : labels.map((name) => `## ${name}\n\n${parts[name]}`).join('\n\n'),
      sources,
      parts,
    };
    this.store.setResult(this.id, this.result);
  }

  /** Runs one node: per item when configured, with retries and time limits. */
  private async runNode(node: FlowNode) {
    const label = nodeLabel(node);
    const config = mergedConfig(node);
    const startedAt = Date.now();
    const inputs = this.collectInputs(node);
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      status: 'running',
      startedAt,
    });
    this.event(node.id, 'step', `${label} started.`);
    try {
      const primary = nodeInputs(node)[0]?.id;
      const first = primary ? inputs[primary]?.[0]?.value : undefined;
      const outcome =
        node.type === 'for-each'
          ? await this.runContainer(node, inputs, startedAt)
          : config.perItem && primary && Array.isArray(first)
            ? await this.runItems(node, inputs, primary, first)
            : await this.attempt(node, inputs, 1, undefined, startedAt);
      if (this.finished) return;
      const info = this.attemptOf(node, startedAt);
      if (outcome.kind === 'wait')
        this.park(node, outcome, info.startedAt, info.attempt);
      else if (outcome.kind === 'sleep')
        this.parkWait(node, outcome, info.startedAt, info.attempt);
      else this.complete(node, outcome, info.startedAt, info.attempt);
    } catch (error) {
      if (this.finished) return;
      const info = this.attemptOf(node, startedAt);
      if (error instanceof RunStop || this.controller.signal.aborted) {
        this.failStep(node, info.startedAt, message(error), null, info.attempt);
        return;
      }
      if (config.onError === 'continue') {
        const output = fallbackOutput(node);
        this.failStep(
          node,
          info.startedAt,
          message(error),
          output,
          info.attempt,
        );
        this.event(node.id, 'log', `${label}: ${fallbackText(node, output)}`);
        return;
      }
      this.failStep(node, info.startedAt, message(error), null, info.attempt);
      this.halt(new RunStop('failed', `${label} failed: ${message(error)}`));
    }
  }
  /** One executor call with the node's time limit; retries once when asked. */
  private async attempt(
    node: FlowNode,
    inputs: Record<string, PortValue[]>,
    attempt: number,
    item: { index: number; value: unknown } | undefined,
    startedAt: number,
    resolve?: (id: string) => StepOutput | null | undefined,
  ): Promise<StepOutcome> {
    const config = mergedConfig(node);
    const label = nodeLabel(node);
    this.attempts.set(attemptKey(node.id, item), { attempt, startedAt });
    const step = new AbortController();
    const forward = () => step.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) forward();
    else
      this.controller.signal.addEventListener('abort', forward, { once: true });
    const minutes = Number(config.timeLimitMinutes) || 0;
    const limit = minutes
      ? setTimeout(
          () =>
            step.abort(
              new Error(`${label} exceeded its ${minutes} minute time limit.`),
            ),
          minutes * 60_000,
        )
      : undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(step.signal.reason);
        if (step.signal.aborted) fail();
        else step.signal.addEventListener('abort', fail, { once: true });
      });
      return await Promise.race([
        executorFor(node.type).run(
          this.context(node, inputs, step.signal, item, resolve),
        ),
        aborted,
      ]);
    } catch (error) {
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      if (config.onError === 'retry' && attempt === 1) {
        this.event(
          node.id,
          'log',
          `${label} failed (${message(error)}); retrying once.`,
        );
        // The first attempt keeps its own row; the retry gets a second one.
        const finishedAt = Date.now();
        const base = {
          runId: this.id,
          nodeId: node.id,
          nodeType: node.type,
          label,
          iterationKey: item ? String(item.index) : '',
        };
        this.store.saveStep({
          ...base,
          attempt: 1,
          status: 'failed',
          error: message(error),
          startedAt,
          finishedAt,
        });
        this.store.saveStep({
          ...base,
          attempt: 2,
          status: 'running',
          startedAt: finishedAt,
        });
        return this.attempt(node, inputs, 2, item, finishedAt, resolve);
      }
      throw error;
    } finally {
      clearTimeout(limit);
      this.controller.signal.removeEventListener('abort', forward);
    }
  }
  /** Runs the step once per list element and emits arrays on every port. */
  private async runItems(
    node: FlowNode,
    inputs: Record<string, PortValue[]>,
    primary: string,
    items: unknown[],
  ): Promise<StepOutcome> {
    const label = nodeLabel(node);
    const config = mergedConfig(node);
    const list = items.slice(0, RUN_LIMITS.maxItems);
    if (items.length > list.length)
      this.event(
        node.id,
        'log',
        `${label}: only the first ${RUN_LIMITS.maxItems} of ${items.length} items run.`,
      );
    this.event(node.id, 'log', `${label} runs once per item (${list.length}).`);
    const outputs: (StepOutput | null)[] = new Array(list.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const index = next++;
        if (this.controller.signal.aborted) return;
        const value = list[index];
        const item = { index, value };
        const itemInputs = {
          ...inputs,
          [primary]: [
            {
              kind:
                typeof value === 'string'
                  ? ('text' as const)
                  : ('json' as const),
              value,
              from: inputs[primary]?.[0]?.from ?? label,
            },
          ],
        };
        const startedAt = Date.now();
        const base = {
          runId: this.id,
          nodeId: node.id,
          nodeType: node.type,
          label,
          iterationKey: String(index),
        };
        this.store.saveStep({ ...base, status: 'running', startedAt });
        try {
          const outcome = await this.attempt(
            node,
            itemInputs,
            1,
            item,
            startedAt,
          );
          if (outcome.kind !== 'output')
            throw new Error('A step that pauses cannot run once per item.');
          outputs[index] = outcome.output;
          const info = this.attemptOf(node, startedAt, item);
          this.store.saveStep({
            ...base,
            attempt: info.attempt,
            status: 'completed',
            input: outcome.input,
            output: outcome.output,
            threadId: outcome.threadId,
            startedAt: info.startedAt,
            finishedAt: Date.now(),
          });
        } catch (error) {
          if (this.discarded) throw error;
          const info = this.attemptOf(node, startedAt, item);
          this.store.saveStep({
            ...base,
            attempt: info.attempt,
            status: 'failed',
            error: message(error),
            startedAt: info.startedAt,
            finishedAt: Date.now(),
          });
          if (config.onError !== 'continue' || this.controller.signal.aborted)
            throw error;
          this.event(
            node.id,
            'log',
            `${label}: item ${index + 1} failed (${message(error)}); continuing.`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ITEM_CONCURRENCY, list.length) }, () =>
        this.innerWorker(worker),
      ),
    );
    const ports = new Set<string>();
    for (const output of outputs)
      for (const port of Object.keys(output ?? {})) ports.add(port);
    const output: StepOutput = {};
    for (const port of ports)
      output[port] = {
        kind: 'json',
        value: outputs.map((entry) => entry?.[port]?.value ?? null),
      };
    return { kind: 'output', output, input: { items: list.length } };
  }

  // For each ---------------------------------------------------------------

  /**
   * Runs a For each: its body once per item, with `iterationKey` = the item
   * index on every step inside, then the collected results on `results`. The
   * body never reaches the outer readiness pass (see pump), so this is the
   * only thing that schedules those steps.
   */
  private async runContainer(
    node: FlowNode,
    inputs: Record<string, PortValue[]>,
    startedAt: number,
  ): Promise<StepOutcome> {
    const label = nodeLabel(node);
    const config = mergedConfig(node);
    const body = bodySteps(this.graph, node.id);
    const items = containerItems(inputs.list?.[0]?.value);
    const cap = Math.max(
      1,
      Math.min(
        Number(config.maxItems) || RUN_LIMITS.maxItems,
        RUN_LIMITS.maxItems,
      ),
    );
    const list = items.slice(0, cap);
    if (items.length > list.length)
      this.event(
        node.id,
        'log',
        `${label}: only the first ${list.length} of ${items.length} items run.`,
      );
    if (!body.length) {
      this.event(
        node.id,
        'log',
        `${label} has no steps inside it, so there is nothing to repeat.`,
      );
      return {
        kind: 'output',
        output: { results: { kind: 'json', value: [] } },
        input: { items: 0 },
      };
    }
    const concurrency = Math.max(
      1,
      Math.min(Number(config.concurrency) || 1, FOR_EACH_MAX_CONCURRENCY),
    );
    const stopOnError = config.onItemError === 'stop';
    this.event(
      node.id,
      'log',
      `${label} runs ${body.length} step${body.length === 1 ? '' : 's'} for each of ${list.length} item${list.length === 1 ? '' : 's'}.`,
    );
    const results: unknown[] = new Array(list.length).fill(null);
    /** Per body step, the output of every item, so the '' row can hold them. */
    const collected = new Map<string, (StepOutput | null)[]>(
      body.map((step) => [step.id, new Array(list.length).fill(null)]),
    );
    let failure: unknown;
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const index = next++;
        if (this.controller.signal.aborted || failure !== undefined) return;
        try {
          const states = await this.runIteration(
            node,
            body,
            index,
            list[index],
          );
          results[index] = iterationResult(this.graph, body, states);
          for (const step of body)
            collected.get(step.id)![index] =
              states.get(step.id)?.output ?? null;
        } catch (error) {
          if (this.controller.signal.aborted) throw error;
          // "Cannot pause" is the body's shape being wrong, not this item
          // going wrong: skipping it would leave every item unsaved and the
          // run green. The linter refuses the shape, so this is the net.
          if (stopOnError || error instanceof BodyCannotPause) {
            failure = error;
            return;
          }
          this.event(
            node.id,
            'log',
            `${label}: item ${index + 1} failed (${message(error)}); skipping it.`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, list.length) }, () =>
        this.innerWorker(worker),
      ),
    );
    this.closeBody(node, body, collected, list.length, startedAt);
    if (failure !== undefined) throw failure;
    return {
      kind: 'output',
      output: { results: { kind: 'json', value: results } },
      input: { items: list.length },
    };
  }
  /**
   * One pass through the body with `item` bound, scheduled by the same
   * readiness rule the outer graph uses: the container stands completed with
   * this one item on its Item port, so skip propagation inside a body works
   * exactly as it does outside.
   */
  private async runIteration(
    container: FlowNode,
    body: FlowNode[],
    index: number,
    value: unknown,
  ): Promise<Map<string, NodeRun>> {
    const states = new Map(this.states);
    states.set(container.id, {
      state: 'completed',
      output: {
        item: {
          kind: typeof value === 'string' ? 'text' : 'json',
          value,
        },
      },
    });
    for (const step of body)
      states.set(step.id, { state: 'pending', output: null });
    const resolve = (id: string) =>
      states.get(id)?.output ?? this.states.get(id)?.output;
    for (let open = true; open;) {
      open = false;
      for (const step of body) {
        if (states.get(step.id)?.state !== 'pending') continue;
        this.controller.signal.throwIfAborted();
        const config = mergedConfig(step);
        const ready = readiness(
          this.graph,
          step.id,
          states,
          config.startWhen === 'first' ? 'first' : 'all',
        );
        if (ready === 'wait') continue;
        open = true;
        if (ready === 'skip') {
          states.set(step.id, { state: 'skipped', output: null });
          this.store.saveStep({
            runId: this.id,
            nodeId: step.id,
            nodeType: step.type,
            label: nodeLabel(step),
            iterationKey: String(index),
            status: 'skipped',
            error: 'No input arrived for this item.',
            finishedAt: Date.now(),
          });
          continue;
        }
        await this.runBodyStep(step, index, value, states, resolve);
      }
    }
    return states;
  }
  /** One body step for one item: its own row, keyed by the item index. */
  private async runBodyStep(
    node: FlowNode,
    index: number,
    value: unknown,
    states: Map<string, NodeRun>,
    resolve: (id: string) => StepOutput | null | undefined,
  ) {
    const label = nodeLabel(node);
    const config = mergedConfig(node);
    const startedAt = Date.now();
    const base = {
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      iterationKey: String(index),
    };
    this.store.saveStep({ ...base, status: 'running', startedAt });
    states.set(node.id, { state: 'running', output: null });
    const inputs = this.collectInputs(node, states);
    try {
      const outcome = await this.attempt(
        node,
        inputs,
        1,
        { index, value },
        startedAt,
        resolve,
      );
      if (outcome.kind !== 'output') throw new BodyCannotPause(label);
      const info = this.attemptOf(node, startedAt, { index });
      this.store.saveStep({
        ...base,
        attempt: info.attempt,
        status: 'completed',
        input: outcome.input,
        output: outcome.output,
        threadId: outcome.threadId,
        startedAt: info.startedAt,
        finishedAt: Date.now(),
      });
      states.set(node.id, { state: 'completed', output: outcome.output });
    } catch (error) {
      const info = this.attemptOf(node, startedAt, { index });
      const continues =
        config.onError === 'continue' &&
        !this.controller.signal.aborted &&
        !(error instanceof BodyCannotPause);
      const output = continues ? fallbackOutput(node) : null;
      this.store.saveStep({
        ...base,
        attempt: info.attempt,
        status: 'failed',
        output,
        error: message(error),
        startedAt: info.startedAt,
        finishedAt: Date.now(),
      });
      states.set(node.id, { state: 'failed', output });
      if (!continues) throw error;
      this.event(
        node.id,
        'log',
        `${label} (item ${index + 1}): ${fallbackText(node, output!)}`,
      );
    }
  }
  /**
   * Closes the body's ordinary rows once the loop is over: each step gets its
   * per-item outputs as arrays, so the run log shows the body as part of the
   * run rather than as steps that never ran.
   */
  private closeBody(
    container: FlowNode,
    body: FlowNode[],
    collected: Map<string, (StepOutput | null)[]>,
    items: number,
    startedAt: number,
  ) {
    const finishedAt = Date.now();
    for (const step of body) {
      const outputs = collected.get(step.id) ?? [];
      if (!items || !outputs.some(Boolean)) {
        this.states.set(step.id, { state: 'skipped', output: null });
        this.store.saveStep({
          runId: this.id,
          nodeId: step.id,
          nodeType: step.type,
          label: nodeLabel(step),
          status: 'skipped',
          error: items
            ? `No item reached this step inside ${nodeLabel(container)}.`
            : `${nodeLabel(container)} had no items.`,
          finishedAt,
        });
        continue;
      }
      const ports = new Set(
        outputs.flatMap((output) => Object.keys(output ?? {})),
      );
      const output: StepOutput = {};
      for (const port of ports)
        output[port] = {
          kind: 'json',
          value: outputs.map((entry) => entry?.[port]?.value ?? null),
        };
      this.states.set(step.id, { state: 'completed', output });
      this.store.saveStep({
        runId: this.id,
        nodeId: step.id,
        nodeType: step.type,
        label: nodeLabel(step),
        status: 'completed',
        input: { items },
        output,
        startedAt,
        finishedAt,
      });
    }
  }

  private complete(
    node: FlowNode,
    outcome: Extract<StepOutcome, { kind: 'output' }>,
    startedAt: number,
    attempt = 1,
  ) {
    const label = nodeLabel(node);
    const finishedAt = Date.now();
    this.states.set(node.id, { state: 'completed', output: outcome.output });
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      attempt,
      status: 'completed',
      input: outcome.input,
      output: outcome.output,
      threadId: outcome.threadId,
      startedAt,
      finishedAt,
    });
    this.event(
      node.id,
      'step',
      `${label} completed in ${duration(finishedAt - startedAt)}.`,
    );
    // Late arrivals at a node that already started with "first" are ignored.
    for (const edge of this.graph.edges) {
      if (edge.source !== node.id) continue;
      const target = this.node(edge.target);
      const state = this.states.get(edge.target)?.state;
      if (
        target &&
        state &&
        state !== 'pending' &&
        mergedConfig(target).startWhen === 'first'
      )
        this.event(
          edge.target,
          'log',
          `${nodeLabel(target)} had already started; the value from ${label} was ignored.`,
        );
    }
  }
  /** `startedAt` null keeps the time already on the row (see saveStep). */
  private failStep(
    node: FlowNode,
    startedAt: number | null,
    error: string,
    output: StepOutput | null,
    attempt = 1,
  ) {
    const label = nodeLabel(node);
    this.states.set(node.id, { state: 'failed', output });
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      attempt,
      status: 'failed',
      output,
      error,
      startedAt,
      finishedAt: Date.now(),
    });
    this.event(node.id, 'step', `${label} failed: ${error}`);
  }
  /** A step that never ran, or stopped waiting because the run ended (`error` says why). */
  private skip(
    node: FlowNode,
    reason: string,
    options: { attempt?: number; error?: string } = {},
  ) {
    const label = nodeLabel(node);
    this.states.set(node.id, { state: 'skipped', output: null });
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      attempt: options.attempt,
      status: 'skipped',
      error: options.error,
      finishedAt: Date.now(),
    });
    this.event(node.id, 'step', `${label} was skipped: ${reason}.`);
  }
  private park(
    node: FlowNode,
    outcome: Extract<StepOutcome, { kind: 'wait' }>,
    startedAt: number,
    attempt = 1,
  ) {
    const label = nodeLabel(node);
    this.states.set(node.id, { state: 'waiting', output: null });
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      attempt,
      status: 'waiting',
      input: outcome.input,
      startedAt,
    });
    const approval = this.store.createApproval({
      runId: this.id,
      flowId: this.record.flowId,
      nodeId: node.id,
      ...outcome.approval,
    });
    this.store.setStatus(this.id, 'waiting', { waitingNodeId: node.id });
    this.event(
      node.id,
      'approval',
      `${label} is waiting for your decision: ${approval.title}`,
    );
  }
  /**
   * Parks a Wait step until its time comes. Nothing is held: the step row and
   * the run go to waiting, the wake time is persisted, the run timer is
   * disarmed by the next pump, and the scheduler (or the next server start)
   * picks the step up again through FlowRunner.wakeDue.
   */
  private parkWait(
    node: FlowNode,
    outcome: Extract<StepOutcome, { kind: 'sleep' }>,
    startedAt: number,
    attempt = 1,
  ) {
    const label = nodeLabel(node);
    this.states.set(node.id, { state: 'waiting', output: null });
    this.store.saveStep({
      runId: this.id,
      nodeId: node.id,
      nodeType: node.type,
      label,
      attempt,
      status: 'waiting',
      input: outcome.input,
      startedAt,
    });
    this.store.saveWait(this.id, node.id, outcome.until);
    this.store.setStatus(this.id, 'waiting', { waitingNodeId: node.id });
    this.event(
      node.id,
      'step',
      `${label} is waiting until ${new Date(outcome.until).toISOString()}.`,
    );
  }
  /** Carries a parked Wait on once its time arrived. */
  async wake(nodeId: string) {
    const node = this.node(nodeId);
    if (!node || this.states.get(nodeId)?.state !== 'waiting') return;
    const label = nodeLabel(node);
    this.store.clearWait(this.id, nodeId);
    const others = [...this.states.entries()].find(
      ([id, run]) => id !== nodeId && run.state === 'waiting',
    );
    this.store.setStatus(this.id, 'running', {
      waitingNodeId: others?.[0] ?? null,
    });
    this.states.set(nodeId, { state: 'running', output: null });
    this.running.add(nodeId);
    this.armTimer();
    // The step started when it parked, so its row keeps that time.
    const info = this.attemptOf(node, Date.now());
    try {
      const executor = executorFor(node.type);
      const inputs = this.collectInputs(node);
      const ctx = this.context(node, inputs, this.controller.signal);
      const output = executor.wake ? await executor.wake(ctx) : {};
      if (!this.finished)
        this.complete(
          node,
          { kind: 'output', output },
          info.startedAt,
          info.attempt,
        );
    } catch (error) {
      if (!this.finished) {
        const continues = mergedConfig(node).onError === 'continue';
        const output = continues ? fallbackOutput(node) : null;
        this.failStep(
          node,
          info.startedAt,
          message(error),
          output,
          info.attempt,
        );
        if (!output)
          this.halt(
            new RunStop('failed', `${label} failed: ${message(error)}`),
          );
      }
    } finally {
      this.running.delete(nodeId);
      this.pump();
    }
  }

  /** Applies a decision to the waiting step and carries on. */
  async resume(approval: FlowApproval, decision: Decision) {
    const node = this.node(approval.nodeId);
    if (!node || this.states.get(node.id)?.state !== 'waiting')
      throw new Error('This run is no longer waiting on that step.');
    const label = nodeLabel(node);
    const verb =
      decision.action === 'approve'
        ? 'approved'
        : decision.action === 'changes'
          ? 'requested changes on'
          : 'declined';
    this.event(node.id, 'approval', `You ${verb} ${approval.title}.`);
    const others = [...this.states.entries()].find(
      ([id, run]) => id !== node.id && run.state === 'waiting',
    );
    this.store.setStatus(this.id, 'running', {
      waitingNodeId: others?.[0] ?? null,
    });
    this.states.set(node.id, { state: 'running', output: null });
    this.running.add(node.id);
    this.armTimer();
    // The step started when it parked, so its row keeps that time.
    const info = this.attemptOf(node, Date.now());
    try {
      const executor = executorFor(node.type);
      const inputs = this.collectInputs(node);
      const ctx = this.context(node, inputs, this.controller.signal);
      const output = executor.resume
        ? await executor.resume(ctx, approval, decision)
        : {};
      if (!this.finished)
        this.complete(
          node,
          { kind: 'output', output },
          info.startedAt,
          info.attempt,
        );
    } catch (error) {
      if (!this.finished) {
        const continues = mergedConfig(node).onError === 'continue';
        const output = continues ? fallbackOutput(node) : null;
        this.failStep(
          node,
          info.startedAt,
          message(error),
          output,
          info.attempt,
        );
        if (output)
          this.event(node.id, 'log', `${label}: ${fallbackText(node, output)}`);
        else
          this.halt(
            new RunStop('failed', `${label} failed: ${message(error)}`),
          );
      }
    } finally {
      this.running.delete(node.id);
      this.pump();
    }
  }

  /** Stops the run: in-flight steps abort, waiting steps close, then finish. */
  halt(stop: RunStop) {
    if (this.finished || this.stop) return;
    this.stop = stop;
    this.controller.abort(stop);
    // A step still waiting on a person did not fail; the run ended around it.
    for (const node of executable(this.graph))
      if (this.states.get(node.id)?.state === 'waiting')
        this.skip(node, stop.message.replace(/\.$/, ''), {
          attempt: this.attemptOf(node, Date.now()).attempt,
          error: stop.message,
        });
    this.store.expireApprovals(this.id);
    // A parked Wait has nothing to wake up to any more.
    this.store.clearWaits(this.id);
    if (!this.running.size || stop.outcome === 'interrupted') this.finish();
  }
  /**
   * Drops the run because its flow was deleted: in-flight steps abort and
   * nothing more is written, since the rows are gone.
   */
  discard() {
    if (this.finished) return;
    this.finished = true;
    this.discarded = true;
    this.stop ??= new RunStop('cancelled', CANCELLED_MESSAGE);
    this.disarmTimer();
    this.controller.abort(this.stop);
    this.runner.release(this.id);
    this.settle();
  }
  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.disarmTimer();
    const outcome = this.stop?.outcome ?? 'completed';
    const reason = this.stop?.message ?? STOPPED_MESSAGE;
    for (const node of executable(this.graph)) {
      const state = this.states.get(node.id)?.state;
      if (state === 'pending')
        this.skip(
          node,
          outcome === 'completed'
            ? 'its inputs can never arrive'
            : 'the run stopped first',
        );
      // An interrupted run finishes before its aborted steps report back.
      else if (state === 'running')
        this.failStep(
          node,
          null,
          reason,
          null,
          this.attemptOf(node, Date.now()).attempt,
        );
    }
    // Per-item rows of those steps close with the same reason.
    if (this.stop) this.store.failOpenSteps(this.id, reason);
    this.store.clearWaits(this.id);
    const hasResult = !!this.result;
    this.store.setStatus(this.id, outcome, {
      error: this.stop?.message ?? null,
      result: hasResult ? this.result : null,
      finished: true,
    });
    this.event(
      null,
      'run',
      outcome === 'completed'
        ? 'Run completed.'
        : outcome === 'cancelled'
          ? 'Run cancelled.'
          : outcome === 'interrupted'
            ? STOPPED_MESSAGE
            : `Run failed: ${this.stop?.message ?? 'unknown error'}`,
    );
    this.runner.release(this.id);
    this.settle();
  }
}

// The runner ---------------------------------------------------------------

/**
 * Starts, resumes, cancels and schedules flow runs. One instance lives on the
 * Platform; routes and the scheduler go through it rather than the store.
 */
export class FlowRunner {
  private readonly active = new Map<string, RunExecution>();
  /**
   * Per run, the way back to the conversation that started it (today only a
   * Slack thread, handed over by FlowTriggerBridge). In memory only: a reply
   * is a live callback on the channel that received the mention, so a run
   * rehydrated after a restart simply has none and says so.
   */
  private readonly replies = new Map<string, (text: string) => Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly platform: Platform) {}
  get store() {
    return this.platform.workspace.runs;
  }
  /** Gives a run a way to answer in the conversation that triggered it. */
  attachReply(runId: string, reply: (text: string) => Promise<void>) {
    this.replies.set(runId, reply);
  }
  /**
   * Posts a step's text back into the conversation that started the run.
   * Returns false when there is none — an unpublished flow run by hand, a
   * run rehydrated after a restart — so the step can say so in the run log
   * instead of failing.
   */
  async replyToTrigger(runId: string, text: string): Promise<boolean> {
    const reply = this.replies.get(runId);
    if (!reply) return false;
    await reply(text);
    return true;
  }

  /** Creates a queued run against a snapshot of `graph`; call start() next. */
  create(
    flow: Pick<Flow, 'id' | 'name'>,
    graph: FlowGraph,
    versionId: string | null,
    trigger: RunTrigger,
    /** The run whose Run flow step is starting this one. */
    parentRunId: string | null = null,
  ): RunRecord {
    return this.store.create({
      flowId: flow.id,
      flowName: flow.name,
      versionId,
      graph: structuredClone(graph),
      trigger,
      parentRunId,
      steps: executable(graph).map((node) => ({
        nodeId: node.id,
        nodeType: node.type,
        label: nodeLabel(node),
      })),
    });
  }
  /** Begins executing a queued run; returns at once, the run continues in the background. */
  start(runId: string) {
    if (this.active.has(runId)) return;
    const record = this.store.run(runId);
    if (!record) throw new Error('Run not found.');
    if (record.status !== 'queued')
      throw new Error('This run already started.');
    const execution = new RunExecution(this, record);
    this.active.set(runId, execution);
    execution.begin();
  }
  /** Resolves when the run reaches a final status; immediately when it is not active. */
  async settled(runId: string) {
    await this.active.get(runId)?.settled();
  }
  /** The in-memory execution, rebuilt from the tables for a run left waiting. */
  private execution(runId: string): RunExecution | undefined {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const record = this.store.run(runId);
    if (!record || !runIsActive(record.status)) return undefined;
    const execution = new RunExecution(this, record);
    this.active.set(runId, execution);
    return execution;
  }
  release(runId: string) {
    this.active.delete(runId);
    this.replies.delete(runId);
  }
  /**
   * Forgets everything about a flow being deleted: active runs are dropped
   * (their steps abort). The caller removes the rows, keyed threads included
   * (FlowRunStore.removeFlow), afterwards.
   */
  discardFlow(flowId: string) {
    for (const execution of [...this.active.values()])
      if (execution.record.flowId === flowId) execution.discard();
  }
  /** Cancels an active run; returns the run, or undefined when it does not exist. */
  cancel(runId: string): FlowRun | undefined {
    const record = this.store.run(runId);
    if (!record) return undefined;
    this.execution(runId)?.halt(new RunStop('cancelled', CANCELLED_MESSAGE));
    return this.store.get(runId);
  }
  /**
   * Records a decision on a pending approval and resumes its run. Throws
   * 'decided' when the approval was already answered.
   */
  async decide(
    approvalId: string,
    decision: Decision,
  ): Promise<FlowRun | undefined> {
    const approval = this.store.approval(approvalId);
    if (!approval) return undefined;
    if (approval.status !== 'pending') throw new Error('decided');
    const execution = this.execution(approval.runId);
    if (!execution) throw new Error('This run is no longer active.');
    // Checked before the approval is consumed, so a stale one stays decidable.
    if (!execution.canResume(approval.nodeId))
      throw new Error('This run is no longer waiting on that step.');
    if (
      !this.store.decideApproval(
        approvalId,
        decision.action,
        decision.feedback,
        decision.editedText,
      )
    )
      throw new Error('decided');
    await execution.resume(approval, decision);
    return this.store.get(approval.runId);
  }

  // Run flow ---------------------------------------------------------------

  /**
   * Runs another flow as a child of `parentRunId` and resolves with its
   * result. The child is an ordinary run row with `parentRunId` set, so it
   * shows up in that flow's history and the chain is what the recursion
   * guard reads: a flow may not appear twice in its own ancestry, and
   * MAX_FLOW_DEPTH bounds how deep the nesting goes.
   *
   * A child that parks for a person cannot be answered from inside a step,
   * so it is cancelled and the step fails saying so; cancelling the parent
   * cancels the child through the step's abort signal.
   */
  async runChild(options: {
    parentRunId: string;
    flowId: string;
    input: string;
    fields?: Record<string, unknown>;
    signal: AbortSignal;
    log?: (text: string) => void;
  }): Promise<ChildRun> {
    const flows = this.platform.workspace.flows;
    const flow = flows.get(options.flowId);
    if (!flow) throw new Error('The chosen flow no longer exists.');
    const chain = this.store.ancestry(options.parentRunId);
    if (chain.some((entry) => entry.flowId === options.flowId))
      throw new Error(
        chain[0]?.flowId === options.flowId
          ? `"${flow.name}" cannot run itself.`
          : `"${flow.name}" is already running further up this chain, so it cannot run again here.`,
      );
    if (chain.length >= MAX_FLOW_DEPTH)
      throw new Error(
        `Flows can only run ${MAX_FLOW_DEPTH} deep; "${flow.name}" would be one level too far.`,
      );
    const version = flow.publishedVersionId
      ? flows.version(flow.id, flow.publishedVersionId)
      : undefined;
    const graph = version?.graph ?? flow.graph;
    const starts = graph.nodes.filter((node) => node.type === 'start');
    const start =
      starts.find((node) => (node.config.trigger ?? 'manual') === 'manual') ??
      starts[0];
    if (!start) throw new Error(`"${flow.name}" has no Start node.`);
    options.signal.throwIfAborted();
    const record = this.create(
      flow,
      graph,
      version?.id ?? null,
      {
        source: 'manual',
        nodeId: start.id,
        input: options.input,
        fields: options.fields,
      },
      options.parentRunId,
    );
    options.log?.(
      `running "${flow.name}"${version ? '' : ' (draft)'} as run ${record.id}.`,
    );
    this.start(record.id);
    const settled = this.settled(record.id);
    // Three things end the wait, and only one of them needs polling. The
    // child finishing settles its own promise and aborting fires an event, so
    // both are watched once; a child that parks never settles, so that one is
    // noticed by reading just its status every CHILD_POLL_MS. Every promise
    // here is created once, so nothing accumulates handlers for the life of
    // the child (which a `Promise.race` inside the loop used to do).
    const finished = settled.then(() => 'finished' as const);
    const aborted = new Promise<'aborted'>((resolve) => {
      if (options.signal.aborted) resolve('aborted');
      else
        options.signal.addEventListener('abort', () => resolve('aborted'), {
          once: true,
        });
    });
    let stopPolling = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const parked = (async () => {
      for (;;) {
        await new Promise((resolve) => {
          poll = setTimeout(resolve, CHILD_POLL_MS);
        });
        if (stopPolling) return 'finished' as const;
        const status = this.store.statusOf(record.id)?.status;
        if (status === 'waiting') return 'parked' as const;
        if (!status || !runIsActive(status)) return 'finished' as const;
      }
    })();
    let outcome: 'finished' | 'aborted' | 'parked';
    try {
      outcome = await Promise.race([finished, aborted, parked]);
    } finally {
      stopPolling = true;
      clearTimeout(poll);
    }
    if (outcome !== 'finished') {
      this.cancel(record.id);
      await settled;
      if (outcome === 'aborted') throw options.signal.reason;
      throw new Error(
        `"${flow.name}" stopped to wait, and a flow used as a step cannot wait. Take the Human review or Wait out of it.`,
      );
    }
    const current = this.store.run(record.id);
    if (!current) throw new Error(`The run of "${flow.name}" disappeared.`);
    if (current.status !== 'completed')
      throw new Error(
        `"${flow.name}" ${current.status}${current.error ? `: ${current.error}` : '.'}`,
      );
    return {
      runId: current.id,
      flowName: flow.name,
      text: current.result?.text ?? '',
      sources: current.result?.sources ?? [],
    };
  }

  // Triggers ---------------------------------------------------------------

  /** Rebuilds the schedule and webhook triggers of a flow from its published version. */
  syncTriggers(flowId: string) {
    const flows = this.platform.workspace.flows;
    const flow = flows.get(flowId);
    const version = flow?.publishedVersionId
      ? flows.version(flowId, flow.publishedVersionId)
      : undefined;
    if (!flow || !version) {
      this.store.replaceTriggers(flowId, []);
      return [];
    }
    const now = Date.now();
    const rows: Omit<TriggerRow, 'id'>[] = [];
    for (const node of version.graph.nodes) {
      if (node.type !== 'start') continue;
      const config = mergedConfig(node);
      const kind = config.trigger;
      if (kind !== 'schedule' && kind !== 'webhook') continue;
      rows.push({
        flowId,
        nodeId: node.id,
        kind,
        config,
        active: config.active !== false,
        nextRunAt: kind === 'schedule' ? nextScheduleAt(config, now) : null,
      });
    }
    if (rows.some((row) => row.kind === 'webhook'))
      this.store.ensureWebhookToken(flowId);
    this.store.replaceTriggers(flowId, rows);
    return rows;
  }
  /** Starts a run of the published version from a trigger; undefined when it cannot run. */
  fire(flowId: string, nodeId: string, trigger: Omit<RunTrigger, 'nodeId'>) {
    // Every trigger — schedule, webhook, Slack mention, page write — comes
    // through here, so this is where a paused workspace stops them. A manual
    // run (POST /flows/:id/runs) is an explicit act and goes around it.
    if (this.platform.store.settings().paused) return undefined;
    const flows = this.platform.workspace.flows;
    const flow = flows.get(flowId);
    const version = flow?.publishedVersionId
      ? flows.version(flowId, flow.publishedVersionId)
      : undefined;
    if (!flow || !version) return undefined;
    const start = version.graph.nodes.find(
      (node) => node.id === nodeId && node.type === 'start',
    );
    if (!start) return undefined;
    const record = this.create(flow, version.graph, version.id, {
      ...trigger,
      nodeId,
    });
    this.start(record.id);
    return record;
  }
  /** Begins the 30 s scheduler tick for schedule triggers. */
  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS);
    void this.tick();
  }
  /**
   * Carries on every parked Wait that is due. Runs left waiting by a restart
   * are rehydrated from their rows here, which is why a Wait survives one.
   */
  async wakeDue(now = Date.now()) {
    let due: { runId: string; nodeId: string }[];
    try {
      due = this.store.dueWaits(now);
    } catch {
      console.error(
        'Flow waits could not be read; will retry on the next tick.',
      );
      return;
    }
    for (const row of due)
      try {
        const execution = this.execution(row.runId);
        if (!execution) {
          this.store.clearWait(row.runId, row.nodeId);
          continue;
        }
        await execution.wake(row.nodeId);
      } catch (error) {
        console.error(
          `Flow scheduler could not resume run ${row.runId} (${row.nodeId}): ${message(error)}`,
        );
      }
  }
  async tick() {
    const now = Date.now();
    await this.wakeDue(now);
    let due: TriggerRow[];
    try {
      due = this.store.claimDue(now, (row) => nextScheduleAt(row.config, now));
    } catch {
      // Never let a store error become an unhandled interval rejection.
      console.error('Flow scheduler tick failed; will retry on the next tick.');
      return;
    }
    // Each due trigger fires on its own: one that cannot start never holds
    // the others back until their next slot.
    for (const row of due)
      try {
        this.fire(row.flowId, row.nodeId, {
          source: 'schedule',
          input: String(row.config.sampleInput ?? ''),
        });
      } catch (error) {
        console.error(
          `Flow scheduler could not start flow ${row.flowId} (${row.nodeId}): ${message(error)}`,
        );
      }
  }
  /**
   * Stops the scheduler and interrupts every run with a step in flight. A
   * run that is only waiting on a person keeps its status and its pending
   * reviews: it is rehydrated from the tables when the decision arrives.
   */
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const execution of [...this.active.values()])
      if (execution.busy)
        execution.halt(new RunStop('interrupted', STOPPED_MESSAGE));
      else this.release(execution.id);
  }
}
