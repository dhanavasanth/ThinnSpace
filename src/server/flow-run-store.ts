import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { FlowGraph } from '../shared/flows.js';
import {
  RUN_LIMITS,
  type ApprovalAction,
  type FlowApproval,
  type FlowRun,
  type FlowRunEvent,
  type FlowRunStep,
  type FlowRunSummary,
  type RunResult,
  type RunStatus,
  type RunTrigger,
  type StepOutput,
  type StepStatus,
} from '../shared/flow-runs.js';

/** A stored run plus the graph snapshot it executes against. */
export interface RunRecord extends FlowRunSummary {
  graph: FlowGraph;
  result: RunResult | null;
  dotTurns: number;
}
/** A registered trigger for a published flow (schedule or webhook). */
export interface TriggerRow {
  id: string;
  flowId: string;
  nodeId: string;
  kind: 'schedule' | 'webhook';
  config: Record<string, unknown>;
  active: boolean;
  nextRunAt: number | null;
}

interface RunRow {
  id: string;
  flowId: string;
  flowName: string;
  versionId: string | null;
  status: RunStatus;
  trigger: string;
  graph: string;
  result: string | null;
  error: string | null;
  waitingNodeId: string | null;
  startedAt: number;
  finishedAt: number | null;
  dotTurns: number;
}
type StepRow = Omit<FlowRunStep, 'input' | 'output'> & {
  input: string | null;
  output: string | null;
};
type ApprovalRow = Omit<FlowApproval, 'payload'> & { payload: string };
type TriggerDbRow = Omit<TriggerRow, 'config' | 'active'> & {
  config: string;
  active: number;
};

export const INTERRUPTED_MESSAGE =
  'The server restarted while this run was in progress.';

const parse = <T>(text: string | null): T | null =>
  text == null ? null : (JSON.parse(text) as T);

/**
 * Runs, their steps, events and approvals, plus the trigger registry. Every
 * run stores the graph it executes so later edits never affect it.
 */
