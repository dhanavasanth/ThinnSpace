import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  FlowTriggerBridge,
  PAGE_TRIGGER_WINDOW_MS,
  SLACK_ACKNOWLEDGEMENT,
  SlackEventFactStore,
  matchingPageStarts,
  matchingSlackStarts,
  normalizeChannel,
  publishedFlows,
  slackChannelOf,
  slackFactsOf,
  slackThreadOf,
  type PublishedFlow,
} from '../src/server/flow-triggers.js';
import { makeNode, type FlowGraph } from '../src/shared/flows.js';
import type { Flow } from '../src/shared/flows.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  cleanup.push(() => platform.runner.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  /** Creates the flow and publishes it, so its triggers are live. */
  const publish = async (graph: FlowGraph, name = 'Trigger flow') => {
    const created = await app.request(
      'http://localhost/api/flows',
      json({ name, graph }),
    );
    expect(created.status).toBe(201);
    const flow = (await created.json()) as Flow;
    const published = await app.request(
      `http://localhost/api/flows/${flow.id}/publish`,
      json({ revision: flow.revision }),
    );
    expect(await published.json()).toMatchObject({ id: flow.id });
    return flow;
  };
  const draft = async (graph: FlowGraph, name = 'Draft flow') => {
    const created = await app.request(
      'http://localhost/api/flows',
      json({ name, graph }),
    );
    expect(created.status).toBe(201);
    return (await created.json()) as Flow;
  };
  const runsOf = (flowId: string) => ws.runs.list(flowId);
  const settle = async (flowId: string) => {
    for (const run of runsOf(flowId)) await platform.runner.settled(run.id);
  };
  return { store, ws, platform, app, publish, draft, runsOf, settle };
}

function graph(
  nodes: [label: string, type: string, config?: Record<string, unknown>][],
  edges: [from: string, port: string, to: string, input: string][],
): FlowGraph {
  const built = new Map(
    nodes.map(([label, type, config], index) => {
      const node = makeNode(type, { x: index * 300, y: 100 }, config ?? {});
      node.label = label;
      return [label, node];
    }),
  );
  return {
    schema: 1,
    nodes: [...built.values()],
    edges: edges.map(([from, port, to, input], index) => ({
      id: `e${index}`,
      source: built.get(from)!.id,
      sourceHandle: port,
      target: built.get(to)!.id,
      targetHandle: input,
    })),
  };
}
const slackGraph = (config: Record<string, unknown>) =>
  graph(
    [
      ['Start', 'start', { trigger: 'slack', ...config }],
      ['Combine', 'combine', { template: 'heard {{start.input}}' }],
      // A flow only takes a mention away from the Dot when it answers in the
      // thread itself, so the Finish of the fixture replies there.
      ['Finish', 'finish', { replyToTrigger: true }],
    ],
    [
      ['Start', 'started', 'Combine', 'values'],
      ['Combine', 'text', 'Finish', 'value'],
    ],
  );
const pageGraph = (config: Record<string, unknown>) =>
  graph(
    [
      ['Start', 'start', { trigger: 'page', ...config }],
      ['Combine', 'combine', { template: 'saw {{start.input}}' }],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Combine', 'values'],
      ['Combine', 'text', 'Finish', 'value'],
    ],
  );
/** A page Start whose Save page writes back into the Space it watches. */
const loopGraph = (spaceId: string) =>
  graph(
    [
      ['Start', 'start', { trigger: 'page', watchSpace: spaceId }],
      ['Combine', 'combine', { template: 'echo of {{start.input}}' }],
      [
        'Save',
        'save-page',
        { space: spaceId, mode: 'create', title: 'Echo', review: false },
      ],
      ['Finish', 'finish', {}],
    ],
    [
      ['Start', 'started', 'Combine', 'values'],
      ['Combine', 'text', 'Save', 'content'],
      ['Save', 'saved', 'Finish', 'value'],
    ],
  );
const published = (graphs: FlowGraph[]): PublishedFlow[] =>
  graphs.map((graph, index) => ({ flowId: `f${index}`, graph }));

