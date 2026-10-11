/**
 * Slack and page Start triggers.
 *
 * Schedule and webhook Starts are registered rows (FlowRunner.syncTriggers)
 * because something has to poll or receive them. Slack mentions and page
 * writes already arrive as events, so these two are resolved live: every
 * event reads the currently published versions and asks the pure matchers
 * below which Starts want it. Nothing is registered, so publishing,
 * unpublishing and editing need no extra bookkeeping.
 *
 * The matchers are pure and take plain data; FlowTriggerBridge holds the
 * wiring (paused check, acknowledgement, self-trigger guards) and is the only
 * part that touches the runner or the stores.
 */
import {
  configWithDefaults,
  type FlowGraph,
  type FlowNode,
} from '../shared/flows.js';
import type { RunTrigger } from '../shared/flow-runs.js';

/** A page write worth telling flows about. */
export type PageEventKind = 'created' | 'updated';
export interface PageWrite {
  spaceId: string;
  pageId: string;
  title: string;
  event: PageEventKind;
  /** The flow run whose step made this write, when a step made it. */
  runId?: string;
}

/** One flow's published graph: the only version a trigger may ever start. */
export interface PublishedFlow {
  flowId: string;
  graph: FlowGraph;
}

/** The parts of an inbound Slack mention a Slack Start filters on. */
export interface SlackMessageEvent {
  /** Channel name or id, when the provider event carried one. */
  channel?: string;
  text: string;
}

/** A Start node that wants this event, with its defaults filled in. */
export interface StartMatch {
  flowId: string;
  nodeId: string;
  config: Record<string, unknown>;
  /** Slack matches only: the flow has a Finish that replies in the thread. */
  repliesInSlack?: boolean;
}

/**
 * A flow never retriggers itself from a page event twice inside this window.
 * The first guard (a flow with a run in flight) catches the Save page loop;
 * this one is the belt-and-braces bound on any path that slips past it.
 */
export const PAGE_TRIGGER_WINDOW_MS = 10_000;

/** Posted before the flow starts when a Slack Start asks to acknowledge. */
export const SLACK_ACKNOWLEDGEMENT = 'On it.';

/**
 * Channel names are compared loosely: the Start panel asks for "#support"
 * while a provider event may carry "support" or a channel id. Both sides are
 * trimmed, lowercased and stripped of a leading '#'.
 */
export function normalizeChannel(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
}

function startNodes(graph: FlowGraph, trigger: string) {
  return graph.nodes.filter(
    (node): node is FlowNode =>
      node.type === 'start' &&
      configWithDefaults('start', node.config).trigger === trigger,
  );
}

function text(config: Record<string, unknown>, key: string) {
  return String(config[key] ?? '').trim();
}

/** True when a step of this graph posts back into the triggering thread. */
export function repliesInSlack(graph: FlowGraph) {
  return graph.nodes.some((node) =>
    node.type === 'finish'
      ? !!configWithDefaults('finish', node.config).replyToTrigger
      : node.type === 'send-message' &&
        configWithDefaults('send-message', node.config).destination ===
          'thread',
  );
}

/**
 * The published flows whose Slack Start wants this mention. A Start matches
 * when it is active, its channel filter is empty or equals the event's
 * channel, and its keyword is empty or appears in the message. A Start that
 * filters on a channel never matches an event that carried no channel: the
 * filter cannot be honoured, so the flow stays out of it.
 */
export function matchingSlackStarts(
  flows: readonly PublishedFlow[],
  event: SlackMessageEvent,
): StartMatch[] {
  const channel = normalizeChannel(event.channel);
  const body = (event.text ?? '').toLowerCase();
  const matches: StartMatch[] = [];
  for (const flow of flows)
    for (const node of startNodes(flow.graph, 'slack')) {
      const config = configWithDefaults('start', node.config);
      if (config.active === false) continue;
      const wanted = normalizeChannel(config.slackChannel);
      if (wanted && wanted !== channel) continue;
      const keyword = text(config, 'slackKeyword').toLowerCase();
      if (keyword && !body.includes(keyword)) continue;
      matches.push({
        flowId: flow.flowId,
        nodeId: node.id,
        config,
        repliesInSlack: repliesInSlack(flow.graph),
      });
    }
  return matches;
}

