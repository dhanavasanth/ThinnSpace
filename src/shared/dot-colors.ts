/**
 * Each Dot gets a stable accent colour. One token drives the companion's
 * glow, its trail and any future rig tint, so they can never drift apart.
 *
 * Bundled characters use the colour they are actually drawn in. Uploaded
 * avatars have no colour we can read without decoding the image, so they
 * take a stable pick from the Dot's id: the same Dot always looks the same.
 */
export interface DotGlow {
  /** Core colour, used for the glow and the trail. */
  color: string;
  /** Lighter partner, used for the outer falloff. */
  soft: string;
}

const BUILTIN: Record<string, DotGlow> = {
  blue: { color: '#6f86d6', soft: '#a9b8ef' },
  mint: { color: '#4fbfa8', soft: '#90dfd0' },
  orange: { color: '#ff8a4c', soft: '#ffc19b' },
  purple: { color: '#9b7fd4', soft: '#c6b4ec' },
  vasanth: { color: '#ff6a1f', soft: '#ffb48a' },
};

/** Fallback palette for uploaded avatars, picked by id so it never flickers. */
const PALETTE: DotGlow[] = [
  { color: '#ff6a1f', soft: '#ffb48a' },
  { color: '#6f86d6', soft: '#a9b8ef' },
  { color: '#4fbfa8', soft: '#90dfd0' },
  { color: '#9b7fd4', soft: '#c6b4ec' },
  { color: '#e0607e', soft: '#f2a6b8' },
  { color: '#d9a62e', soft: '#f0d28a' },
];

function hash(value: string) {
  let total = 0;
  for (const character of value)
    total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return total;
}

/** The accent for a Dot, from its character when known, else from its id. */
export function dotGlow(
  dot: { id: string; avatar?: string | null } | undefined,
): DotGlow {
  if (!dot) return PALETTE[0];
  const builtin = dot.avatar ? BUILTIN[dot.avatar] : undefined;
  return builtin ?? PALETTE[hash(dot.id) % PALETTE.length];
}
