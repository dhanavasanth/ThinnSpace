/**
 * One executor per catalog node type. Executors are pure functions of a
 * StepContext: they never touch the run tables directly and report either an
 * output (keyed by port) or a request to wait for a person. The FlowRunner
 * owns scheduling, persistence, retries, and approvals.
 */
import type { Platform } from './platform.js';
import { parallelSources } from './parallel.js';
import { requestedUrls } from './research.js';
import { PageError, type Page } from './pages.js';
import {
  NODE_SPECS,
  listValues,
  nodeOutputs,
  type FlowNode,
  type PortKind,
} from '../shared/flows.js';
import type {
  ApprovalAction,
  FlowApproval,
  RunResult,
  RunTrigger,
  StepOutput,
} from '../shared/flow-runs.js';

export const SETUP_REQUIRED_MESSAGE =
  'Setup required: connect Intelligence and a model in Settings to run Dot steps.';
export const SLACK_UNAVAILABLE_MESSAGE = 'Slack delivery is not available yet.';
/** Context payloads longer than this are cut before reaching a Dot. */
export const CONTEXT_CHAR_LIMIT = 8000;

/** A value that arrived on an input port, with the label of the node it came from. */
export interface PortValue {
  kind: PortKind;
  value: unknown;
  from: string;
}
export type ThreadMode = 'fresh' | 'continue' | 'keyed';
export interface StepContext {
  runId: string;
  flowId: string;
  flowName: string;
  node: FlowNode;
  label: string;
  /** Node configuration with catalog defaults filled in. */
  config: Record<string, unknown>;
  trigger: RunTrigger;
  /** Live values per input port, in connection order. */
  inputs: Record<string, PortValue[]>;
  /** Set while a per-item step handles one list element. */
  item?: { index: number; value: unknown };
  signal: AbortSignal;
  /** Substitutes {{slug.port}} chips with upstream values. */
  render(text: string): string;
  log(text: string): void;
  /** Writes a message to the run log (the only in-app destination so far). */
  message(text: string): void;
  /** Records a Finish node's part of the run result. */
  setResult(label: string, part: Omit<RunResult, 'parts'>): void;
  /** A conversation for a Dot step, honouring its conversation mode. */
  thread(
    dotId: string,
    title: string,
    mode: ThreadMode,
    key?: string,
  ): Promise<string>;
  /** One Dot turn, counted against the run's Dot-turn limit. */
  turn(threadId: string, prompt: string): Promise<string>;
  platform: Platform;
}
export interface PendingApproval {
  kind: FlowApproval['kind'];
  title: string;
  payload: FlowApproval['payload'];
}
export type StepOutcome =
  | {
      kind: 'output';
      output: StepOutput;
      /** What the step worked from, for the run log. */
      input?: unknown;
      threadId?: string;
    }
  | { kind: 'wait'; approval: PendingApproval; input?: unknown };
export interface Decision {
  action: ApprovalAction;
  feedback: string | null;
  editedText: string | null;
}
export interface Executor {
  run(ctx: StepContext): Promise<StepOutcome>;
  /** Turns a decided approval into the step's output. */
  resume?(
    ctx: StepContext,
    approval: FlowApproval,
    decision: Decision,
  ): Promise<StepOutput>;
}

// Value rendering ---------------------------------------------------------

