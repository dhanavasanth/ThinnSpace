/**
 * The run experience on the Flows canvas: the compact run dialog opened by
 * "Run flow", the bottom run tray ("This run" / "History"), the approval
 * card for waiting runs, the header "Runs" toggle, and the pure helpers that
 * turn step rows into card statuses. State lives in useFlowRun; this file
 * only renders it. Styles are in flow-runs.css.
 */
import './flow-runs.css';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Activity,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Clock,
  ExternalLink,
  LoaderCircle,
  Play,
  Square,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  runIsActive,
  type ApprovalAction,
  type FlowApproval,
  type FlowRun,
  type FlowRunStep,
  type FlowRunSummary,
  type RunStatus,
  type StepStatus,
  type TriggerSource,
} from '../../shared/flow-runs';
import { nodeLabel, type FlowGraph, type FlowNode } from '../../shared/flows';
import type { FlowNodeData } from './contract';
import { relativeTime } from './format';

/* ---------- pure helpers ---------- */

export type NodeRunStatus = FlowNodeData['status'];

/** One status per node from its step rows (latest attempt per item). */
export function stepStatuses(steps: FlowRunStep[]): Map<string, NodeRunStatus> {
  const latest = new Map<string, Map<string, FlowRunStep>>();
  for (const step of steps) {
    const rows = latest.get(step.nodeId) ?? new Map<string, FlowRunStep>();
    const previous = rows.get(step.iterationKey);
    if (!previous || step.attempt >= previous.attempt)
      rows.set(step.iterationKey, step);
    latest.set(step.nodeId, rows);
  }
  const out = new Map<string, NodeRunStatus>();
  for (const [nodeId, rows] of latest)
    out.set(nodeId, nodeStatus([...rows.values()].map((row) => row.status)));
  return out;
}
/**
 * Per-item rule from the spec: running if any item runs, failed if any
 * failed, else completed. A node still waiting on later items counts as
 * running; a node whose rows all were skipped is skipped.
 */
export function nodeStatus(statuses: StepStatus[]): NodeRunStatus {
  const set = new Set(statuses);
  if (set.has('running')) return 'running';
  if (set.has('waiting')) return 'waiting';
  if (set.has('failed')) return 'failed';
  if (set.has('completed')) return set.has('pending') ? 'running' : 'completed';
  if (set.has('skipped')) return 'skipped';
  return 'idle';
}