export class FlowRunStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS flow_runs(id TEXT PRIMARY KEY, flowId TEXT NOT NULL, flowName TEXT NOT NULL, versionId TEXT, status TEXT NOT NULL, trigger TEXT NOT NULL, graph TEXT NOT NULL, result TEXT, error TEXT, waitingNodeId TEXT, startedAt INTEGER NOT NULL, finishedAt INTEGER, dotTurns INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS flow_runs_flow ON flow_runs(flowId, startedAt);
      CREATE TABLE IF NOT EXISTS flow_run_steps(runId TEXT NOT NULL, nodeId TEXT NOT NULL, nodeType TEXT NOT NULL, label TEXT NOT NULL, iterationKey TEXT NOT NULL DEFAULT '', attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, input TEXT, output TEXT, error TEXT, threadId TEXT, startedAt INTEGER, finishedAt INTEGER, durationMs INTEGER, PRIMARY KEY(runId, nodeId, iterationKey, attempt));
      CREATE TABLE IF NOT EXISTS flow_run_events(id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, nodeId TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS flow_run_events_run ON flow_run_events(runId, id);
      CREATE TABLE IF NOT EXISTS flow_approvals(id TEXT PRIMARY KEY, runId TEXT NOT NULL, flowId TEXT NOT NULL, nodeId TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, editedText TEXT, feedback TEXT, createdAt INTEGER NOT NULL, decidedAt INTEGER);
      CREATE INDEX IF NOT EXISTS flow_approvals_status ON flow_approvals(status, createdAt);
      CREATE TABLE IF NOT EXISTS flow_triggers(id TEXT PRIMARY KEY, flowId TEXT NOT NULL, nodeId TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL, active INTEGER NOT NULL, nextRunAt INTEGER);
      CREATE INDEX IF NOT EXISTS flow_triggers_due ON flow_triggers(kind, active, nextRunAt);
      CREATE TABLE IF NOT EXISTS flow_threads(flowId TEXT NOT NULL, dotId TEXT NOT NULL, key TEXT NOT NULL, threadId TEXT NOT NULL, PRIMARY KEY(flowId, dotId, key));`);
    // Columns added after the first release; existing databases gain them in place.
    for (const [table, column, definition] of [
      ['flows', 'webhookToken', 'TEXT'],
      ['flow_runs', 'dotTurns', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Nothing survives a restart in memory, so in-flight runs are over. A
    // run that was only waiting on a person keeps its status and is
    // rehydrated on the next decision.
    const stranded = db
      .prepare("SELECT id FROM flow_runs WHERE status IN ('running', 'queued')")
      .all() as { id: string }[];
    for (const { id } of stranded) {
      this.setStatus(id, 'interrupted', {
        error: INTERRUPTED_MESSAGE,
        finished: true,
      });
      // Steps that were mid-flight, or waiting beside one, close too, and
      // their reviews expire: nobody could act on them any more.
      this.failOpenSteps(id, INTERRUPTED_MESSAGE);
      this.expireApprovals(id);
      this.event(id, null, 'run', INTERRUPTED_MESSAGE);
    }
  }
  /** Closes every step row of a run still marked running or waiting. */
  failOpenSteps(runId: string, error: string) {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE flow_run_steps SET status='failed', error=?, finishedAt=?, durationMs=CASE WHEN startedAt IS NULL THEN NULL ELSE ?-startedAt END WHERE runId=? AND status IN ('running', 'waiting')",
      )
      .run(error, now, now, runId);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private counts(runId: string) {
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT nodeId) AS total, COUNT(DISTINCT CASE WHEN status='completed' THEN nodeId END) AS done FROM flow_run_steps WHERE runId=? AND iterationKey=''",
      )
      .get(runId) as { total: number; done: number | null };
    return { stepCount: row.total, completedSteps: row.done ?? 0 };
  }
  private record(row: RunRow): RunRecord {
    return {
      id: row.id,
      flowId: row.flowId,
      flowName: row.flowName,
      versionId: row.versionId,
      status: row.status,
      trigger: JSON.parse(row.trigger) as RunTrigger,
      error: row.error,
      waitingNodeId: row.waitingNodeId,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      graph: JSON.parse(row.graph) as FlowGraph,
      result: parse<RunResult>(row.result),
      dotTurns: row.dotTurns,
      ...this.counts(row.id),
    };
  }
  private row(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM flow_runs WHERE id=?').get(runId) as
      RunRow | undefined;
  }
  /** Creates a queued run with a pending step row for every executable node. */
  create(input: {
    flowId: string;
    flowName: string;
    versionId: string | null;
    graph: FlowGraph;
    trigger: RunTrigger;
    steps: { nodeId: string; nodeType: string; label: string }[];
  }): RunRecord {
    const id = randomUUID();
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO flow_runs (id, flowId, flowName, versionId, status, trigger, graph, startedAt, dotTurns) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0)",
        )
        .run(
          id,
          input.flowId,
          input.flowName,
          input.versionId,
          JSON.stringify(input.trigger),
          JSON.stringify(input.graph),
          now,
        );
      for (const step of input.steps)
        this.db
          .prepare(
            "INSERT INTO flow_run_steps (runId, nodeId, nodeType, label, iterationKey, attempt, status) VALUES (?, ?, ?, ?, '', 1, 'pending')",
          )
          .run(id, step.nodeId, step.nodeType, step.label);
      // Older runs beyond the per-flow cap fall away, approvals and all.
      const old = this.db
        .prepare(
          "SELECT id FROM flow_runs WHERE flowId=? AND status NOT IN ('queued','running','waiting') ORDER BY startedAt DESC LIMIT -1 OFFSET ?",
        )
        .all(input.flowId, RUN_LIMITS.runsPerFlow - 1) as { id: string }[];
      for (const { id: stale } of old) this.purge(stale);
    });
    return this.record(this.row(id)!);
  }
  private purge(runId: string) {
    for (const table of [
      'flow_run_steps',
      'flow_run_events',
      'flow_approvals',
      'flow_runs',
    ])
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE ${table === 'flow_runs' ? 'id' : 'runId'}=?`,
        )
        .run(runId);
  }
  /** Deletes every run (steps, events, approvals) and trigger of a flow. */
  removeFlow(flowId: string) {
    this.transaction(() => {
      for (const table of ['flow_run_steps', 'flow_run_events'])
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE runId IN (SELECT id FROM flow_runs WHERE flowId=?)`,
          )
          .run(flowId);
      for (const table of [
        'flow_approvals',
        'flow_runs',
        'flow_triggers',
        'flow_threads',
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE flowId=?`).run(flowId);
    });
  }
  run(runId: string): RunRecord | undefined {
    const row = this.row(runId);
    return row ? this.record(row) : undefined;
  }
  /** Runs of a flow, newest first. */
  list(flowId: string): FlowRunSummary[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM flow_runs WHERE flowId=? ORDER BY startedAt DESC LIMIT ?',
        )
        .all(flowId, RUN_LIMITS.runsPerFlow) as unknown as RunRow[]
    ).map((row) => summaryOf(this.record(row)));
  }
  /** Runs that still need the engine or a person. */
  active(): RunRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM flow_runs WHERE status IN ('queued','running','waiting') ORDER BY startedAt",
        )
        .all() as unknown as RunRow[]
    ).map((row) => this.record(row));
  }
  /** The full run: steps, the last events, and approvals. */
  get(runId: string): FlowRun | undefined {
    const row = this.row(runId);
    if (!row) return undefined;
    const record = this.record(row);
    return {
      ...summaryOf(record),
      result: record.result,
      steps: this.steps(runId),
      events: (
        this.db
          .prepare(
            'SELECT * FROM flow_run_events WHERE runId=? ORDER BY id DESC LIMIT ?',
          )
          .all(runId, RUN_LIMITS.events) as unknown as FlowRunEvent[]
      ).reverse(),
      approvals: (
        this.db
          .prepare(
            'SELECT * FROM flow_approvals WHERE runId=? ORDER BY createdAt',
          )
          .all(runId) as unknown as ApprovalRow[]
      ).map(hydrateApproval),
    };
  }
  steps(runId: string): FlowRunStep[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM flow_run_steps WHERE runId=? ORDER BY COALESCE(startedAt, 0), rowid',
        )
        .all(runId) as unknown as StepRow[]
    ).map((row) => ({
      ...row,
      input: parse<unknown>(row.input),
      output: parse<StepOutput>(row.output),
    }));
  }
  setStatus(
    runId: string,
    status: RunStatus,
    patch: {
      error?: string | null;
      waitingNodeId?: string | null;
      result?: RunResult | null;
      finished?: boolean;
    } = {},
  ) {
    this.db
      .prepare(
        'UPDATE flow_runs SET status=?, error=COALESCE(?, error), waitingNodeId=?, result=COALESCE(?, result), finishedAt=? WHERE id=?',
      )
      .run(
        status,
        patch.error ?? null,
        patch.waitingNodeId ?? null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.finished ? Date.now() : null,
        runId,
      );
  }
  /** Stores the result assembled so far, so a restart keeps finished parts. */
  setResult(runId: string, result: RunResult | null) {
    this.db
      .prepare('UPDATE flow_runs SET result=? WHERE id=?')
      .run(result ? JSON.stringify(result) : null, runId);
  }
  countDotTurn(runId: string): number {
    this.db
      .prepare('UPDATE flow_runs SET dotTurns=dotTurns+1 WHERE id=?')
      .run(runId);
    return this.row(runId)?.dotTurns ?? 0;
  }
  /** Writes a step row (creating the per-item rows on first use). */
  saveStep(step: {
    runId: string;
    nodeId: string;
    nodeType: string;
    label: string;
    iterationKey?: string;
    attempt?: number;
    status: StepStatus;
    input?: unknown;
    output?: StepOutput | null;
    error?: string | null;
    threadId?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
  }) {
    const started = step.startedAt ?? null;
    const finished = step.finishedAt ?? null;
    this.db
      .prepare(
        `INSERT INTO flow_run_steps (runId, nodeId, nodeType, label, iterationKey, attempt, status, input, output, error, threadId, startedAt, finishedAt, durationMs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId, nodeId, iterationKey, attempt) DO UPDATE SET status=excluded.status, input=COALESCE(excluded.input, input), output=excluded.output, error=excluded.error, threadId=COALESCE(excluded.threadId, threadId), startedAt=COALESCE(excluded.startedAt, startedAt), finishedAt=excluded.finishedAt, durationMs=CASE WHEN excluded.finishedAt IS NULL OR COALESCE(excluded.startedAt, startedAt) IS NULL THEN NULL ELSE excluded.finishedAt - COALESCE(excluded.startedAt, startedAt) END`,
      )
      .run(
        step.runId,
        step.nodeId,
        step.nodeType,
        step.label,
        step.iterationKey ?? '',
        step.attempt ?? 1,
        step.status,
        step.input === undefined ? null : JSON.stringify(step.input),
        step.output ? JSON.stringify(step.output) : null,
        step.error ?? null,
        step.threadId ?? null,
        started,
        finished,
        started != null && finished != null ? finished - started : null,
      );
  }
  event(
    runId: string,
    nodeId: string | null,
    kind: FlowRunEvent['kind'],
    text: string,
  ) {
    this.db
      .prepare(
        'INSERT INTO flow_run_events (runId, nodeId, kind, text, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, nodeId, kind, text.slice(0, 2000), Date.now());
    // Only the newest RUN_LIMITS.events rows are kept per run.
    this.db
      .prepare(
        'DELETE FROM flow_run_events WHERE runId=? AND id NOT IN (SELECT id FROM flow_run_events WHERE runId=? ORDER BY id DESC LIMIT ?)',
      )
      .run(runId, runId, RUN_LIMITS.events);
  }
  // Keyed threads ---------------------------------------------------------
  /** The thread a "one thread per key" Dot task used for this key before, if any. */
  keyedThread(flowId: string, dotId: string, key: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT threadId FROM flow_threads WHERE flowId=? AND dotId=? AND key=?',
      )
      .get(flowId, dotId, key) as { threadId: string } | undefined;
    return row?.threadId;
  }
  saveKeyedThread(
    flowId: string,
    dotId: string,
    key: string,
    threadId: string,
  ) {
    this.db
      .prepare(
        'INSERT INTO flow_threads (flowId, dotId, key, threadId) VALUES (?, ?, ?, ?) ON CONFLICT(flowId, dotId, key) DO UPDATE SET threadId=excluded.threadId',
      )
      .run(flowId, dotId, key, threadId);
  }
  createApproval(input: {
    runId: string;
    flowId: string;
    nodeId: string;
    kind: FlowApproval['kind'];
    title: string;
    payload: FlowApproval['payload'];
  }): FlowApproval {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO flow_approvals (id, runId, flowId, nodeId, kind, title, payload, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        id,
        input.runId,
        input.flowId,
        input.nodeId,
        input.kind,
        input.title,
        JSON.stringify(input.payload),
        Date.now(),
      );
    return this.approval(id)!;
  }
  approval(id: string): FlowApproval | undefined {
    const row = this.db
      .prepare('SELECT * FROM flow_approvals WHERE id=?')
      .get(id) as ApprovalRow | undefined;
    return row ? hydrateApproval(row) : undefined;
  }
  pendingApprovals(): FlowApproval[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM flow_approvals WHERE status='pending' ORDER BY createdAt DESC",
        )
        .all() as unknown as ApprovalRow[]
    ).map(hydrateApproval);
  }
  /** Records a decision; false when the approval was already decided. */
  decideApproval(
    id: string,
    action: ApprovalAction,
    feedback: string | null,
    editedText: string | null,
  ): boolean {
    const status: FlowApproval['status'] =
      action === 'approve'
        ? 'approved'
        : action === 'changes'
          ? 'changes'
          : 'declined';
    return (
      this.db
        .prepare(
          "UPDATE flow_approvals SET status=?, feedback=?, editedText=?, decidedAt=? WHERE id=? AND status='pending'",
        )
        .run(status, feedback, editedText, Date.now(), id).changes > 0
    );
  }
  expireApprovals(runId: string) {
    this.db
      .prepare(
        "UPDATE flow_approvals SET status='expired', decidedAt=? WHERE runId=? AND status='pending'",
      )
      .run(Date.now(), runId);
  }
  // Triggers -------------------------------------------------------------
  replaceTriggers(flowId: string, rows: Omit<TriggerRow, 'id'>[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM flow_triggers WHERE flowId=?').run(flowId);
      for (const row of rows)
        this.db
          .prepare(
            'INSERT INTO flow_triggers (id, flowId, nodeId, kind, config, active, nextRunAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            flowId,
            row.nodeId,
            row.kind,
            JSON.stringify(row.config),
            row.active ? 1 : 0,
            row.nextRunAt,
          );
    });
  }
  triggers(flowId?: string): TriggerRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM flow_triggers ${flowId ? 'WHERE flowId=?' : ''} ORDER BY flowId, nodeId`,
        )
        .all(...(flowId ? [flowId] : [])) as unknown as TriggerDbRow[]
    ).map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
      active: !!row.active,
    }));
  }
  /** Due schedule triggers, each pushed to its next slot so a tick claims it once. */
  claimDue(now: number, next: (row: TriggerRow) => number): TriggerRow[] {
    return this.transaction(() => {
      const due = this.triggers().filter(
        (row) =>
          row.kind === 'schedule' &&
          row.active &&
          row.nextRunAt != null &&
          row.nextRunAt <= now,
      );
      for (const row of due)
        this.db
          .prepare('UPDATE flow_triggers SET nextRunAt=? WHERE id=?')
          .run(next(row), row.id);
      return due;
    });
  }
  webhookToken(flowId: string): string | null {
    const row = this.db
      .prepare('SELECT webhookToken FROM flows WHERE id=?')
      .get(flowId) as { webhookToken: string | null } | undefined;
    return row?.webhookToken ?? null;
  }
  /** Returns the flow's webhook token, minting one the first time. */
  ensureWebhookToken(flowId: string): string {
    const current = this.webhookToken(flowId);
    if (current) return current;
    const token = randomUUID().replace(/-/g, '');
    this.db
      .prepare('UPDATE flows SET webhookToken=? WHERE id=?')
      .run(token, flowId);
    return token;
  }
}

/** The summary fields of a record, without the graph snapshot or counters. */
function summaryOf(record: RunRecord): FlowRunSummary {
  return {
    id: record.id,
    flowId: record.flowId,
    flowName: record.flowName,
    versionId: record.versionId,
    status: record.status,
    trigger: record.trigger,
    error: record.error,
    waitingNodeId: record.waitingNodeId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    stepCount: record.stepCount,
    completedSteps: record.completedSteps,
  };
}
function hydrateApproval(row: ApprovalRow): FlowApproval {
  return {
    ...row,
    payload: JSON.parse(row.payload) as FlowApproval['payload'],
  };
}
