/**
 * Client state for running a flow: the run shown in the tray, the run
 * history, pending reviews across flows, and the 1 s poll that keeps an
 * active run fresh (backing off while the network is down, stopping on
 * unmount). Built against the REST contract in src/shared/flow-runs.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  runIsActive,
  type ApprovalAction,
  type FlowApproval,
  type FlowRun,
  type FlowRunSummary,
} from '../../shared/flow-runs';

/** Poll cadence while a run is active, and the ceiling while retrying. */
export const POLL_MS = 1000;
export const POLL_CAP_MS = 30_000;
/** Pending reviews across flows are refreshed on this cadence. */
export const REVIEWS_MS = 30_000;

/** 1 s, 2 s, 4 s … capped, after `failures` consecutive network errors. */
export function pollDelay(failures: number, base = POLL_MS, cap = POLL_CAP_MS) {
  return Math.min(cap, base * 2 ** Math.max(0, failures));
}

export interface FlowRunState {
  /** The run loaded in the tray (just started, or picked from history). */
  run: FlowRun | null;
  /** Newest first. */
  runs: FlowRunSummary[];
  /** True once the first history fetch has answered. */
  runsLoaded: boolean;
  /** Pending reviews across every flow (header badge). */
  reviews: FlowApproval[];
  /** A request (start, stop, decide, load) is in flight. */
  busy: boolean;
  /** Last network or server failure, shown inline; '' when clear. */
  error: string;
  active: boolean;
  start: (input: string, fields?: Record<string, unknown>) => Promise<FlowRun>;
  cancel: () => Promise<void>;
  decide: (
    approvalId: string,
    action: ApprovalAction,
    feedback?: string,
    editedText?: string,
  ) => Promise<void>;
  /** Loads a previous run into the tray. */
  load: (runId: string) => Promise<void>;
  /** Drops the loaded run (and its painted statuses). */
  dismiss: () => void;
  refreshRuns: () => Promise<void>;
  clearError: () => void;
}

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

export function useFlowRun(flowId: string): FlowRunState {
  const [run, setRun] = useState<FlowRun | null>(null);
  const [runs, setRuns] = useState<FlowRunSummary[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [reviews, setReviews] = useState<FlowApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const runRef = useRef(run);
  runRef.current = run;
  // Bumped by every mutation (start, stop, decide, load) so a poll that was
  // already in flight cannot paint the pre-mutation snapshot over its result.
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const list = await api<FlowRunSummary[]>(`/flows/${flowId}/runs`);
      if (!mounted.current) return;
      setRuns(list);
      setRunsLoaded(true);
    } catch (cause) {
      if (mounted.current)
        setError(message(cause, 'Could not load the run history.'));
    }
  }, [flowId]);
  const refreshReviews = useCallback(async () => {
    try {
      const list = await api<FlowApproval[]>('/flows/approvals');
      if (mounted.current) setReviews(list);
    } catch {
      // The badge is a convenience; the tray shows the run's own approvals.
    }
  }, []);

  // History and the reviews badge on mount; the badge on a slow timer too.
  useEffect(() => {
    void refreshRuns();
    void refreshReviews();
    const timer = setInterval(() => void refreshReviews(), REVIEWS_MS);
    return () => clearInterval(timer);
  }, [refreshRuns, refreshReviews]);

  // Poll the loaded run while it is active. A new run id or a change of
  // activity restarts the loop; unmount (or dismiss) aborts it.
  const runId = run?.id ?? null;
  const active = !!run && runIsActive(run.status);
  useEffect(() => {
    if (!runId || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      const seen = generation.current;
      try {
        const next = await api<FlowRun>(
          `/flows/runs/${runId}`,
          'GET',
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (seen !== generation.current) {
          // A mutation answered meanwhile; its result is newer than ours.
          timer = setTimeout(() => void tick(), POLL_MS);
          return;
        }
        failures = 0;
        setError('');
        setRun(next);
        if (!runIsActive(next.status)) {
          void refreshRuns();
          void refreshReviews();
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        failures += 1;
        setError(message(cause, 'Lost contact with the server; retrying.'));
      }
      timer = setTimeout(() => void tick(), pollDelay(failures));
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, active, refreshRuns, refreshReviews]);

  const start = useCallback<FlowRunState['start']>(
    async (input, fields) => {
      generation.current += 1;
      setBusy(true);
      setError('');
      try {
        const created = await api<FlowRun>(`/flows/${flowId}/runs`, 'POST', {
          input,
          ...(fields && Object.keys(fields).length ? { fields } : {}),
        });
        if (mounted.current) {
          setRun(created);
          void refreshRuns();
        }
        return created;
      } catch (cause) {
        if (mounted.current)
          setError(message(cause, 'The run could not be started.'));
        throw cause;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [flowId, refreshRuns],
  );
  const cancel = useCallback(async () => {
    const current = runRef.current;
    if (!current || !runIsActive(current.status)) return;
    generation.current += 1;
    setBusy(true);
    try {
      const next = await api<FlowRun>(
        `/flows/runs/${current.id}/cancel`,
        'POST',
      );
      if (!mounted.current) return;
      setRun(next);
      void refreshRuns();
    } catch (cause) {
      if (mounted.current)
        setError(message(cause, 'The run could not be stopped.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refreshRuns]);
  const decide = useCallback<FlowRunState['decide']>(
    async (approvalId, action, feedback, editedText) => {
      generation.current += 1;
      setBusy(true);
      setError('');
      try {
        const next = await api<FlowRun>(
          `/flows/approvals/${approvalId}/decide`,
          'POST',
          {
            action,
            ...(feedback ? { feedback } : {}),
            ...(editedText !== undefined ? { editedText } : {}),
          },
        );
        if (!mounted.current) return;
        // The decision may belong to a run other than the loaded one.
        if (!runRef.current || runRef.current.id === next.id) setRun(next);
        void refreshReviews();
      } catch (cause) {
        if (mounted.current)
          setError(message(cause, 'The decision could not be sent.'));
        throw cause;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refreshReviews],
  );
  const load = useCallback(async (id: string) => {
    generation.current += 1;
    setBusy(true);
    setError('');
    try {
      const next = await api<FlowRun>(`/flows/runs/${id}`);
      if (mounted.current) setRun(next);
    } catch (cause) {
      if (mounted.current)
        setError(message(cause, 'That run could not be loaded.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const dismiss = useCallback(() => {
    setRun(null);
    setError('');
  }, []);
  const clearError = useCallback(() => setError(''), []);

  return {
    run,
    runs,
    runsLoaded,
    reviews,
    busy,
    error,
    active,
    start,
    cancel,
    decide,
    load,
    dismiss,
    refreshRuns,
    clearError,
  };
}