/**
 * The published flows whose page Start watches this Space. 'created' fires
 * only on a create; 'updated' means created or updated.
 */
export function matchingPageStarts(
  flows: readonly PublishedFlow[],
  write: PageWrite,
): StartMatch[] {
  const matches: StartMatch[] = [];
  for (const flow of flows)
    for (const node of startNodes(flow.graph, 'page')) {
      const config = configWithDefaults('start', node.config);
      if (config.active === false) continue;
      if (text(config, 'watchSpace') !== write.spaceId) continue;
      const event = text(config, 'pageEvent') || 'created';
      if (event === 'created' && write.event !== 'created') continue;
      matches.push({ flowId: flow.flowId, nodeId: node.id, config });
    }
  return matches;
}

/**
 * The channel and thread an inbound Slack event belongs to.
 *
 * Neither reaches this codebase through `IncomingMessage`: the Channels core
 * builds a turn's message with `ref: turn.messageRef ?? { id: '' }` and the
 * Slack adapter sets `messageRef` only on interaction events, so `ref` is
 * literally `{ id: '' }` on a mention. The one place both facts do arrive is
 * the identity context, whose `conversation.id` is the adapter's
 * conversation key — `<channelId>::<scope>`, where a mention's scope is
 * `event.thread_ts ?? event.ts`, i.e. exactly the thread to reply in.
 */
export interface SlackEventFacts {
  channel?: string;
  threadTs?: string;
}
/** A Slack ts, as opposed to the `dm` scope sentinel. */
const TS_PATTERN = /^\d+\.\d+$/;
/** Splits an adapter conversation key into the facts a Slack Start needs. */
export function slackFactsOf(conversationId: unknown): SlackEventFacts {
  const key = String(conversationId ?? '').trim();
  if (!key) return {};
  const split = key.indexOf('::');
  const channel = split >= 0 ? key.slice(0, split) : key;
  const scope = split >= 0 ? key.slice(split + 2) : '';
  return {
    ...(channel ? { channel } : {}),
    ...(TS_PATTERN.test(scope) ? { threadTs: scope } : {}),
  };
}
/**
 * Carries `SlackEventFacts` from the identity callback, which sees them, to
 * the mention handler, which does not. Channels resolves the identity of an
 * ingress event immediately before dispatching it, so the hand-off is one
 * event long; entries are bounded and expire so a dropped handler cannot
 * grow the map.
 */
export class SlackEventFactStore {
  private readonly entries = new Map<
    string,
    { facts: SlackEventFacts; at: number }
  >();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly limit = 64,
    private readonly clock: () => number = () => Date.now(),
  ) {}
  remember(eventId: unknown, facts: SlackEventFacts) {
    const key = String(eventId ?? '').trim();
    if (!key || (!facts.channel && !facts.threadTs)) return;
    const now = this.clock();
    for (const [id, entry] of this.entries)
      if (now - entry.at > this.ttlMs) this.entries.delete(id);
    while (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { facts, at: now });
  }
  /** The facts for an event, removed from the map; empty when unknown. */
  take(eventId: unknown): SlackEventFacts {
    const key = String(eventId ?? '').trim();
    const entry = key ? this.entries.get(key) : undefined;
    if (entry) this.entries.delete(key);
    if (!entry || this.clock() - entry.at > this.ttlMs) return {};
    return entry.facts;
  }
}

