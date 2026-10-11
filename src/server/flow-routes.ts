import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  emptyGraph,
  fieldVisible,
  lintFlow,
  nodeFields,
  type FlowGraph,
} from '../shared/flows.js';
import { flowTemplate } from '../shared/flow-templates.js';

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
    if (!data.success)
      return c.json(
        { error: 'Give the flow a name (up to 80 characters).' },
        400,
      );
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