function isTrigger(value: unknown): value is RunTrigger {
  return (
    !!value &&
    typeof value === 'object' &&
    'source' in value &&
    'nodeId' in value &&
    'input' in value
  );
}
/** Renders any payload as readable text: never a raw JSON dump. */
export function toText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value))
    return value
      .map((item) =>
        item && typeof item === 'object'
          ? `- ${toText(item).replace(/\n/g, '\n  ')}`
          : `- ${toText(item)}`,
      )
      .join('\n');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isTrigger(record)) return record.input;
    if (typeof record.title === 'string' && typeof record.url === 'string')
      return `${record.title} (${record.url})`;
    return Object.entries(record)
      .map(
        ([key, item]) =>
          `${key}: ${item && typeof item === 'object' ? JSON.stringify(item) : toText(item)}`,
      )
      .join('\n');
  }
  return String(value);
}
export function portText(port: PortValue | undefined): string {
  if (!port) return '';
  return port.kind === 'trigger' && isTrigger(port.value)
    ? port.value.input
    : toText(port.value);
}
function inputText(ctx: StepContext, port: string, separator = '\n\n') {
  return (ctx.inputs[port] ?? []).map(portText).filter(Boolean).join(separator);
}
function truncate(text: string) {
  return text.length > CONTEXT_CHAR_LIMIT
    ? `${text.slice(0, CONTEXT_CHAR_LIMIT)}\n[Truncated: ${text.length - CONTEXT_CHAR_LIMIT} more characters were left out.]`
    : text;
}
/** A context payload as a labelled section of a Dot brief. */
export function contextSection(port: PortValue): string {
  let body: string;
  if (port.kind === 'trigger' && isTrigger(port.value)) {
    const fields = port.value.fields ?? {};
    body = [
      port.value.input,
      ...Object.entries(fields).map(
        ([key, value]) => `${key}: ${toText(value)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');
  } else if (typeof port.value === 'string') body = truncate(port.value);
  else if (Array.isArray(port.value))
    body = `A list of ${port.value.length} items:\n${truncate(JSON.stringify(port.value, null, 2))}`;
  else if (port.value && typeof port.value === 'object')
    body = truncate(JSON.stringify(port.value, null, 2));
  else body = toText(port.value);
  return `From ${port.from}:\n${body || '(empty)'}`;
}
function firstLine(text: string) {
  return (
    text
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  ).slice(0, 160);
}
/** Reads a model answer as JSON, tolerating code fences and surrounding prose. */
export function parseJsonAnswer(
  text: string,
):
  { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const candidates = [fenced.trim()];
  const start = fenced.search(/[[{]/);
  const end = Math.max(fenced.lastIndexOf('}'), fenced.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(fenced.slice(start, end + 1));
  let error = 'empty answer';
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate) };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'invalid JSON';
    }
  }
  return { error };
}
function pageRef(page: Page) {
  return {
    id: page.id,
    title: page.title,
    revision: page.revision,
    spaceId: page.spaceId,
    url: `#/spaces/${page.spaceId}/pages/${page.id}`,
  };
}
function refId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'id' in value)
    return typeof value.id === 'string' ? value.id : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// Dots --------------------------------------------------------------------

function requireDot(ctx: StepContext, key = 'dot') {
  try {
    ctx.platform.requireReady();
  } catch {
    throw new Error(SETUP_REQUIRED_MESSAGE);
  }
  const dotId = String(ctx.config[key] ?? '');
  const dot = ctx.platform.workspace.dot(dotId);
  if (!dot) throw new Error('The chosen Dot no longer exists.');
  return dot;
}
/** The full brief a Dot task sends: task, expectations, context sections, format. */
export function dotBrief(ctx: StepContext): string {
  const parts = [ctx.render(String(ctx.config.task ?? '')).trim()];
  const expected = ctx.render(String(ctx.config.expectedOutput ?? '')).trim();
  if (expected) parts.push(`A good result looks like:\n${expected}`);
  if (ctx.item)
    parts.push(
      `This step runs once per item. You are handling item ${ctx.item.index + 1}.`,
    );
  for (const port of ctx.inputs.context ?? []) parts.push(contextSection(port));
  if (ctx.config.outputFormat === 'json') {
    const shape = String(ctx.config.outputSchema ?? '').trim();
    parts.push(
      `Answer with JSON only: no prose, no code fences.${shape ? ` Use this shape:\n${shape}` : ''}`,
    );
  }
  return parts.join('\n\n');
}
const dotTask: Executor = {
  async run(ctx) {
    const dot = requireDot(ctx);
    const mode = (ctx.config.thread as ThreadMode | undefined) ?? 'fresh';
    const key =
      mode === 'keyed'
        ? ctx.render(String(ctx.config.threadKey ?? '')).trim()
        : undefined;
    const threadId = await ctx.thread(
      dot.id,
      `Flow: ${ctx.flowName} / ${ctx.label}`,
      mode,
      key,
    );
    const brief = dotBrief(ctx);
    let text = await ctx.turn(threadId, brief);
    const output: StepOutput = {
      result: { kind: 'text', value: text },
      pages: { kind: 'json', value: [] },
    };
    if (ctx.config.outputFormat === 'json') {
      let parsed = parseJsonAnswer(text);
      if (parsed.error) {
        ctx.log(
          `${ctx.label}: the answer was not JSON (${parsed.error}); asking once more.`,
        );
        text = await ctx.turn(
          threadId,
          `Your answer could not be read as JSON (${parsed.error}). Answer again with JSON only: no prose, no code fences.`,
        );
        parsed = parseJsonAnswer(text);
        if (parsed.error)
          throw new Error(`The Dot did not return valid JSON: ${parsed.error}`);
      }
      output.result = { kind: 'text', value: text };
      output.data = { kind: 'json', value: parsed.value };
    }
    return { kind: 'output', output, input: brief, threadId };
  },
};

export const OTHERWISE = 'Otherwise';
/** Matches a Dot's answer to one of the named branches (case-insensitive). */
export function pickBranch(
  answer: string,
  branches: string[],
  otherwise: boolean,
): string | null {
  const normalise = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const options = otherwise ? [...branches, OTHERWISE] : branches;
  const first = normalise(answer.split('\n').find((line) => line.trim()) ?? '');
  const exact = options.find((option) => normalise(option) === first);
  if (exact) return exact;
  const whole = normalise(answer);
  const contained = [...options]
    .sort((a, b) => b.length - a.length)
    .find((option) => {
      const needle = normalise(option);
      return needle && ` ${whole} `.includes(` ${needle} `);
    });
  if (contained) return contained;
  return otherwise ? OTHERWISE : null;
}
const dotDecide: Executor = {
  async run(ctx) {
    const dot = requireDot(ctx);
    const branches = listValues(ctx.config.branches);
    const otherwise = ctx.config.otherwise !== false;
    const input = ctx.inputs.input?.[0];
    const options = otherwise ? [...branches, OTHERWISE] : branches;
    const prompt = [
      ctx.render(String(ctx.config.question ?? '')).trim(),
      input ? contextSection(input) : 'Input:\n(none)',
      `Answer with exactly one of: ${options.join(', ')}. Reply with the option name only.`,
    ].join('\n\n');
    const threadId = await ctx.thread(
      dot.id,
      `Flow: ${ctx.flowName} / ${ctx.label}`,
      'fresh',
    );
    const answer = await ctx.turn(threadId, prompt);
    const picked = pickBranch(answer, branches, otherwise);
    if (!picked)
      throw new Error(
        `The Dot answered "${answer.trim().slice(0, 80)}", which is not one of the branches.`,
      );
    ctx.log(`${ctx.label}: chose ${picked}.`);
    const pass = input ?? { kind: 'text' as const, value: '' };
    return {
      kind: 'output',
      output: {
        [picked === OTHERWISE ? 'otherwise' : `branch:${picked}`]: {
          kind: pass.kind,
          value: pass.value,
        },
      },
      input: prompt,
      threadId,
    };
  },
};

// Pages -------------------------------------------------------------------

const readPage: Executor = {
  async run(ctx) {
    const pages = ctx.platform.workspace.pages;
    const spaceId = String(ctx.config.space ?? '');
    const mode = String(ctx.config.mode ?? 'page');
    if (mode === 'page') {
      const pageId =
        refId(ctx.config.page) ??
        (ctx.inputs.context ?? [])
          .map((port) => refId(port.value))
          .find(Boolean);
      if (!pageId) throw new Error('Choose a page to read.');
      const page = pages.get(spaceId, pageId);
      return {
        kind: 'output',
        output: {
          text: { kind: 'text', value: page.content },
          page: { kind: 'json', value: pageRef(page) },
        },
        input: { page: page.title },
      };
    }
    let list = pages.list(spaceId);
    if (mode === 'newest')
      list = [...list]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(1, Number(ctx.config.limit) || 5));
    const includeContent = ctx.config.includeContent !== false;
    const text = list.length
      ? list
          .map((page) =>
            includeContent
              ? `# ${page.title}\n\n${page.content}`
              : `- ${page.title}`,
          )
          .join('\n\n')
      : '(no pages yet)';
    return {
      kind: 'output',
      output: {
        text: { kind: 'text', value: text },
        page: { kind: 'json', value: list.map(pageRef) },
      },
      input: { pages: list.length },
    };
  },
};