function refValue(
  message: { ref?: Record<string, unknown> } | undefined,
  keys: string[],
): string | undefined {
  const ref = message?.ref;
  if (!ref) return undefined;
  for (const key of keys) {
    const value = ref[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * The channel an inbound Slack message came from, as far as the Channels
 * message reference exposes it. `ref` is an open record whose Slack shape
 * carries `channel`; `conversationKey` is "<channelId>::<scope>". Undefined
 * when the event carried nothing usable.
 */
export function slackChannelOf(message: {
  ref?: Record<string, unknown>;
}): string | undefined {
  const direct = refValue(message, ['channel', 'channelId', 'channel_id']);
  if (direct) return direct;
  const key = refValue(message, ['conversationKey']);
  return key ? key.split('::')[0] || undefined : undefined;
}

/**
 * The Slack thread timestamp of an inbound message, when it carries one.
 *
 * `ref.id` is deliberately not a fallback: it is the message's own ts, so in
 * an existing thread it names the reply rather than the thread, and anything
 * replying with it would open a new thread instead of the one that started
 * the flow. The real value comes from `SlackEventFactStore`.
 */
export function slackThreadOf(message: {
  ref?: Record<string, unknown>;
}): string | undefined {
  return refValue(message, ['threadTs', 'thread_ts']);
}

/** What `publishedFlows` needs from the FlowStore. */
export interface PublishedFlowSource {
  list(): { id: string }[];
  get(id: string): { publishedVersionId: string | null } | undefined;
  version(flowId: string, versionId: string): { graph: FlowGraph } | undefined;
}

/** Every flow with a published version, paired with that version's graph. */
export function publishedFlows(source: PublishedFlowSource): PublishedFlow[] {
  const flows: PublishedFlow[] = [];
  for (const { id } of source.list()) {
    const versionId = source.get(id)?.publishedVersionId;
    if (!versionId) continue;
    const version = source.version(id, versionId);
    if (version) flows.push({ flowId: id, graph: version.graph });
  }
  return flows;
}

/** The part of the bridge the Slack channel depends on. */
export interface SlackMentionBridge {
  slackMention(event: {
    channel?: string;
    text: string;
    user?: string;
    threadTs?: string;
    /** Posts the "On it" reply; failures are swallowed, never rethrown. */
    acknowledge?: (text: string) => Promise<void>;
    /** Posts into the same thread later, for a Finish that replies there. */
    reply?: (text: string) => Promise<void>;
  }): Promise<boolean>;
}

export interface FlowTriggerBridgeOptions {
  /** The published versions, read fresh for every event. */
  published: () => PublishedFlow[];
  /** Nothing fires while the workspace is paused. */
  paused: () => boolean;
  /** FlowRunner.fire; returns undefined when the flow cannot start. */
  fire: (
    flowId: string,
    nodeId: string,
    trigger: Omit<RunTrigger, 'nodeId'>,
  ) => { id: string } | undefined;
  /** Flow ids the engine is working on, for the page self-trigger guard. */
  busyFlows?: () => readonly string[];
  /**
   * The flows causally upstream of a run (FlowRunStore.triggerChain): Run
   * flow parents plus page-trigger hops. A flow already in that chain is
   * never fired again by a write that chain made.
   */
  triggerChain?: (runId: string) => readonly string[];
  /**
   * Hands a run the way back to the Slack thread that started it, so a
   * Finish with "Reply in the Slack thread" has something to post through.
   */
  attachReply?: (runId: string, reply: (text: string) => Promise<void>) => void;
  now?: () => number;
  report?: (message: string) => void;
}

/**
 * Turns Slack mentions and page writes into runs of published flows.
 *
 * Page writes need a loop guard, because a flow whose Save page step writes
 * into the Space its Start watches would otherwise start itself again. Two
 * guards, in order:
 *
 *  1. A flow with a run in flight never fires from a page event. The Pages
 *     listener runs synchronously inside `create`/`update`, so a write made
 *     by a run happens while that run is still 'running' (or 'waiting', for
 *     a review-gated save resumed by a decision) — the write is attributed to
 *     the run and dropped. This is the "compare against the run's own writes"
 *     option: a flow is never its own trigger while it is still working.
 *  2. Causality, not timing: a write made by a run carries that run's id, so
 *     `triggerChain` names every flow the write descends from — Run flow
 *     parents and earlier page-trigger hops alike — and none of them fires
 *     again. That is what bounds a ring of flows writing into each other's
 *     watched Spaces, which guard 1 cannot see because each flow is idle by
 *     the time the next write lands.
 *  3. Whatever gets past both, a flow fires from a page event at most once
 *     per PAGE_TRIGGER_WINDOW_MS, so an unattributed path (a write by hand,
 *     or by a Dot outside a run) is still rate-limited rather than free.
 */
export class FlowTriggerBridge implements SlackMentionBridge {
  private readonly lastPageFire = new Map<string, number>();
  constructor(private readonly options: FlowTriggerBridgeOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private report(message: string) {
    (this.options.report ?? ((line: string) => console.error(line)))(message);
  }
  private start(match: StartMatch, trigger: Omit<RunTrigger, 'nodeId'>) {
    try {
      return this.options.fire(match.flowId, match.nodeId, trigger);
    } catch (error) {
      this.report(
        `Flow trigger could not start flow ${match.flowId} (${match.nodeId}): ${
          error instanceof Error ? error.name : 'Error'
        }`,
      );
      return undefined;
    }
  }

  /**
   * Handles a Slack mention before the Dot answers it. Returns true when at
   * least one published flow took the mention, in which case the caller skips
   * the default Dot reply: the flow owns the conversation.
   */
  async slackMention(event: {
    channel?: string;
    text: string;
    user?: string;
    threadTs?: string;
    acknowledge?: (text: string) => Promise<void>;
    reply?: (text: string) => Promise<void>;
  }): Promise<boolean> {
    if (this.options.paused()) return false;
    const matches = matchingSlackStarts(this.options.published(), {
      channel: event.channel,
      text: event.text,
    });
    if (!matches.length) return false;
    const fields: Record<string, unknown> = {};
    if (event.channel) fields.channel = event.channel;
    if (event.user) fields.user = event.user;
    if (event.threadTs) fields.threadTs = event.threadTs;
    const fired: StartMatch[] = [];
    for (const match of matches) {
      const run = this.start(match, {
        source: 'slack',
        input: event.text,
        fields,
      });
      if (!run) continue;
      fired.push(match);
      // The Finish of a flow that replies in Slack posts through this.
      if (match.repliesInSlack && event.reply)
        this.options.attachReply?.(run.id, event.reply);
    }
    if (!fired.length) return false;
    if (
      event.acknowledge &&
      fired.some((match) => match.config.slackAcknowledge !== false)
    )
      try {
        await event.acknowledge(SLACK_ACKNOWLEDGEMENT);
      } catch {
        // The flow is already running; a missing "On it" must not hand the
        // mention back to the Dot and answer it twice.
        this.report('Flow trigger could not post the Slack acknowledgement.');
      }
    // Claiming the mention silences the Dot, so it is only claimed by a flow
    // that will actually answer in the thread. A flow that only files the
    // mention away still runs, and the Dot still replies, because one
    // mention with no answer at all reads as the bot being broken.
    return fired.some((match) => match.repliesInSlack && !!event.reply);
  }

  /** Handles a page write from the Pages store. Never throws. */
  pageWritten(write: PageWrite): void {
    if (this.options.paused()) return;
    let matches: StartMatch[];
    try {
      matches = matchingPageStarts(this.options.published(), write);
    } catch (error) {
      this.report(
        `Flow page trigger could not read the published flows: ${
          error instanceof Error ? error.name : 'Error'
        }`,
      );
      return;
    }
    if (!matches.length) return;
    const busy = new Set(this.options.busyFlows?.() ?? []);
    // Every flow this write descends from, so a ring of page-saving flows
    // cannot keep triggering each other: a flow already in the chain that
    // produced the write is never started by it.
    let upstream: Set<string>;
    try {
      upstream = new Set(
        write.runId ? (this.options.triggerChain?.(write.runId) ?? []) : [],
      );
    } catch (error) {
      this.report(
        `Flow page trigger could not read the run chain: ${
          error instanceof Error ? error.name : 'Error'
        }`,
      );
      return;
    }
    const now = this.now();
    for (const match of matches) {
      if (busy.has(match.flowId) || upstream.has(match.flowId)) continue;
      const last = this.lastPageFire.get(match.flowId);
      if (last !== undefined && now - last < PAGE_TRIGGER_WINDOW_MS) continue;
      this.lastPageFire.set(match.flowId, now);
      if (
        !this.start(match, {
          source: 'page',
          input: write.title,
          fields: {
            spaceId: write.spaceId,
            pageId: write.pageId,
            title: write.title,
            // Attributes the new run to the write that started it, so
            // `triggerChain` can walk the hop on the next write.
            ...(write.runId ? { runId: write.runId } : {}),
          },
        })
      )
        this.lastPageFire.delete(match.flowId);
    }
  }
}
