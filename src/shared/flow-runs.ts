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
};

export const ACTIVE_RUN: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
];
export function runIsActive(status: RunStatus) {
  return ACTIVE_RUN.includes(status);
}

/*
 * REST (all under /api, JSON):
 *   POST /flows/:id/runs           { input?: string; fields?: object }  -> 201 FlowRun
 *        Runs the current draft graph. 400 with { error, problems } when the
 *        linter reports errors. Dot steps fail at step level with a
 *        "Setup required" message when Intelligence or the model is missing.
 *   GET  /flows/:id/runs           -> FlowRunSummary[] (newest first)
 *   GET  /flows/runs/:runId        -> FlowRun (steps, last events, approvals)
 *   POST /flows/runs/:runId/cancel -> FlowRun
 *   GET  /flows/approvals          -> FlowApproval[] (pending, every flow)
 *   POST /flows/approvals/:id/decide { action, feedback?, editedText? } -> FlowRun
 *   POST /flows/:id/hooks/:nodeId  (webhook Start; header X-Flow-Token) -> 202 { runId }
 * The client polls GET /flows/runs/:runId every second while runIsActive.
 *
 * Token substitution inside text fields: {{slug.port}} where slug is the
 * upstream node's label slug (see upstreamRefs) and port its output id;
 * {{start.input}} and {{start.<field>}} read the trigger; {{slug.port.key}}
 * indexes into a json value. A chip whose source was skipped resolves to ''.
 */
