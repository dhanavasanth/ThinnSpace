/**
 * Companion characters.
 *
 * A Dot's avatar is a bust: head and shoulders, cropped square. That reads
 * as a tile when it floats over the page, which is why the companion needs
 * its own full-body art with a real silhouette. A Dot without one falls
 * back to its bust, which still works but stays small and in the corner.
 */
export interface CompanionCharacter {
  /** Served from public/companions/<id>.png, transparent, full body. */
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

export function companionSrc(character: CompanionCharacter) {
  return `/companions/${character.id}.png`;
}