it('matches Slack Starts on the channel filter, the keyword and the active toggle', () => {
  expect(normalizeChannel('#Support ')).toBe('support');
  const any = slackGraph({});
  const scoped = slackGraph({ slackChannel: '#support' });
  const keyed = slackGraph({ slackKeyword: 'Digest' });
  const off = slackGraph({ active: false });
  const flows = published([any, scoped, keyed, off]);
  const ids = (channel: string | undefined, text: string) =>
    matchingSlackStarts(flows, { channel, text }).map((hit) => hit.flowId);
  // No filters: every mention. Channel filter: only that channel, and never
  // an event that carried no channel at all.
  expect(ids('support', 'hello')).toEqual(['f0', 'f1']);
  expect(ids('#Support', 'hello')).toEqual(['f0', 'f1']);
  expect(ids('random', 'hello')).toEqual(['f0']);
  expect(ids(undefined, 'hello')).toEqual(['f0']);
  // Keyword filter is case-insensitive and substring-based.
  expect(ids('random', 'send the DIGEST please')).toEqual(['f0', 'f2']);
  // The inactive Start never matches.
  expect(ids('support', 'digest')).not.toContain('f3');
  expect(slackChannelOf({ ref: { id: '1.2', channel: 'C42' } })).toBe('C42');
  expect(slackChannelOf({ ref: { conversationKey: 'C42::thread' } })).toBe(
    'C42',
  );
  expect(slackChannelOf({ ref: { id: '1.2' } })).toBeUndefined();
});

it('matches page Starts on the Space and the event', () => {
  const created = pageGraph({ watchSpace: 's1', pageEvent: 'created' });
  const updated = pageGraph({ watchSpace: 's1', pageEvent: 'updated' });
  const other = pageGraph({ watchSpace: 's2', pageEvent: 'updated' });
  const flows = published([created, updated, other]);
  const ids = (spaceId: string, event: 'created' | 'updated') =>
    matchingPageStarts(flows, {
      spaceId,
      pageId: 'p1',
      title: 'Note',
      event,
    }).map((hit) => hit.flowId);
  expect(ids('s1', 'created')).toEqual(['f0', 'f1']);
  expect(ids('s1', 'updated')).toEqual(['f1']);
  // 'updated' means created or updated, so f2 takes both in its own Space.
  expect(ids('s2', 'created')).toEqual(['f2']);
  expect(ids('s2', 'updated')).toEqual(['f2']);
});

it('drops a page event from a flow with a run in flight, cooldown aside', () => {
  const fired: string[] = [];
  let now = 1_000_000;
  let busy: string[] = [];
  const bridge = new FlowTriggerBridge({
    published: () => [{ flowId: 'f1', graph: pageGraph({ watchSpace: 's1' }) }],
    paused: () => false,
    fire: (flowId, nodeId) => {
      fired.push(`${flowId}:${nodeId}`);
      return { id: 'run' };
    },
    busyFlows: () => busy,
    now: () => now,
    report: () => {},
  });
  const write = {
    spaceId: 's1',
    pageId: 'p1',
    title: 'Note',
    event: 'created' as const,
  };
  // A run of this flow is working, so the write is its own output.
  busy = ['f1'];
  bridge.pageWritten(write);
  expect(fired).toEqual([]);
  // Nothing in flight: it fires, and a second event inside the window does not.
  busy = [];
  bridge.pageWritten(write);
  expect(fired).toHaveLength(1);
  now += PAGE_TRIGGER_WINDOW_MS - 1;
  bridge.pageWritten(write);
  expect(fired).toHaveLength(1);
  // Past the window, and with nothing in flight, the next event fires again.
  now += 1;
  bridge.pageWritten(write);
  expect(fired).toHaveLength(2);
  // A fire the runner refuses does not consume the window: the next event
  // is attempted instead of being silently swallowed for 10 s.
  let attempts = 0;
  const refusing = new FlowTriggerBridge({
    published: () => [{ flowId: 'f1', graph: pageGraph({ watchSpace: 's1' }) }],
    paused: () => false,
    fire: () => {
      attempts += 1;
      return undefined;
    },
    now: () => now,
    report: () => {},
  });
  refusing.pageWritten(write);
  refusing.pageWritten(write);
  expect(attempts).toBe(2);
});

