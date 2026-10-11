/**
 * Flow execution contract shared by the FlowRunner (server), the run routes,
 * and the canvas (client). A run executes a snapshot of the graph; steps are
 * one row per node (per item when a node runs once per list element).
 */
import type { PortKind } from './flows.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type StepStatus =
  'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
export type TriggerSource =
  'manual' | 'schedule' | 'webhook' | 'slack' | 'page';

/** What a completed step emitted, keyed by output port id. */
export type StepOutput = Record<string, { kind: PortKind; value: unknown }>;

export interface RunTrigger {
  source: TriggerSource;
  /** The Start node that fired. */
  nodeId: string;
  /** Free-text input for manual runs ({{start.input}}). */
  input: string;
  /** Typed run-form fields ({{start.<name>}}). */
  fields?: Record<string, unknown>;
}

export interface FlowRunStep {
  runId: string;
  nodeId: string;
  nodeType: string;
  /** Card label at run time. */
  label: string;
  /** '' for ordinary steps, the item index for per-item steps. */
  iterationKey: string;
  attempt: number;
  status: StepStatus;
  /** Rendered brief or inputs, for the run log. */
  input: unknown;
  output: StepOutput | null;
  error: string | null;
  /** Intelligence conversation for Dot steps. */
  threadId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface FlowRunEvent {
  id: number;
  runId: string;
  nodeId: string | null;
  kind: 'run' | 'step' | 'log' | 'approval' | 'message';
  text: string;
  createdAt: number;
}

export type ApprovalAction = 'approve' | 'changes' | 'decline';
/**
 * Extra context carried by the pending rows of GET /flows/approvals so the
 * Reviews inbox can render a card without fetching the flow or the run.
 * Absent on the approvals embedded in a FlowRun, which already have both.
 */
export interface ApprovalContext {
  /** Flow name recorded when the run started. */
  flowName: string;
  /** Card label of the waiting step at run time. */
  nodeLabel: string;
  runStartedAt: number;
  trigger: TriggerSource;
}
export interface FlowApproval {
  id: string;
  runId: string;
  flowId: string;
  nodeId: string;
  /** review = Human review node; page = Save page with review on. */
  kind: 'review' | 'page';
  title: string;
  payload: {
    message: string;
    draft: string;
    allowEdits: boolean;
    actions: ApprovalAction[];
    requireFeedback: boolean;
    /** For page saves: where the approved text lands. */
    spaceId?: string;
    pageTitle?: string;
    pageId?: string;
    mode?: 'create' | 'update' | 'append';
  };
  status: 'pending' | 'approved' | 'changes' | 'declined' | 'expired';
  editedText: string | null;
  feedback: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** Filled in by the inbox list route only. */
  context?: ApprovalContext;
}

export interface RunResult {
  text: string;
  sources: { title: string; url: string }[];
  /** Per Finish label when a flow has several. */
  parts?: Record<string, string>;
}

export interface FlowRunSummary {
  id: string;
  flowId: string;
  flowName: string;
  versionId: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  error: string | null;
  waitingNodeId: string | null;
  startedAt: number;
  finishedAt: number | null;
  stepCount: number;
  completedSteps: number;
}
export interface FlowRun extends FlowRunSummary {
  result: RunResult | null;
  steps: FlowRunStep[];
  events: FlowRunEvent[];
  approvals: FlowApproval[];
}

export const RUN_LIMITS = {
  /** Concurrent steps per run. */
  concurrency: 5,
  /** Wall-clock limit for one run, excluding time spent waiting on a person. */
  timeoutMinutes: 60,
  /** Dot turns per run. */
  maxDotTurns: 30,
  /** Items processed by a per-item step. */
  maxItems: 25,
  /** Events kept per run. */
  events: 500,
  /** Runs listed per flow. */
  runsPerFlow: 50,
  /**
   * Pending reviews one listing returns. Every row carries its draft, so the
   * inbox reads a page of cards rather than the whole table; the sidebar
   * badge asks for the count instead.
   */
  approvals: 100,
};

export const ACTIVE_RUN: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
];
export function runIsActive(status: RunStatus) {
  return ACTIVE_RUN.includes(status);
}