export interface RunField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean';
  required: boolean;
}
/** The Start's `inputFields` rows ({name,label,type,required}), sanitised. */
export function runFormFields(config: Record<string, unknown>): RunField[] {
  let rows: unknown = config.inputFields;
  if (typeof rows === 'string') {
    if (!rows.trim()) return [];
    try {
      rows = JSON.parse(rows);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const fields: RunField[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = String(record.type ?? 'text').toLowerCase();
    fields.push({
      name,
      label:
        typeof record.label === 'string' && record.label.trim()
          ? record.label.trim()
          : name,
      type:
        kind === 'textarea' || kind === 'number'
          ? kind
          : kind === 'boolean' || kind === 'toggle' || kind === 'checkbox'
            ? 'boolean'
            : 'text',
      required: record.required === true,
    });
  }
  return fields;
}
/** The Start a manual run fires: the first manual Start, else the first. */
export function manualStart(graph: FlowGraph): FlowNode | undefined {
  const starts = graph.nodes.filter((node) => node.type === 'start');
  return (
    starts.find((node) => (node.config.trigger ?? 'manual') === 'manual') ??
    starts[0]
  );
}
/** Whether "Run flow" should ask for input before starting. */
export function needsRunDialog(start: FlowNode | undefined) {
  if (!start) return false;
  return !!inputLabel(start) || runFormFields(start.config).length > 0;
}
function inputLabel(start: FlowNode) {
  const label = start.config.inputLabel;
  return typeof label === 'string' ? label.trim() : '';
}

/** "0.4s", "2.5s", "12s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
/** Wall-clock time of a run so far (waiting time included). */
export function runElapsed(
  run: Pick<FlowRunSummary, 'startedAt' | 'finishedAt'>,
  now = Date.now(),
) {
  return Math.max(0, (run.finishedAt ?? now) - run.startedAt);
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for a person',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Not started',
  running: 'Running',
  waiting: 'Waiting for a person',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
};
export const TRIGGER_LABEL: Record<TriggerSource, string> = {
  manual: 'Manual',
  schedule: 'On a schedule',
  webhook: 'Webhook',
  slack: 'Slack mention',
  page: 'Page change',
};
const STATUS_ICON: Record<RunStatus | StepStatus, LucideIcon> = {
  queued: CircleDashed,
  pending: CircleDashed,
  running: LoaderCircle,
  waiting: User,
  completed: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
  cancelled: Ban,
  interrupted: CircleAlert,
};

/** Steps in execution order: started ones by start time, the rest by graph order. */
export function orderSteps(steps: FlowRunStep[], order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const item = (step: FlowRunStep) => Number(step.iterationKey) || 0;
  return [...steps].sort((a, b) => {
    const started = (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
    if (started && Number.isFinite(started)) return started;
    if ((a.startedAt == null) !== (b.startedAt == null))
      return a.startedAt == null ? 1 : -1;
    const byGraph =
      (rank.get(a.nodeId) ?? order.length) -
      (rank.get(b.nodeId) ?? order.length);
    return byGraph || item(a) - item(b) || a.attempt - b.attempt;
  });
}

const VALUE_MAX = 4000;
/** A step's input or port value as display text. */
export function valueText(value: unknown): string {
  if (value == null || value === '') return '';
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > VALUE_MAX
    ? `${text.slice(0, VALUE_MAX)}\n… (${text.length - VALUE_MAX} more characters)`
    : text;
}

/* ---------- small pieces ---------- */

function StatusIcon({
  status,
  size = 14,
}: {
  status: RunStatus | StepStatus;
  size?: number;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <Icon
      size={size}
      className={`flow-run-status-icon ${status}`}
      aria-hidden="true"
    />
  );
}
function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span className={`flow-run-chip ${status}`}>
      <StatusIcon status={status} size={13} />
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}
/** Ticks once a second while `on`, so elapsed times stay honest. */
function useClock(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}
const startedText = (at: number) =>
  `${new Date(at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })} · ${relativeTime(at)}`;

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/* ---------- the "Runs" toggle (header) ---------- */

export function RunsButton({
  open,
  active,
  reviews,
  onClick,
}: {
  open: boolean;
  active: boolean;
  /** Pending reviews across every flow. */
  reviews: number;
  onClick: () => void;
}) {
  const title = reviews
    ? `${reviews} ${reviews === 1 ? 'review' : 'reviews'} waiting for you`
    : active
      ? 'A run is in progress'
      : 'Show runs';
  return (
    <button
      type="button"
      className={`flow-runs-toggle${active ? ' active' : ''}`}
      aria-pressed={open}
      aria-label={reviews ? `Runs, ${title}` : 'Runs'}
      title={title}
      onClick={onClick}
    >
      {active ? (
        <LoaderCircle size={14} className="flow-run-spin" aria-hidden="true" />
      ) : (
        <Activity size={14} aria-hidden="true" />
      )}
      Runs
      {reviews > 0 && <span className="flow-runs-badge">{reviews}</span>}
    </button>
  );
}

/* ---------- run dialog ---------- */

export interface RunDialogProps {
  start: FlowNode;
  busy: boolean;
  /** Network or server failure from the last attempt, shown inline. */
  error?: string;
  onSubmit: (input: string, fields: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** Compact form for a manual Start that asks for an input or typed fields. */
export function RunDialog({
  start,
  busy,
  error,
  onSubmit,
  onCancel,
}: RunDialogProps) {
  const label = inputLabel(start);
  const fields = useMemo(() => runFormFields(start.config), [start.config]);
  const sample =
    typeof start.config.sampleInput === 'string'
      ? start.config.sampleInput
      : '';
  const [input, setInput] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.name,
        field.type === 'boolean' ? false : '',
      ]),
    ),
  );
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onCancel]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const missing = fields.find(
      (field) =>
        field.required &&
        field.type !== 'boolean' &&
        !String(values[field.name] ?? '').trim(),
    );
    if (missing) return setProblem(`${missing.label} is required.`);
    const typed: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name];
      if (field.type === 'boolean') typed[field.name] = raw === true;
      else if (field.type === 'number') {
        const text = String(raw ?? '').trim();
        if (text && Number.isNaN(Number(text)))
          return setProblem(`${field.label} must be a number.`);
        if (text) typed[field.name] = Number(text);
      } else if (String(raw ?? '').trim()) typed[field.name] = String(raw);
    }
    setProblem('');
    onSubmit(input, typed);
  };
  const set = (name: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [name]: value }));

  return (
    // Pointer-down, like the other dialogs: a text selection that starts in
    // the form and ends over the backdrop must not discard what was typed.
    <div className="flow-run-dialog-backdrop" onPointerDown={onCancel}>
      <form
        className="flow-run-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-run-dialog-title"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header>
          <h2 id="flow-run-dialog-title">Run flow</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onCancel}
          >
            <X size={14} />
          </button>
        </header>
        <div className="flow-run-dialog-body">
          {label && (
            <label className="flow-run-field">
              <span>{label}</span>
              <textarea
                autoFocus
                rows={4}
                placeholder={sample || `Type the ${label.toLowerCase()}…`}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
          )}
          {fields.map((field, index) =>
            field.type === 'boolean' ? (
              <label className="flow-run-field check" key={field.name}>
                <input
                  type="checkbox"
                  checked={values[field.name] === true}
                  onChange={(event) => set(field.name, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
            ) : (
              <label className="flow-run-field" key={field.name}>
                <span>
                  {field.label}
                  {field.required && <em aria-hidden="true"> *</em>}
                </span>
                {field.type === 'textarea' ? (
                  <textarea
                    autoFocus={!label && index === 0}
                    rows={3}
                    required={field.required}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                ) : (
                  <input
                    autoFocus={!label && index === 0}
                    type={field.type === 'number' ? 'number' : 'text'}
                    inputMode={field.type === 'number' ? 'decimal' : undefined}
                    required={field.required}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                )}
              </label>
            ),
          )}
          {(problem || error) && (
            <p className="flow-run-error" role="alert">
              {problem || error}
            </p>
          )}
        </div>
        <footer>
          <span className="muted">⌘⏎ to run</span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            <Play size={13} fill="currentColor" />
            {busy ? 'Starting…' : 'Run'}
          </button>
        </footer>
      </form>
    </div>
  );
}