interface SaveTarget {
  spaceId: string;
  mode: 'create' | 'update' | 'append';
  title: string;
  pageId?: string;
  parentId: string | null;
  onConflict: 'retry' | 'stop';
}
async function performSave(
  ctx: StepContext,
  target: SaveTarget,
  content: string,
) {
  const pages = ctx.platform.workspace.pages;
  if (target.mode === 'create')
    return pageRef(
      pages.create(target.spaceId, {
        title: target.title,
        content,
        parentId: target.parentId,
      }),
    );
  if (!target.pageId) throw new Error('Choose a page to update.');
  for (let attempt = 1; ; attempt++) {
    const page = pages.get(target.spaceId, target.pageId);
    try {
      return pageRef(
        pages.update(target.spaceId, page.id, {
          content:
            target.mode === 'append'
              ? `${page.content.trimEnd()}\n\n${content}`.trim()
              : content,
          expectedRevision: page.revision,
        }),
      );
    } catch (error) {
      const conflict = error instanceof PageError && error.status === 409;
      if (!conflict || target.onConflict === 'stop' || attempt >= 3)
        throw error;
      ctx.log(
        `${ctx.label}: the page changed meanwhile; re-reading and retrying.`,
      );
    }
  }
}
function saveTarget(ctx: StepContext): SaveTarget {
  const mode = String(ctx.config.mode ?? 'create') as SaveTarget['mode'];
  const content = inputText(ctx, 'content');
  const title =
    inputText(ctx, 'title', ' ').trim() ||
    ctx.render(String(ctx.config.title ?? '')).trim() ||
    firstLine(content) ||
    'Untitled';
  return {
    spaceId: String(ctx.config.space ?? ''),
    mode: ['create', 'update', 'append'].includes(mode) ? mode : 'create',
    title,
    pageId:
      mode === 'create'
        ? undefined
        : (refId(ctx.inputs.page?.[0]?.value) ?? refId(ctx.config.page)),
    parentId: refId(ctx.config.parentPage) ?? null,
    onConflict: ctx.config.onConflict === 'stop' ? 'stop' : 'retry',
  };
}
const savePage: Executor = {
  async run(ctx) {
    const target = saveTarget(ctx);
    const content = inputText(ctx, 'content');
    const space = ctx.platform.workspace
      .spaces()
      .find((item) => item.id === target.spaceId);
    if (!space) throw new Error('The chosen Space no longer exists.');
    if (target.mode !== 'create' && !target.pageId)
      throw new Error('Choose a page to update.');
    if (ctx.config.review !== false) {
      const existing =
        target.mode === 'create'
          ? undefined
          : ctx.platform.workspace.pages.get(target.spaceId, target.pageId!);
      const verb =
        target.mode === 'create'
          ? 'create'
          : target.mode === 'append'
            ? 'append to'
            : 'replace';
      return {
        kind: 'wait',
        approval: {
          kind: 'page',
          title: `${ctx.label}: ${existing ? `${verb} "${existing.title}"` : `save "${target.title}"`}`,
          payload: {
            message: `Approve to ${verb} this page in ${space.name}.`,
            draft: content,
            allowEdits: true,
            actions: ['approve', 'decline'],
            requireFeedback: false,
            spaceId: target.spaceId,
            pageTitle: target.title,
            pageId: target.pageId,
            mode: target.mode,
          },
        },
        input: { title: target.title, mode: target.mode },
      };
    }
    const saved = await performSave(ctx, target, content);
    ctx.log(`${ctx.label}: saved "${saved.title}".`);
    return {
      kind: 'output',
      output: { saved: { kind: 'json', value: saved } },
      input: { title: target.title, mode: target.mode },
    };
  },
  async resume(ctx, approval, decision): Promise<StepOutput> {
    if (decision.action !== 'approve')
      return { declined: { kind: 'any', value: decision.feedback ?? '' } };
    const payload = approval.payload;
    const saved = await performSave(
      ctx,
      {
        spaceId: payload.spaceId ?? String(ctx.config.space ?? ''),
        mode: payload.mode ?? 'create',
        title: payload.pageTitle ?? 'Untitled',
        pageId: payload.pageId,
        parentId: refId(ctx.config.parentPage) ?? null,
        onConflict: ctx.config.onConflict === 'stop' ? 'stop' : 'retry',
      },
      decision.editedText ?? payload.draft,
    );
    ctx.log(`${ctx.label}: saved "${saved.title}".`);
    return { saved: { kind: 'json', value: saved } };
  },
};

