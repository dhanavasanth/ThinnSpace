/**
 * The Reviews inbox (`#/reviews`): every pending Human review and page-save
 * review, across every flow, on one page — so a parked run is visible without
 * its canvas being open. The decision UI is the editor's own ApprovalCard, so
 * Approve / Request changes / Decline, the editable draft and the required
 * note behave identically here and on the canvas.
 *
 * `ReviewsInbox` owns the polling; `ReviewsPage` and `FlowRunsActivity` are
 * pure and render what they are given (the activity list is the "Flow runs"
 * section of the Scheduled & activity view, fed by the same cross-flow REST
 * route). Styles are in flow-reviews.css.
 */
import './flow-reviews.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Inbox, Workflow } from 'lucide-react';
import { api } from '../api';
import type {
  ApprovalAction,
  FlowApproval,
  FlowRunSummary,
} from '../../shared/flow-runs';
import {
  ApprovalCard,
  RUN_STATUS_LABEL,
  TRIGGER_LABEL,
  formatDuration,
  runElapsed,
  type DecideFn,
} from './FlowRuns';
import { relativeTime } from './format';

/** Hash route of the inbox, the Flows section's companion to FLOWS_ROUTE. */
export const REVIEWS_ROUTE = '#/reviews';
/** How often the inbox re-reads the pending list while it is open. */
export const REVIEWS_POLL_MS = 10_000;

/** "Waiting 4m", "Waiting 2h 05m", "Waiting just now" for a fresh review. */
export function waitedLabel(createdAt: number, now = Date.now()) {
  const waited = formatDuration(Math.max(0, now - createdAt));
  return waited ? `Waiting ${waited}` : 'Waiting';
}

export interface ReviewsPageProps {
  reviews: FlowApproval[];
  /** False until the first list arrives, so the empty state does not flash. */
  loaded: boolean;
  /** Inline network or server error. */
  error?: string;
  now?: number;
  onDecide: DecideFn;
  /**
   * Open the flow a review belongs to, with the parked run loaded in its
   * Runs tray.
   */
  onOpenFlow: (flowId: string, runId: string) => void;
}

/** The inbox page itself: a heading and one card per pending review. */
export function ReviewsPage({
  reviews,
  loaded,
  error,
  now = Date.now(),
  onDecide,
  onOpenFlow,
}: ReviewsPageProps) {
  return (
    <main className="main-content flow-reviews">
      <div className="page-heading">
        <div>
          <span className="eyebrow">FLOWS</span>
          <h1>Reviews</h1>
          <p>
            Decisions waiting on you across every flow. A run stays parked until
            you decide, then picks up where it left off.
          </p>
        </div>
        {reviews.length > 0 && (
          <span className="flow-run-chip waiting">
            {reviews.length} waiting
          </span>
        )}
      </div>
      {error && (
        <p className="flow-run-error" role="alert">
          {error}
        </p>
      )}
      <div className="flow-reviews-list">
        {reviews.map((review) => (
          <article
            className="flow-review"
            key={review.id}
            aria-labelledby={`${review.id}-flow`}
          >
            <header>
              <Workflow size={14} aria-hidden="true" />
              <strong id={`${review.id}-flow`}>
                {review.context?.flowName || 'A flow'}
              </strong>
              <span className="flow-review-step">
                {review.context?.nodeLabel || review.title}
              </span>
              <span className="flow-review-waited">
                {waitedLabel(review.createdAt, now)}
              </span>
              {review.context && (
                <span className="muted">
                  {TRIGGER_LABEL[review.context.trigger]}
                </span>
              )}
              <button
                type="button"
                className="flow-review-open"
                onClick={() => onOpenFlow(review.flowId, review.runId)}
              >
                Open flow
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            </header>
            <ApprovalCard approval={review} busy={false} onDecide={onDecide} />
          </article>
        ))}
      </div>
      {loaded && !reviews.length && (
        <div className="large-empty">
          <Inbox size={32} />
          <h2>Nothing waiting on you.</h2>
          <p>
            When a flow parks on Human review, or on a page save you asked to
            approve, it appears here.
          </p>
        </div>
      )}
    </main>
  );
}

export interface ReviewsInboxProps {
  /** Open the flow a review belongs to. */
  onOpenFlow: (flowId: string, runId: string) => void;
  /**
   * How many reviews are pending, reported on every poll: while the inbox is
   * open it is the sidebar badge's source, so the badge needs no poll of its
   * own and a decision needs no second request.
   */
  onCount?: (pending: number) => void;
}

/** The live inbox: polls the pending list and sends decisions. */
export function ReviewsInbox({ onOpenFlow, onCount }: ReviewsInboxProps) {
  const [reviews, setReviews] = useState<FlowApproval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  // Read through a ref so a parent that passes a fresh closure does not
  // restart the poll.
  const report = useRef(onCount);
  report.current = onCount;
  const load = useCallback(async () => {
    try {
      const list = await api<FlowApproval[]>('/flows/approvals');
      if (!mounted.current) return;
      setReviews(list);
      report.current?.(list.length);
      setError('');
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The reviews could not be loaded.',
      );
    } finally {
      if (mounted.current) {
        setLoaded(true);
        setNow(Date.now());
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), REVIEWS_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);
  const decide = useCallback<DecideFn>(
    async (
      approvalId: string,
      action: ApprovalAction,
      feedback?: string,
      editedText?: string,
    ) => {
      // The card shows its own "Sending…" and surfaces whatever this throws.
      await api(`/flows/approvals/${approvalId}/decide`, 'POST', {
        action,
        ...(feedback ? { feedback } : {}),
        ...(editedText !== undefined ? { editedText } : {}),
      });
      await load();
    },
    [load],
  );
  return (
    <ReviewsPage
      reviews={reviews}
      loaded={loaded}
      error={error}
      now={now}
      onDecide={decide}
      onOpenFlow={onOpenFlow}
    />
  );
}

export interface FlowRunsActivityProps {
  runs: FlowRunSummary[];
  /** False until the first list arrives. */
  loaded: boolean;
  /**
   * Open a run: the editor opens the flow with that run loaded in its Runs
   * tray, so the row that was clicked is the row that comes up.
   */
  onOpen: (flowId: string, runId: string) => void;
}

/** "Flow runs": the recent runs across every flow, for the activity view. */
export function FlowRunsActivity({
  runs,
  loaded,
  onOpen,
}: FlowRunsActivityProps) {
  const now = Date.now();
  return (
    <section className="flow-reviews flow-run-activity">
      <h2>Flow runs</h2>
      {runs.length > 0 ? (
        <ul>
          {runs.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => onOpen(run.flowId, run.id)}>
                <span className={`flow-run-chip ${run.status}`}>
                  {RUN_STATUS_LABEL[run.status]}
                </span>
                <strong>{run.flowName}</strong>
                <span className="muted">
                  {TRIGGER_LABEL[run.trigger.source]}
                </span>
                <span className="muted">
                  {relativeTime(run.startedAt, now)}
                </span>
                <span className="muted">
                  {formatDuration(runElapsed(run, now))}
                </span>
                <span className="flow-run-activity-steps">
                  {run.completedSteps}/{run.stepCount} steps
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {loaded
            ? 'No flow has run yet. Open a flow and use “Run flow”.'
            : 'Loading flow runs…'}
        </p>
      )}
    </section>
  );
}