/* ---------- approval card ---------- */

export type DecideFn = (
  approvalId: string,
  action: ApprovalAction,
  feedback?: string,
  editedText?: string,
) => Promise<void> | void;

const ACTION_LABEL: Record<ApprovalAction, string> = {
  approve: 'Approve',
  changes: 'Request changes',
  decline: 'Decline',
};
const ACTION_ORDER: ApprovalAction[] = ['approve', 'changes', 'decline'];
/** Tool approvals reuse the card: their read-only "draft" is the arguments JSON. */
function looksLikeJson(text: string) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: FlowApproval;
  busy: boolean;
  onDecide: DecideFn;
}) {
  const { payload } = approval;
  const [draft, setDraft] = useState(payload.draft);
  const [feedback, setFeedback] = useState('');
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState<ApprovalAction | null>(null);
  const actions = ACTION_ORDER.filter((action) =>
    payload.actions.includes(action),
  );
  const draftLabel = payload.allowEdits
    ? 'Draft (you can edit it)'
    : looksLikeJson(payload.draft)
      ? 'Arguments'
      : 'Draft';
  const notePlaceholder = actions.includes('changes')
    ? 'What should change, or why it was declined'
    : 'Why it was declined';
  const decide = async (action: ApprovalAction) => {
    if (busy || sending) return;
    const note = feedback.trim();
    if (action !== 'approve' && payload.requireFeedback && !note)
      return setProblem('Add a note explaining your decision.');
    setProblem('');
    setSending(action);
    try {
      await onDecide(
        approval.id,
        action,
        note || undefined,
        action === 'approve' && payload.allowEdits && draft !== payload.draft
          ? draft
          : undefined,
      );
    } catch (cause) {
      setProblem(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The decision could not be sent.',
      );
    } finally {
      setSending(null);
    }
  };
  const target =
    approval.kind === 'page' && payload.pageTitle
      ? `Saves to “${payload.pageTitle}”`
      : '';
  return (
    <section
      className="flow-approval"
      aria-labelledby={`flow-approval-${approval.id}`}
    >
      <header>
        <User size={14} aria-hidden="true" />
        <strong id={`flow-approval-${approval.id}`}>{approval.title}</strong>
        {target && <span className="muted">{target}</span>}
      </header>
      {payload.message && (
        <div className="flow-approval-message">
          <Markdown text={payload.message} />
        </div>
      )}
      <label className="flow-run-field">
        <span>{draftLabel}</span>
        <textarea
          rows={6}
          readOnly={!payload.allowEdits}
          aria-readonly={!payload.allowEdits}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <label className="flow-run-field">
        <span>
          Note
          {payload.requireFeedback ? (
            <em aria-hidden="true"> * for changes or a decline</em>
          ) : (
            <small className="muted"> (optional)</small>
          )}
        </span>
        <textarea
          rows={2}
          placeholder={notePlaceholder}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>
      {problem && (
        <p className="flow-run-error" role="alert">
          {problem}
        </p>
      )}
      <footer>
        {actions.map((action) => (
          <button
            type="button"
            key={action}
            className={
              action === 'approve'
                ? 'primary'
                : action === 'decline'
                  ? 'flow-approval-danger'
                  : ''
            }
            disabled={busy || !!sending}
            onClick={() => void decide(action)}
          >
            {action === 'approve' && <Check size={13} />}
            {sending === action ? 'Sending…' : ACTION_LABEL[action]}
          </button>
        ))}
      </footer>
    </section>
  );
}