// Actions -----------------------------------------------------------------

const webResearch: Executor = {
  async run(ctx) {
    const provider = ctx.platform.config.webSearchProvider ?? 'parallel';
    if (provider !== 'parallel')
      throw new Error(
        provider === 'disabled'
          ? 'Web research is disabled on this server (WEB_SEARCH_PROVIDER=disabled).'
          : 'Web research needs the Parallel provider. Set WEB_SEARCH_PROVIDER=parallel and PARALLEL_API_KEY.',
      );
    const query = ctx.render(String(ctx.config.query ?? '')).trim();
    if (!query) throw new Error('Write a research question.');
    const context = inputText(ctx, 'context').slice(0, 2000);
    const urls = ctx.config.mode === 'read' ? requestedUrls(query) : undefined;
    if (urls && !urls.length)
      throw new Error('Add at least one URL to the research question.');
    const found = await parallelSources(
      {
        objective: context ? `${query}\n\nContext:\n${context}` : query,
        urls,
        onWarning: (message) => ctx.log(`${ctx.label}: ${message}`),
      },
      ctx.platform.config,
      ctx.signal,
    );
    const sources = found.slice(
      0,
      Math.max(1, Number(ctx.config.maxSources) || 5),
    );
    return {
      kind: 'output',
      output: {
        findings: {
          kind: 'text',
          value: sources
            .map(
              (source) =>
                `### ${source.title}\n${source.url}\n\n${source.text}`,
            )
            .join('\n\n'),
        },
        sources: {
          kind: 'json',
          value: sources.map(({ title, url }) => ({ title, url })),
        },
      },
      input: query,
    };
  },
};

