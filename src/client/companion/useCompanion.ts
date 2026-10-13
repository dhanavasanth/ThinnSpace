import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dot, SetupStatus } from '../../shared/types';
import { dotGlow, type DotGlow } from '../../shared/dot-colors';

/**
 * One state for the companion, merged from every signal the app already
 * tracks. Nothing here invents activity: each state corresponds to
 * something that genuinely happened, which is what keeps the motion from
 * becoming decoration.
 */
export type CompanionState =
  | 'idle'
  | 'attentive'
  | 'guiding'
  | 'working'
  | 'waiting'
  | 'celebrating'
  | 'thinking'
  | 'speaking'
  | 'waving'
  | 'paused';

/** Highest priority first. The first match wins. */
const ORDER: CompanionState[] = [
  'waving',
  'speaking',
  'thinking',
  'celebrating',
  'waiting',
  'working',
  'guiding',
  'paused',
  'attentive',
  'idle',
];

export interface CompanionSignals {
  /** The Dot whose character and colour the companion wears. */
  dot?: Dot;
  setup?: SetupStatus;
  paused?: boolean;
  /** Pending decisions across every flow; App already polls this. */
  pendingReviews?: number;
  /** A flow run is executing right now. */
  running?: boolean;
  /** Realtime voice phase, when a call is open. */
  voice?: 'listening' | 'speaking' | 'thinking';
  /** The owner is composing a prompt. */
  typing?: boolean;
}

export interface Companion {
  state: CompanionState;
  glow: DotGlow;
  dot?: Dot;
  /** What the companion is reacting to, for the tooltip and aria-label. */
  reason: string;
  /** Where it should sit, so motion means "look here". */
  anchor: 'rest' | 'settings' | 'reviews' | 'composer';
  visible: boolean;
  /** Say hello back when the owner pokes the character. */
  poke: () => void;
  dismiss: () => void;
  restore: () => void;
}

const REASONS: Record<CompanionState, string> = {
  idle: 'Here when you need me',
  attentive: 'Listening',
  guiding: 'Connect a model in Settings to start',
  working: 'A flow is running',
  waiting: 'A decision is waiting on you',
  celebrating: 'That run finished',
  thinking: 'Thinking',
  speaking: 'Speaking',
  waving: 'Hello',
  paused: 'Everything is paused',
};

const ANCHORS: Partial<Record<CompanionState, Companion['anchor']>> = {
  guiding: 'settings',
  waiting: 'reviews',
  attentive: 'composer',
};

const DISMISS_KEY = 'thinnspace-companion-hidden';
/** How long a one-shot reaction shows before falling back. */
const CELEBRATE_MS = 2600;
const WAVE_MS = 1900;

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function useCompanion(signals: CompanionSignals): Companion {
  const [hidden, setHidden] = useState(readDismissed);
  const [celebrating, setCelebrating] = useState(false);
  const [waving, setWaving] = useState(0);
  const wasRunning = useRef(false);

  // A poke is a one-shot wave. Re-poking restarts it rather than stacking.
  useEffect(() => {
    if (!waving) return;
    const timer = setTimeout(() => setWaving(0), WAVE_MS);
    return () => clearTimeout(timer);
  }, [waving]);

  // A run that just finished earns exactly one celebration, never a loop.
  useEffect(() => {
    if (wasRunning.current && !signals.running) {
      setCelebrating(true);
      const timer = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
      return () => clearTimeout(timer);
    }
    wasRunning.current = !!signals.running;
  }, [signals.running]);

  const state = useMemo<CompanionState>(() => {
    const active: Partial<Record<CompanionState, boolean>> = {
      waving: waving > 0,
      speaking: signals.voice === 'speaking',
      thinking: signals.voice === 'thinking',
      celebrating,
      waiting: (signals.pendingReviews ?? 0) > 0,
      working: !!signals.running,
      // Only the blocking part of setup is worth pointing at.
      guiding: !!signals.setup && signals.setup.missing.length > 0,
      paused: !!signals.paused,
      attentive: !!signals.typing || signals.voice === 'listening',
      idle: true,
    };
    return ORDER.find((candidate) => active[candidate]) ?? 'idle';
  }, [
    waving,
    celebrating,
    signals.paused,
    signals.pendingReviews,
    signals.running,
    signals.setup,
    signals.typing,
    signals.voice,
  ]);

  return {
    state,
    glow: dotGlow(signals.dot),
    dot: signals.dot,
    reason: REASONS[state],
    anchor: ANCHORS[state] ?? 'rest',
    visible: !hidden,
    poke: () => setWaving((count) => count + 1),
    dismiss: () => {
      setHidden(true);
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* a companion is not worth failing over */
      }
    },
    restore: () => {
      setHidden(false);
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}
