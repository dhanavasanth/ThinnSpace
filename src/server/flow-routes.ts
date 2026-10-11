import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  configWithDefaults,
  emptyGraph,
  fieldVisible,
  lintFlow,
  nodeFields,
  nodeLabel,
  type Flow,
  type FlowGraph,
} from '../shared/flows.js';
import {
  WEBHOOK_TOKEN_HEADER,
  type FlowStartInfo,
  type FlowTriggerInfo,
} from '../shared/flow-runs.js';
import { flowTemplate } from '../shared/flow-templates.js';

// The trigger-info contract lives in src/shared so the editor's panel can
// read it without importing a server module; re-exported here because this
// is the route that answers it.
export {
  WEBHOOK_TOKEN_HEADER,
  type FlowStartInfo,
  type FlowTriggerInfo,
} from '../shared/flow-runs.js';

const position = z.object({ x: z.number().finite(), y: z.number().finite() });
const nodeSchema = z
  .object({
    id: z.string().min(1).max(40),
    type: z.string().min(1).max(40),
    typeVersion: z.number().int().min(1),
    label: z.string().max(80).optional(),
    position,
    config: z.record(z.string(), z.unknown()),
    collapsed: z.boolean().optional(),
    width: z.number().positive().max(2000).optional(),
    height: z.number().positive().max(2000).optional(),
  })
  .strict();
const edgeSchema = z
  .object({
    id: z.string().min(1).max(40),
    source: z.string().min(1),
    sourceHandle: z.string().min(1),
    target: z.string().min(1),
    targetHandle: z.string().min(1),
  })
  .strict();
export const graphSchema = z
  .object({
    schema: z.literal(1),
    nodes: z.array(nodeSchema).max(FLOW_LIMITS.nodes),
    edges: z.array(edgeSchema).max(FLOW_LIMITS.edges),
    viewport: z
      .object({ x: z.number(), y: z.number(), zoom: z.number().positive() })
      .optional(),
  })
  .strict();

/**
 * A schedule Start's interval in words: "Every hour", "Every 30 minutes".
 * The editor renders `describeSchedule` (src/client/flows/format.ts) in full
 * sentences; this is the same reading for API callers of `FlowStartInfo`, so
 * the interval guard comes first here too — a Start with its interval zeroed
 * reads as unscheduled on both surfaces rather than only on one.
 */
export function scheduleWords(config: Record<string, unknown>): string {
  const seconds = Number(config.schedule) || 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 'No schedule set';
  if (config.scheduleDays === 'weekdays')
    return `Monday to Friday at ${String(config.scheduleAt || '09:00')}`;
  const every = (count: number, unit: string) =>
    count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
  if (seconds % 604800 === 0) return every(seconds / 604800, 'week');
  if (seconds % 86400 === 0) return every(seconds / 86400, 'day');
  if (seconds % 3600 === 0) return every(seconds / 3600, 'hour');
  return every(Math.max(1, Math.round(seconds / 60)), 'minute');
}

/** Structural checks that make a graph unsafe to store at all. */
function graphError(graph: FlowGraph): string | undefined {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) return `Duplicate node id ${node.id}.`;
    ids.add(node.id);
    if (!NODE_SPECS[node.type]) return `Unknown node type ${node.type}.`;
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) return `Duplicate connection id ${edge.id}.`;
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      return 'A connection points at a missing node.';
  }
  return undefined;
}

