import { X } from 'lucide-react';
import { Mascot } from '../Mascot';
import {
  COMPANION_POSES,
  companionCharacter,
  poseForState,
  poseSrc,
} from '../../shared/companions';
import type { Companion as CompanionModel } from './useCompanion';
import './companion.css';

/**
 * The companion layer: the active Dot's character, floating over the app
 * and reacting to things that actually happened.
 *
 * It never covers content and never takes focus. The wrapper is
 * pointer-transparent and only the figure itself opts back in, so a click
 * always reaches whatever sits underneath.
 */
export function Companion({
  companion,
  onClick,
}: {
  companion: CompanionModel;
  /** Opens whatever the companion is pointing at. */
  onClick?: () => void;
}) {
  if (!companion.visible) return null;
  const { state, glow, dot, reason, anchor } = companion;
  // Full-body art has a real silhouette; a bust would read as a tile, so a
  // Dot without a character stays small and keeps to the corner.
  const character = companionCharacter(dot?.avatar);
  const pose = poseForState(state);
  return (
    <div
      className={`companion anchor-${anchor} is-${state} ${
        character ? 'has-character' : 'bust-only'
      }`}
      style={
        {
          '--glow': glow.color,
          '--glow-soft': glow.soft,
          '--figure-height': `${character?.height ?? 72}px`,
        } as React.CSSProperties
      }
      aria-live="polite"
    >
      <div className="companion-body">
        <span className="companion-trail" aria-hidden="true" />
        <button
          type="button"
          className="companion-figure"
          onClick={onClick ?? companion.poke}
          title={reason}
          aria-label={`${dot?.name ?? 'Your Dot'}: ${reason}`}
        >
          {character ? (
            /*
             * Every pose is mounted and crossfaded by opacity. Swapping one
             * src would flash on first use and pop on every change; opacity
             * on already-decoded layers stays on the compositor and glides.
             */
            <span className="companion-poses">
              {COMPANION_POSES.map((name) => (
                <img
                  key={name}
                  className={`companion-pose ${name === pose ? 'active' : ''}`}
                  src={poseSrc(character, name)}
                  alt=""
                  draggable={false}
                  decoding="async"
                  loading="eager"
                />
              ))}
            </span>
          ) : (
            <Mascot
              identity={dot?.id}
              avatar={dot?.avatar}
              name={dot?.name ?? 'Dot'}
              decorative
            />
          )}
        </button>
        <button
          type="button"
          className="companion-dismiss"
          onClick={companion.dismiss}
          aria-label="Hide the companion"
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