/* ---------- what a flow's triggers need to be usable ---------- */

/** The header a webhook call carries its flow token in. */
export const WEBHOOK_TOKEN_HEADER = 'X-Flow-Token';

/** One Start node of a flow, described well enough to call or to wait for. */
export interface FlowStartInfo {
  nodeId: string;
  /** The card label, so the panel can name the Start. */
  label: string;
  /** 'manual' | 'schedule' | 'slack' | 'webhook' | 'page'. */
  trigger: string;
  /**
   * False when the Start is switched off. Published flows report the
   * registered trigger's state, which is what the runner and the hook
   * actually honour; a draft reports its own toggle.
   */
  active: boolean;
  /** Webhook: the full callable URL. */
  url?: string;
  /**
   * Webhook: whether the token header must be sent, as the live endpoint
   * enforces it (the registered trigger for a published flow, the draft
   * config until then).
   */
  tokenRequired?: boolean;
  /** Schedule: the configured interval in words. */
  schedule?: string;
  /** Schedule: when the runner fires it next; null when it is not registered. */
  nextRunAt?: number | null;
}

/** The answer to GET /flows/:id/trigger-info. */
export interface FlowTriggerInfo {
  flowId: string;
  /** Triggers only fire for a published flow; until then hooks 404. */
  published: boolean;
  /**
   * The flow's webhook token: null unless the request asked for secrets
   * (`?secrets=1`), and null when no token has been minted yet.
   */
  token: string | null;
  tokenHeader: string;
  starts: FlowStartInfo[];
}

/*
 * REST (all under /api, JSON):
 *   POST /flows/:id/runs           { input?: string; fields?: object }  -> 201 FlowRun
 *        Runs the current draft graph. 400 with { error, problems } when the
 *        linter reports errors. Dot steps fail at step level with a
 *        "Setup required" message when Intelligence or the model is missing.
 *   GET  /flows/:id/runs           -> FlowRunSummary[] (newest first)
 *   GET  /flows/runs?limit=N       -> FlowRunSummary[] across every flow,
 *        newest first (limit 1-100, default 20). Registered before
 *        /flows/:id/runs so "runs" is never read as a flow id.
 *   GET  /flows/runs/:runId        -> FlowRun (steps, last events, approvals)
 *   POST /flows/runs/:runId/cancel -> FlowRun
 *   GET  /flows/approvals          -> FlowApproval[] (pending, every flow,
 *        newest first, at most RUN_LIMITS.approvals), each with `context`
 *        filled in for the Reviews inbox
 *   GET  /flows/approvals/count    -> { pending: number } for the sidebar
 *        badge, so a count never ships the whole review corpus
 *   POST /flows/approvals/:id/decide { action, feedback?, editedText? } -> FlowRun
 *   POST /flows/:id/hooks/:nodeId  (webhook Start; header X-Flow-Token) -> 202 { runId }
 *        The one /api path that does not take the owner token: the flow token
 *        is the hook's credential. A Start whose security is None is only
 *        callable on a loopback host.
 *   GET  /flows/:id/trigger-info   -> FlowTriggerInfo (hook URLs, each
 *        schedule Start's interval and next run). The DRAFT graph says which
 *        Starts exist, so it describes the Start the editor is showing, but
 *        `active`/`tokenRequired` come from the registered trigger once the
 *        flow is published, because that is what the hook enforces;
 *        `nextRunAt` is null until publish. `?secrets=1` adds the webhook
 *        token, which only the Start panel asks for; a read never mints one.
 *   POST /flows/:id/webhook-token  -> { token, tokenHeader }; mints a fresh
 *        token, so every caller holding the old one starts getting 401.
 * The client polls GET /flows/runs/:runId every second while runIsActive.
 *
 * Token substitution inside text fields: {{slug.port}} where slug is the
 * upstream node's label slug (see upstreamRefs) and port its output id;
 * {{start.input}} and {{start.<field>}} read the trigger; {{slug.port.key}}
 * indexes into a json value. A chip whose source was skipped resolves to ''.
 */
