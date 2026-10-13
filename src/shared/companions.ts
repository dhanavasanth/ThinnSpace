/**
 * Companion characters.
 *
 * A Dot's avatar is a bust: head and shoulders, cropped square. That reads
 * as a tile when it floats over the page, which is why the companion needs
 * its own full-body art with a real silhouette. A Dot without one falls
 * back to its bust, which still works but stays small and in the corner.
 *
 * Each character ships a small set of poses. CSS can move a figure but it
 * cannot re-pose one, so a wave has to be drawn, not simulated. Every pose
 * is drawn on the same canvas with the head in the same place, which is
 * what lets the app crossfade between them without the face jumping.
 */
export const COMPANION_POSES = [
  'idle',
  'wave',
  'point',
  'think',
  'cheer',
] as const;
export type CompanionPose = (typeof COMPANION_POSES)[number];

export interface CompanionCharacter {
  /** Served from public/companions/<id>-<pose>.png, transparent, full body. */
  id: string;
  /** Rendered height in pixels at rest. */
  height: number;
}

const CHARACTERS: Record<string, CompanionCharacter> = {
  vasanth: { id: 'vasanth', height: 190 },
};

/** The full-body character for a Dot, when one has been drawn. */
export function companionCharacter(
  avatar?: string | null,
): CompanionCharacter | undefined {
  return avatar ? CHARACTERS[avatar] : undefined;
}

export function poseSrc(character: CompanionCharacter, pose: CompanionPose) {
  return `/companions/${character.id}-${pose}.png`;
}

/**
 * Which drawing each state wears. Several states share a pose on purpose:
 * a new drawing only earns its weight when it reads differently.
 */
const POSE_FOR: Record<string, CompanionPose> = {
  idle: 'idle',
  attentive: 'idle',
  paused: 'idle',
  speaking: 'wave',
  waving: 'wave',
  guiding: 'point',
  waiting: 'point',
  working: 'think',
  thinking: 'think',
  celebrating: 'cheer',
};

export function poseForState(state: string): CompanionPose {
  return POSE_FOR[state] ?? 'idle';
}
