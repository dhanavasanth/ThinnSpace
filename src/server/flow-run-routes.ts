/**
 * REST for flow runs and approvals, exactly as listed in
 * src/shared/flow-runs.ts. Routes stay thin: the FlowRunner owns execution
 * and the FlowRunStore owns persistence.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { lintFlow, type FlowGraph } from '../shared/flows.js';
import type { ApprovalAction } from '../shared/flow-runs.js';

const ACTIONS: readonly ApprovalAction[] = ['approve', 'changes', 'decline'];

/** The Start node a manual run fires: the first manual Start, else the first Start. */
export function manualStart(graph: FlowGraph) {
  const starts = graph.nodes.filter((node) => node.type === 'start');
  return (
    starts.find((node) => (node.config.trigger ?? 'manual') === 'manual') ??
    starts[0]
  );
}

export function flowRunRoutes(platform: Platform) {
  const app = new Hono();
  const flows = platform.workspace.flows;
  const runs = platform.workspace.runs;
  const runner = platform.runner;
  const lintContext = () => ({
    dots: platform.workspace.dots(),
    spaces: platform.workspace.spaces(),
  });

  // Fixed paths come before the parameterised ones so "runs" and
  // "approvals" are never read as flow ids.
  app.get('/flows/approvals', (c) => c.json(runs.pendingApprovals()));
  app.post('/flows/approvals/:id/decide', async (c) => {
    const data = z
      .object({
        action: z.enum(ACTIONS),
        feedback: z.string().max(10_000).optional(),
        editedText: z.string().max(200_000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: 'Invalid decision.' }, 400);
    const approval = runs.approval(c.req.param('id'));
    if (!approval) return c.json({ error: 'Review not found.' }, 404);
    if (approval.status !== 'pending')
      return c.json({ error: 'This review was already decided.' }, 409);
    const { action } = data.data;
    const feedback = data.data.feedback?.trim() || null;
    if (!approval.payload.actions.includes(action))
      return c.json(
        { error: 'That choice is not offered on this review.' },
        400,
      );
    if (action !== 'approve' && approval.payload.requireFeedback && !feedback)
      return c.json({ error: 'Add a note explaining your decision.' }, 400);
    const editedText =
      action === 'approve' && approval.payload.allowEdits
        ? (data.data.editedText ?? null)
        : null;
    try {
      const run = await runner.decide(approval.id, {
        action,
        feedback,
        editedText,
      });
      return run ? c.json(run) : c.json({ error: 'Review not found.' }, 404);
    } catch (error) {
      if (error instanceof Error && error.message === 'decided')
        return c.json({ error: 'This review was already decided.' }, 409);
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'The run could not resume.',
        },
        409,
      );
    }
  });
  app.get('/flows/runs/:runId', (c) => {
    const run = runs.get(c.req.param('runId'));
    return run ? c.json(run) : c.json({ error: 'Run not found.' }, 404);
  });
  app.post('/flows/runs/:runId/cancel', (c) => {
    const run = runner.cancel(c.req.param('runId'));
    return run ? c.json(run) : c.json({ error: 'Run not found.' }, 404);
  });

  app.get('/flows/:id/runs', (c) =>
    flows.get(c.req.param('id'))
      ? c.json(runs.list(c.req.param('id')))
      : c.json({ error: 'Flow not found.' }, 404),
  );
  app.post('/flows/:id/runs', async (c) => {
    const data = z
      .object({
        input: z.string().max(100_000).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!data.success) return c.json({ error: 'Invalid run request.' }, 400);
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    const problems = lintFlow(flow.graph, lintContext()).filter(
      (problem) => problem.level === 'error',
    );
    if (problems.length)
      return c.json(
        { error: 'Fix the problems in this flow before running it.', problems },
        400,
      );
    const start = manualStart(flow.graph);
    if (!start) return c.json({ error: 'Add a Start node.' }, 400);
    const record = runner.create(flow, flow.graph, null, {
      source: 'manual',
      nodeId: start.id,
      input: data.data.input ?? '',
      fields: data.data.fields,
    });
    runner.start(record.id);
    return c.json(runs.get(record.id), 201);
  });
  app.post('/flows/:id/hooks/:nodeId', async (c) => {
    const flow = flows.get(c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found.' }, 404);
    const trigger = runs
      .triggers(flow.id)
      .find(
        (row) => row.kind === 'webhook' && row.nodeId === c.req.param('nodeId'),
      );
    if (!flow.publishedVersionId || !trigger)
      return c.json(
        { error: 'Publish the flow with a webhook Start to call it.' },
        404,
      );
    if (!trigger.active)
      return c.json({ error: 'This webhook is paused.' }, 409);
    if (trigger.config.webhookAuth !== 'none') {
      const token = runs.webhookToken(flow.id);
      if (!token || c.req.header('X-Flow-Token') !== token)
        return c.json({ error: 'Invalid or missing X-Flow-Token.' }, 401);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const fields =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const input =
      typeof fields?.input === 'string'
        ? fields.input
        : typeof body === 'string'
          ? body
          : body == null
            ? ''
            : JSON.stringify(body);
    const record = runner.fire(flow.id, trigger.nodeId, {
      source: 'webhook',
      input,
      fields,
    });
    if (!record)
      return c.json({ error: 'The published version has no such Start.' }, 404);
    return c.json({ runId: record.id }, 202);
  });
  return app;
}