/* ---------- run tray ---------- */

export interface RunTrayProps {
  run: FlowRun | null;
  runs: FlowRunSummary[];
  runsLoaded: boolean;
  busy: boolean;
  /** Inline network or server error from the hook. */
  error: string;
  /** Node ids in execution order (runOrder), for steps that have not started. */
  order: string[];
  onClose: () => void;
  onStop: () => void;
  onSelectRun: (runId: string) => void;
  onDecide: DecideFn;
  /** Drops the loaded run and its painted statuses. */
  onDismiss: () => void;
  /** Select and centre a step's card on the canvas. */
  onFocusNode?: (nodeId: string) => void;
}

type Tab = 'run' | 'history';

export function RunTray({
  run,
  runs,
  runsLoaded,
  busy,
  error,
  order,
  onClose,
  onStop,
  onSelectRun,
  onDecide,
  onDismiss,
  onFocusNode,
}: RunTrayProps) {
  const [tab, setTab] = useState<Tab>(run ? 'run' : 'history');
  // A freshly started or picked run always comes to the front.
  const runId = run?.id;
  useEffect(() => {
    if (runId) setTab('run');
  }, [runId]);
  const active = !!run && runIsActive(run.status);
  const now = useClock(active);
  const steps = useMemo(
    () => (run ? orderSteps(run.steps, order) : []),
    [run, order],
  );
  const pending = run
    ? run.approvals.filter((approval) => approval.status === 'pending')
    : [];
  const activeCount = runs.filter((row) => runIsActive(row.status)).length;

  return (
    <section className="flow-runs" aria-label="Runs">
      <header>
        <div className="flow-runs-tabs" role="tablist" aria-label="Runs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'run'}
            className={tab === 'run' ? 'selected' : ''}
            onClick={() => setTab('run')}
          >
            This run
            {active && (
              <LoaderCircle
                size={12}
                className="flow-run-spin"
                aria-hidden="true"
              />
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'selected' : ''}
            onClick={() => setTab('history')}
          >
            History
            {runs.length > 0 && <small>{runs.length}</small>}
          </button>
        </div>
        {error && (
          <span className="flow-runs-inline-error" role="alert">
            <CircleAlert size={12} aria-hidden="true" />
            {error}
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Close runs"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      {tab === 'history' ? (
        <div className="flow-runs-body" role="tabpanel">
          {!runsLoaded ? (
            <p className="flow-runs-empty">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="flow-runs-empty">
              <strong>No runs yet.</strong> Press Run flow to start one.
            </p>
          ) : (
            <ul className="flow-runs-history">
              {runs.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`flow-runs-row${row.id === runId ? ' current' : ''}`}
                    aria-current={row.id === runId ? 'true' : undefined}
                    disabled={busy}
                    onClick={() => onSelectRun(row.id)}
                  >
                    <StatusIcon status={row.status} />
                    <span className="flow-runs-row-status">
                      {RUN_STATUS_LABEL[row.status]}
                    </span>
                    <span className="flow-runs-row-trigger">
                      {TRIGGER_LABEL[row.trigger.source] ?? row.trigger.source}
                    </span>
                    <span className="flow-runs-row-started">
                      {startedText(row.startedAt)}
                    </span>
                    <span className="flow-runs-row-steps muted">
                      {row.completedSteps}/{row.stepCount} steps
                    </span>
                    <span className="flow-runs-row-duration">
                      {formatDuration(runElapsed(row, now))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {activeCount > 0 && runsLoaded && (
            <p className="flow-runs-foot muted">
              {activeCount} {activeCount === 1 ? 'run is' : 'runs are'} still in
              progress.
            </p>
          )}
        </div>
      ) : !run ? (
        <div className="flow-runs-body" role="tabpanel">
          <p className="flow-runs-empty">
            <strong>No run loaded.</strong> Press Run flow to start one
            {runs.length > 0 ? ', or pick one from History.' : '.'}
          </p>
        </div>
      ) : (
        <div className="flow-runs-body" role="tabpanel">
          <div className="flow-run-head">
            <StatusChip status={run.status} />
            <span className="flow-run-meta">
              <Play size={11} aria-hidden="true" />
              {TRIGGER_LABEL[run.trigger.source] ?? run.trigger.source}
            </span>
            <span
              className="flow-run-meta"
              title={new Date(run.startedAt).toLocaleString()}
            >
              <Clock size={11} aria-hidden="true" />
              Started {startedText(run.startedAt)}
            </span>
            <span className="flow-run-meta">
              {formatDuration(runElapsed(run, now))}
              {active ? ' so far' : ''}
            </span>
            <span className="flow-run-meta muted">
              {run.completedSteps}/{run.stepCount} steps
            </span>
            <span className="flow-run-head-spacer" />
            {active ? (
              <button
                type="button"
                className="flow-run-stop"
                disabled={busy}
                onClick={onStop}
              >
                <Square size={11} fill="currentColor" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                title="Clear this run from the canvas"
                onClick={onDismiss}
              >
                Clear
              </button>
            )}
          </div>
          {run.error && (
            <p className="flow-run-error" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              {run.error}
            </p>
          )}
          {run.status === 'waiting' && pending.length > 0 && (
            <div className="flow-approvals">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  busy={busy}
                  onDecide={onDecide}
                />
              ))}
            </div>
          )}
          {run.status === 'waiting' && pending.length === 0 && (
            <p className="flow-run-note muted">
              <User size={13} aria-hidden="true" />
              Waiting for a decision elsewhere.
            </p>
          )}
          {run.result && (run.result.text || run.result.sources.length > 0) && (
            <section className="flow-run-result" aria-label="Result">
              <h3>Result</h3>
              {run.result.text && (
                <div className="flow-run-markdown">
                  <Markdown text={run.result.text} />
                </div>
              )}
              {run.result.sources.length > 0 && (
                <ul className="flow-run-sources">
                  {run.result.sources.map((source, index) => (
                    <li key={`${source.url}-${index}`}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        <ExternalLink size={11} aria-hidden="true" />
                        {source.title || source.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {steps.length === 0 ? (
            <p className="flow-runs-empty">
              {active ? 'Starting…' : 'This run has no steps.'}
            </p>
          ) : (
            <ol className="flow-run-steps" aria-label="Steps">
              {steps.map((step) => (
                <StepRow
                  key={`${step.nodeId}:${step.iterationKey}:${step.attempt}`}
                  step={step}
                  now={now}
                  onFocus={onFocusNode}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function StepRow({
  step,
  now,
  onFocus,
}: {
  step: FlowRunStep;
  now: number;
  onFocus?: (nodeId: string) => void;
}) {
  const duration =
    step.durationMs ??
    (step.startedAt != null ? (step.finishedAt ?? now) - step.startedAt : null);
  const input = valueText(step.input);
  const ports = step.output ? Object.entries(step.output) : [];
  const item = step.iterationKey
    ? ` · item ${Number(step.iterationKey) + 1}`
    : '';
  const retry = step.attempt > 1 ? ` · attempt ${step.attempt}` : '';
  return (
    <li>
      <details className="flow-run-step" data-status={step.status}>
        <summary>
          <StatusIcon status={step.status} />
          <span className="flow-run-step-label">
            {step.label || nodeLabel({ type: step.nodeType })}
            {(item || retry) && <small className="muted">{item + retry}</small>}
          </span>
          <span className="flow-run-step-status muted">
            {STEP_STATUS_LABEL[step.status]}
          </span>
          <span className="flow-run-step-duration">
            {step.status === 'running' || step.status === 'waiting'
              ? `${formatDuration(duration)}…`
              : formatDuration(duration)}
          </span>
        </summary>
        <div className="flow-run-step-body">
          {onFocus && (
            <button
              type="button"
              className="flow-run-step-focus"
              onClick={() => onFocus(step.nodeId)}
            >
              Show on canvas
            </button>
          )}
          {step.error && (
            <p className="flow-run-error" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              {step.error}
            </p>
          )}
          <Block title="Input" body={input} empty="No input recorded." />
          {ports.length === 0
            ? step.status === 'completed' && (
                <Block title="Output" body="" empty="Nothing emitted." />
              )
            : ports.map(([port, value]) => (
                <Block
                  key={port}
                  title={`Output · ${port}`}
                  hint={value.kind}
                  body={valueText(value.value)}
                  empty="Empty."
                />
              ))}
        </div>
      </details>
    </li>
  );
}

function Block({
  title,
  hint,
  body,
  empty,
}: {
  title: string;
  hint?: string;
  body: string;
  empty: string;
}): ReactNode {
  return (
    <div className="flow-run-block">
      <h4>
        {title}
        {hint && <small className="muted">{hint}</small>}
      </h4>
      {body ? <pre>{body}</pre> : <p className="muted">{empty}</p>}
    </div>
  );
}