it('fires only published flows from a Slack mention and acknowledges once', async () => {
  const f = fixture();
  const live = await f.publish(
    slackGraph({ slackChannel: '#support' }),
    'Live',
  );
  const unpublished = await f.draft(slackGraph({ slackChannel: '#support' }));
  // Only the published version is visible to the triggers.
  expect(publishedFlows(f.ws.flows).map((flow) => flow.flowId)).toEqual([
    live.id,
  ]);
  const acknowledge = vi.fn(async () => {});
  const reply = vi.fn(async () => {});
  expect(
    await f.platform.triggers.slackMention({
      channel: 'support',
      text: 'please summarise',
      user: 'U1',
      threadTs: '171.1',
      acknowledge,
      reply,
    }),
  ).toBe(true);
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(SLACK_ACKNOWLEDGEMENT);
  const runs = f.runsOf(live.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].trigger).toMatchObject({
    source: 'slack',
    input: 'please summarise',
    fields: { channel: 'support', user: 'U1', threadTs: '171.1' },
  });
  expect(f.runsOf(unpublished.id)).toHaveLength(0);
  await f.settle(live.id);
  // The Finish posted the result back into the thread the mention arrived
  // on, which is what taking the mention away from the Dot promised.
  expect(reply).toHaveBeenCalledExactlyOnceWith('heard please summarise');
  // A mention in another channel is left to the Dot.
  expect(
    await f.platform.triggers.slackMention({
      channel: 'random',
      text: 'please summarise',
    }),
  ).toBe(false);
  expect(f.runsOf(live.id)).toHaveLength(1);
});

it('fires one run for a page created in the watched Space and none elsewhere', async () => {
  const f = fixture();
  const watched = f.ws.spaces()[0].id;
  const other = f.ws.createSpace('Elsewhere', 'Another Space').id;
  const flow = await f.publish(pageGraph({ watchSpace: watched }), 'Watcher');
  f.ws.pages.create(other, { title: 'Ignored', content: '', parentId: null });
  expect(f.runsOf(flow.id)).toHaveLength(0);
  const page = f.ws.pages.create(watched, {
    title: 'Release notes',
    content: 'x',
    parentId: null,
  });
  const runs = f.runsOf(flow.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].trigger).toMatchObject({
    source: 'page',
    input: 'Release notes',
    fields: { spaceId: watched, pageId: page.id, title: 'Release notes' },
  });
  await f.settle(flow.id);
  expect(await f.runsOf(flow.id)).toHaveLength(1);
  // 'created' ignores an update to a page it already saw.
  f.ws.pages.update(watched, page.id, { content: 'y', expectedRevision: 1 });
  expect(f.runsOf(flow.id)).toHaveLength(1);
});