function renderDeep(ctx: StepContext, value: unknown): unknown {
  if (typeof value === 'string') return ctx.render(value);
  if (Array.isArray(value)) return value.map((item) => renderDeep(ctx, item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderDeep(ctx, item)]),
    );
  return value;
}
/** Tool arguments from the node's JSON, with chips substituted first. */
export function toolArguments(ctx: StepContext): Record<string, unknown> {
  const raw = ctx.config.arguments;
  let value: unknown;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      value = JSON.parse(ctx.render(raw));
    } catch {
      throw new Error('Arguments must be a JSON object.');
    }
  } else value = renderDeep(ctx, raw ?? {});
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Arguments must be a JSON object.');
  return value as Record<string, unknown>;
}
function resolveTool(ctx: StepContext) {
  const dotId = String(ctx.config.dot ?? '');
  if (!ctx.platform.workspace.dot(dotId))
    throw new Error('The chosen Dot no longer exists.');
  const name = String(ctx.config.tool ?? '');
  const exposed = ctx.platform.connections
    .tools(dotId)
    .find((item) => item.name === name || item.tool.name === name);
  if (!exposed)
    throw new Error(`The tool "${name}" is not available to this Dot.`);
  return exposed;
}
async function callTool(
  ctx: StepContext,
  exposed: ReturnType<typeof resolveTool>,
  args: Record<string, unknown>,
): Promise<StepOutput> {
  const result = await ctx.platform.connections.call(exposed, args, ctx.signal);
  if (result.isError) throw new Error(result.text);
  const parsed = parseJsonAnswer(result.text);
  return {
    result: {
      kind: 'json',
      value: parsed.error ? { text: result.text } : parsed.value,
    },
    text: { kind: 'text', value: result.text },
  };
}
const mcpTool: Executor = {
  async run(ctx) {
    const exposed = resolveTool(ctx);
    const args = toolArguments(ctx);
    const approval = String(ctx.config.approval ?? 'inherit');
    const ask =
      approval === 'always' ||
      (approval === 'inherit' && exposed.tool.requiresApproval);
    if (ask)
      return {
        kind: 'wait',
        approval: {
          kind: 'review',
          title: `Run ${exposed.tool.title}?`,
          payload: {
            message: `${ctx.label} wants to run ${exposed.tool.title} on ${exposed.connection.name} with these arguments.`,
            draft: JSON.stringify(args, null, 2),
            allowEdits: false,
            actions: ['approve', 'decline'],
            requireFeedback: false,
          },
        },
        input: args,
      };
    return {
      kind: 'output',
      output: await callTool(ctx, exposed, args),
      input: args,
    };
  },
  async resume(ctx, approval, decision) {
    if (decision.action !== 'approve')
      throw new Error(
        `Declined by the reviewer${decision.feedback ? `: ${decision.feedback}` : '.'}`,
      );
    const exposed = resolveTool(ctx);
    const parsed = parseJsonAnswer(approval.payload.draft);
    const args =
      parsed.value &&
      typeof parsed.value === 'object' &&
      !Array.isArray(parsed.value)
        ? (parsed.value as Record<string, unknown>)
        : {};
    return callTool(ctx, exposed, args);
  },
};