export function flowRoutes(platform: Platform) {
  const app = new Hono();
  const flows = platform.workspace.flows;
  const runs = platform.workspace.runs;
  const startNodes = (graph: FlowGraph) =>
    graph.nodes.filter((node) => node.type === 'start');
  /**
   * Webhook URLs, the token and schedule facts for every Start of a flow.
   * The draft graph says which Starts exist and how they are configured, so
   * the panel describes the Start the editor is showing — but every fact the
   * live endpoint enforces (whether the Start is active, whether the hook
   * demands a token) is read from the registered trigger once the flow is
   * published, because that is the snapshot the hook route checks. Saying
   * "no token needed" for a token-gated hook, or the reverse, would be a
   * security claim that is wrong in the dangerous direction.
   *
   * `token` is a secret and only travels when the caller asks for it
   * (`?secrets=1`, which the Start panel sets): the Flows list reads this
   * route for `nextRunAt` alone. Reading never mints a token either —
   * publish does that through syncTriggers, and the panel can POST
   * /webhook-token for an unpublished flow.
   */
  const triggerInfo = (
    flow: Flow,
    origin: string,
    secrets: boolean,
  ): FlowTriggerInfo => {
    const registered = runs.triggers(flow.id);
    const starts = startNodes(flow.graph).map((node) => ({
      node,
      config: configWithDefaults('start', node.config),
    }));
    return {
      flowId: flow.id,
      published: Boolean(flow.publishedVersionId),
      token: secrets ? runs.webhookToken(flow.id) : null,
      tokenHeader: WEBHOOK_TOKEN_HEADER,
      starts: starts.map(({ node, config }) => {
        const kind = String(config.trigger ?? 'manual');
        const row = registered.find((trigger) => trigger.nodeId === node.id);
        // The registered row only speaks for this Start while it is the one
        // that was published, as the same kind of trigger.
        const live =
          flow.publishedVersionId && row && row.kind === kind ? row : undefined;
        const info: FlowStartInfo = {
          nodeId: node.id,
          label: nodeLabel(node),
          trigger: kind,
          active: live ? live.active : config.active !== false,
        };
        if (kind === 'webhook') {
          info.url = `${origin}/api/flows/${flow.id}/hooks/${node.id}`;
          info.tokenRequired = live
            ? live.config.webhookAuth !== 'none'
            : config.webhookAuth !== 'none';
        }
        if (kind === 'schedule') {
          info.schedule = scheduleWords(config);
          info.nextRunAt = row?.active ? row.nextRunAt : null;
        }
        return info;
      }),
    };
  };
  /** Templates start usable: required Dot and Space choices take the first available. */
  const fillWorkspaceDefaults = (graph: FlowGraph) => {
    const dot = platform.workspace.dots()[0]?.id;
    const space = platform.workspace.spaces()[0]?.id;
    for (const node of graph.nodes)
      for (const field of nodeFields(node.type)) {
        if (!field.required || node.config[field.key] !== undefined) continue;
        if (!fieldVisible(field, node.config, node.type)) continue;
        if (field.control === 'dot' && dot) node.config[field.key] = dot;
        if (field.control === 'space' && space) node.config[field.key] = space;
      }
  };
  const lintContext = () => ({
    dots: platform.workspace.dots(),
    spaces: platform.workspace.spaces(),
  });
  const stale = (c: { json: (body: unknown, status: 409) => Response }) =>
    c.json(
      {
        error:
          'This flow changed elsewhere. Reload to pick up the latest version.',
      },
      409,
    );
  app.get('/flows', (c) => c.json(flows.list()));
  app.post('/flows', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(FLOW_LIMITS.name),
        description: z.string().max(FLOW_LIMITS.description).default(''),
        templateId: z.string().optional(),
        graph: graphSchema.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    // An import sends a whole graph here, and the import dialog shows this
    // sentence verbatim: a node id or a stray key must not be reported as a
    // problem with the flow's name.
    if (!data.success) {
      const issue = data.error.issues[0];
      return c.json(
        {
          error:
            issue?.path[0] === 'graph'
              ? `That flow graph is not valid for this version (${issue.path.map(String).join('.')}: ${issue.message}).`
              : 'Give the flow a name (up to 80 characters).',
        },
        400,
      );
    }
    const template = data.data.templateId
      ? flowTemplate(data.data.templateId)
      : undefined;
    if (data.data.templateId && !template)
      return c.json({ error: 'Unknown template.' }, 400);
    const graph = data.data.graph ?? template?.build() ?? emptyGraph();
    if (template) fillWorkspaceDefaults(graph);
    const problem = graphError(graph);
    if (problem) return c.json({ error: problem }, 400);
    return c.json(
      flows.create(data.data.name, data.data.description, graph),
      201,
    );
  });
  app.get('/flows/:id', (c) => {
    const flow = flows.get(c.req.param('id'));
    return flow ? c.json(flow) : c.json({ error: 'Flow not found.' }, 404);
  });
  app.put('/flows/:id', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(FLOW_LIMITS.name).optional(),
        description: z.string().max(FLOW_LIMITS.description).optional(),
        graph: graphSchema.optional(),
        revision: z.number().int().min(1),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Invalid flow update.' }, 400);
    if (data.data.graph) {
      const problem = graphError(data.data.graph);
      if (problem) return c.json({ error: problem }, 400);
    }
    if (!flows.get(c.req.param('id')))
      return c.json({ error: 'Flow not found.' }, 404);
    try {
      const { revision, ...patch } = data.data;
      return c.json(flows.update(c.req.param('id'), patch, revision));
    } catch (error) {
      if (error instanceof Error && error.message === 'stale') return stale(c);
      throw error;
    }
  });
  // Deleting a flow takes its runs along: active ones are dropped first so
  // nothing writes to the removed rows, then runs, approvals and triggers go.
  app.delete('/flows/:id', (c) => {
    const id = c.req.param('id');
    if (!flows.get(id)) return c.json({ error: 'Flow not found.' }, 404);
    platform.runner.discardFlow(id);
    platform.workspace.runs.removeFlow(id);
    flows.remove(id);
    return c.json({ ok: true });
  });
  app.post('/flows/:id/duplicate', (c) => {
    const copy = flows.duplicate(c.req.param('id'));
    return copy ? c.json(copy, 201) : c.json({ error: 'Flow not found.' }, 404);
  });
  app.post('/flows/:id/publish', async (c) => {
    const data = z
      .object({
        revision: z.number().int().min(1),
        label: z.string().trim().min(1).max(60).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid publish request.' }, 400);
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    const errors = lintFlow(flow.graph, lintContext()).filter(
      (problem) => problem.level === 'error',
    );
    if (errors.length)
      return c.json(
        {
          error: 'Fix the problems in this flow before publishing.',
          problems: errors,
        },
        400,
      );
    try {
      const published = flows.publish(
        flow.id,
        data.data.label ?? `Published v${flow.revision}`,
        data.data.revision,
      );
      platform.runner.syncTriggers(flow.id);
      return c.json(published);
    } catch (error) {
      if (error instanceof Error && error.message === 'stale') return stale(c);
      throw error;
    }
  });
  app.post('/flows/:id/unpublish', (c) => {
    if (!flows.get(c.req.param('id')))
      return c.json({ error: 'Flow not found.' }, 404);
    const flow = flows.unpublish(c.req.param('id'));
    platform.runner.syncTriggers(flow.id);
    return c.json(flow);
  });
  // What a Start needs to be callable: the hook URL, the interval, and —
  // for ?secrets=1 only — the webhook token.
  app.get('/flows/:id/trigger-info', (c) => {
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    return c.json(
      triggerInfo(
        flow,
        new URL(c.req.url).origin,
        c.req.query('secrets') === '1',
      ),
    );
  });
  // Mints a fresh token; every caller using the old one starts failing.
  app.post('/flows/:id/webhook-token', (c) => {
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    return c.json({
      token: runs.resetWebhookToken(flow.id),
      tokenHeader: WEBHOOK_TOKEN_HEADER,
    });
  });
  app.post('/flows/:id/validate', (c) => {
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    return c.json({ problems: lintFlow(flow.graph, lintContext()) });
  });
  app.get('/flows/:id/versions', (c) =>
    flows.get(c.req.param('id'))
      ? c.json(flows.versions(c.req.param('id')))
      : c.json({ error: 'Flow not found.' }, 404),
  );
  app.post('/flows/:id/versions', async (c) => {
    const data = z
      .object({ label: z.string().trim().min(1).max(60) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Name the version.' }, 400);
    if (!flows.get(c.req.param('id')))
      return c.json({ error: 'Flow not found.' }, 404);
    return c.json(flows.saveVersion(c.req.param('id'), data.data.label), 201);
  });
  app.get('/flows/:id/versions/:versionId', (c) => {
    const version = flows.version(c.req.param('id'), c.req.param('versionId'));
    return version
      ? c.json(version)
      : c.json({ error: 'Version not found.' }, 404);
  });
  app.post('/flows/:id/versions/:versionId/restore', async (c) => {
    const data = z
      .object({ revision: z.number().int().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid restore request.' }, 400);
    try {
      return c.json(
        flows.restore(
          c.req.param('id'),
          c.req.param('versionId'),
          data.data.revision,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'stale') return stale(c);
      if (error instanceof Error) return c.json({ error: error.message }, 404);
      throw error;
    }
  });
  return app;
}