it('does not let a flow that saves into the Space it watches loop', async () => {
  const f = fixture();
  const watched = f.ws.spaces()[0].id;
  const flow = await f.publish(loopGraph(watched), 'Echo');
  f.ws.pages.create(watched, {
    title: 'Seed',
    content: 'hello',
    parentId: null,
  });
  expect(f.runsOf(flow.id)).toHaveLength(1);
  await f.settle(flow.id);
  const runs = f.runsOf(flow.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe('completed');
  // The run did write its page: the guard dropped the event, not the save.
  expect(f.ws.pages.list(watched).map((page) => page.title)).toEqual([
    'Seed',
    'Echo',
  ]);
  // Belt and braces: even with no run in flight, the same flow will not fire
  // again from a page event inside the 10 s window.
  f.ws.pages.create(watched, { title: 'Again', content: 'x', parentId: null });
  expect(f.runsOf(flow.id)).toHaveLength(1);
  expect(PAGE_TRIGGER_WINDOW_MS).toBe(10_000);
});

it('fires nothing while the workspace is paused', async () => {
  const f = fixture();
  const watched = f.ws.spaces()[0].id;
  const pageFlow = await f.publish(pageGraph({ watchSpace: watched }), 'Pages');
  const slackFlow = await f.publish(slackGraph({}), 'Slack');
  f.store.updateSettings({ paused: true });
  const acknowledge = vi.fn(async () => {});
  expect(
    await f.platform.triggers.slackMention({
      channel: 'support',
      text: 'go',
      acknowledge,
    }),
  ).toBe(false);
  expect(acknowledge).not.toHaveBeenCalled();
  f.ws.pages.create(watched, { title: 'Quiet', content: '', parentId: null });
  expect(f.runsOf(pageFlow.id)).toHaveLength(0);
  expect(f.runsOf(slackFlow.id)).toHaveLength(0);
  // Resuming lets the next event through.
  f.store.updateSettings({ paused: false });
  f.ws.pages.create(watched, { title: 'Loud', content: '', parentId: null });
  expect(f.runsOf(pageFlow.id)).toHaveLength(1);
  await f.settle(pageFlow.id);
});

/* ---------- the channel and thread of an inbound mention ---------- */

it('reads the channel and thread from the conversation key, not the message', () => {
  // Channels builds a turn's message with an empty `ref`, so the adapter's
  // conversation key is the only place these facts arrive.
  expect(slackFactsOf('C01ABCDEF::1716.0001')).toEqual({
    channel: 'C01ABCDEF',
    threadTs: '1716.0001',
  });
  // A DM's scope is the `dm` sentinel, which is not a thread.
  expect(slackFactsOf('D0199::dm')).toEqual({ channel: 'D0199' });
  expect(slackFactsOf('')).toEqual({});
  // A message's own ts is never guessed at as the thread: in an existing
  // thread it names the reply, not the thread.
  expect(slackThreadOf({ ref: { id: '1716.0002' } })).toBeUndefined();
  expect(slackThreadOf({ ref: { thread_ts: '1716.0001' } })).toBe('1716.0001');

  let now = 1_000;
  const facts = new SlackEventFactStore(50, 2, () => now);
  facts.remember('ev1', { channel: 'C1', threadTs: '1.1' });
  // Taken once: the hand-off is one event long.
  expect(facts.take('ev1')).toEqual({ channel: 'C1', threadTs: '1.1' });
  expect(facts.take('ev1')).toEqual({});
  // Expired entries are not handed back.
  facts.remember('ev2', { channel: 'C2' });
  now += 51;
  expect(facts.take('ev2')).toEqual({});
  // Bounded: the oldest entry goes when the limit is reached.
  facts.remember('a', { channel: 'C3' });
  facts.remember('b', { channel: 'C4' });
  facts.remember('c', { channel: 'C5' });
  expect(facts.take('a')).toEqual({});
  expect(facts.take('c')).toEqual({ channel: 'C5' });
});

/* ---------- two page flows cannot trigger each other forever ---------- */

it('refuses a page event for a flow already in the writing run chain', () => {
  const fired: string[] = [];
  let now = 2_000_000;
  // f1 watches s1 and saves into s2; f2 watches s2 and saves into s1.
  const bridge = new FlowTriggerBridge({
    published: () => [
      { flowId: 'f1', graph: pageGraph({ watchSpace: 's1' }) },
      { flowId: 'f2', graph: pageGraph({ watchSpace: 's2' }) },
    ],
    paused: () => false,
    busyFlows: () => [],
    // run_a is f1's run started by a person's write; run_b is f2's run that
    // run_a's save started, so its chain is f2 then f1.
    triggerChain: (runId) =>
      runId === 'run_a' ? ['f1'] : runId === 'run_b' ? ['f2', 'f1'] : [],
    fire: (flowId) => {
      fired.push(flowId);
      return { id: 'run_b' };
    },
    now: () => now,
    report: () => {},
  });
  // A person writes into s1: nothing upstream, so f1 fires.
  bridge.pageWritten({
    spaceId: 's1',
    pageId: 'p1',
    title: 'By hand',
    event: 'created',
  });
  expect(fired).toEqual(['f1']);
  // f1's run saves into s2, which f2 watches: f2 is not in that chain, so it
  // fires. (Past the window, so the rate limit is not what is being tested.)
  now += PAGE_TRIGGER_WINDOW_MS;
  bridge.pageWritten({
    spaceId: 's2',
    pageId: 'p2',
    title: 'From f1',
    event: 'created',
    runId: 'run_a',
  });
  expect(fired).toEqual(['f1', 'f2']);
  // f2's run saves back into s1. f1 caused that run, so it does not fire
  // again: the ring is bounded by causality, not by the 10 s window.
  now += PAGE_TRIGGER_WINDOW_MS;
  bridge.pageWritten({
    spaceId: 's1',
    pageId: 'p1',
    title: 'From f2',
    event: 'updated',
    runId: 'run_b',
  });
  expect(fired).toEqual(['f1', 'f2']);
});