const sendMessage: Executor = {
  async run(ctx) {
    if (ctx.config.destination !== 'inbox')
      throw new Error(SLACK_UNAVAILABLE_MESSAGE);
    const text =
      ctx.render(String(ctx.config.message ?? '')).trim() ||
      inputText(ctx, 'content');
    if (!text) throw new Error('There is nothing to send.');
    ctx.message(text);
    return {
      kind: 'output',
      output: {
        sent: { kind: 'json', value: { destination: 'inbox', at: Date.now() } },
      },
      input: text,
    };
  },
};

// Logic -------------------------------------------------------------------

/** The Branch node's deterministic test. Throws for an invalid pattern. */
export function evaluateBranch(
  subject: string,
  operator: string,
  expected: string,
  caseSensitive = false,
): boolean {
  const fold = (text: string) => (caseSensitive ? text : text.toLowerCase());
  switch (operator) {
    case 'contains':
      return fold(subject).includes(fold(expected));
    case 'equals':
      return fold(subject.trim()) === fold(expected.trim());
    case 'empty':
      return !subject.trim();
    case 'gt':
      return Number(subject) > Number(expected);
    case 'lt':
      return Number(subject) < Number(expected);
    case 'matches': {
      let pattern: RegExp;
      try {
        pattern = new RegExp(expected, caseSensitive ? '' : 'i');
      } catch {
        throw new Error(`"${expected}" is not a valid pattern.`);
      }
      return pattern.test(subject);
    }
    default:
      throw new Error(`Unknown condition "${operator}".`);
  }
}
const branch: Executor = {
  async run(ctx) {
    const subject = ctx.render(String(ctx.config.field ?? ''));
    const expected = ctx.render(String(ctx.config.value ?? ''));
    const operator = String(ctx.config.operator ?? 'contains');
    const taken = evaluateBranch(
      subject,
      operator,
      expected,
      !!ctx.config.caseSensitive,
    );
    ctx.log(
      `${ctx.label}: "${subject.slice(0, 60)}" ${operator} "${expected.slice(0, 60)}" is ${taken ? 'yes' : 'no'}.`,
    );
    const pass = ctx.inputs.input?.[0] ?? {
      kind: 'text' as const,
      value: subject,
    };
    return {
      kind: 'output',
      output: {
        [taken ? 'yes' : 'no']: { kind: pass.kind, value: pass.value },
      },
      input: { subject, operator, expected },
    };
  },
};
const combine: Executor = {
  async run(ctx) {
    const template = String(ctx.config.template ?? '');
    const separator = String(ctx.config.separator ?? '\n\n');
    const text = template.trim()
      ? ctx.render(template)
      : inputText(ctx, 'values', separator);
    return { kind: 'output', output: { text: { kind: 'text', value: text } } };
  },
};

// People ------------------------------------------------------------------

const humanReview: Executor = {
  async run(ctx) {
    // The buttons offered are exactly the arms drawn on the card, so a
    // decision can never leave on a port nobody wired.
    const ports = nodeOutputs(ctx.node);
    const actions: ApprovalAction[] = ports.some(
      (port) => port.id === 'changes',
    )
      ? ['approve', 'changes', 'decline']
      : ['approve', 'decline'];
    if (ctx.config.notify === 'slack' || ctx.config.notify === 'both')
      ctx.log(
        `${ctx.label}: Slack notification skipped; it is not available yet.`,
      );
    return {
      kind: 'wait',
      approval: {
        kind: 'review',
        title: ctx.label,
        payload: {
          message: ctx.render(String(ctx.config.message ?? '')).trim(),
          draft: portText(ctx.inputs.draft?.[0]),
          allowEdits: ctx.config.allowEdits !== false,
          actions,
          requireFeedback: ctx.config.requireFeedback !== false,
        },
      },
    };
  },
  async resume(ctx, approval, decision): Promise<StepOutput> {
    if (decision.action === 'changes')
      return { changes: { kind: 'text', value: decision.feedback ?? '' } };
    if (decision.action === 'decline')
      return { declined: { kind: 'any', value: decision.feedback ?? '' } };
    const text =
      approval.payload.allowEdits && decision.editedText != null
        ? decision.editedText
        : approval.payload.draft;
    if (ctx.config.saveApproved) {
      const spaceId = String(ctx.config.space ?? '');
      const title =
        ctx.render(String(ctx.config.pageTitle ?? '')).trim() ||
        firstLine(text) ||
        'Untitled';
      const page = ctx.platform.workspace.pages.create(spaceId, {
        title,
        content: text,
        parentId: null,
      });
      ctx.log(`${ctx.label}: saved the approved draft as "${page.title}".`);
    }
    return { approved: { kind: 'text', value: text } };
  },
};

// Start & finish ----------------------------------------------------------

const start: Executor = {
  async run(ctx) {
    return {
      kind: 'output',
      output: { started: { kind: 'trigger', value: ctx.trigger } },
      input: ctx.trigger.input,
    };
  },
};
const finish: Executor = {
  async run(ctx) {
    const text = inputText(ctx, 'value');
    const sources = (ctx.inputs.sources ?? [])
      .flatMap((port) =>
        Array.isArray(port.value) ? port.value : [port.value],
      )
      .flatMap((item) =>
        item &&
        typeof item === 'object' &&
        'url' in item &&
        typeof item.url === 'string'
          ? [
              {
                title:
                  'title' in item && typeof item.title === 'string'
                    ? item.title
                    : item.url,
                url: item.url,
              },
            ]
          : [],
      );
    ctx.setResult(String(ctx.config.label ?? '').trim() || 'Result', {
      text,
      sources,
    });
    return { kind: 'output', output: {}, input: text };
  },
};
const unavailable: Executor = {
  async run(ctx) {
    throw new Error(
      `${NODE_SPECS[ctx.node.type]?.label ?? ctx.node.type} is not available yet.`,
    );
  },
};

export const EXECUTORS: Record<string, Executor> = {
  start,
  finish,
  'dot-task': dotTask,
  'dot-decide': dotDecide,
  'read-page': readPage,
  'save-page': savePage,
  'web-research': webResearch,
  'mcp-tool': mcpTool,
  'send-message': sendMessage,
  branch,
  combine,
  'human-review': humanReview,
};
/** The executor for a node type; unknown and coming-soon types fail clearly. */
export function executorFor(type: string): Executor {
  return EXECUTORS[type] ?? unavailable;
}
