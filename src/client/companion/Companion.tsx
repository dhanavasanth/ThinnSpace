import { X } from 'lucide-react';
import { Mascot } from '../Mascot';
import type { Companion as CompanionModel } from './useCompanion';
import './companion.css';

/**
 * The companion layer: the active Dot's own character, floating over the
 * app and reacting to things that actually happened.
 *
 * It never covers content and never takes focus. The wrapper is
 * pointer-transparent and only the character itself is interactive, so a
 * click always reaches whatever sits underneath.
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
  return (
    <div
      className={`companion anchor-${anchor} is-${state}`}
      style={
        {
          '--glow': glow.color,
          '--glow-soft': glow.soft,
        } as React.CSSProperties
      }
      aria-live="polite"
    >
      <div className="companion-body">
        <span className="companion-trail" aria-hidden="true" />
        <button
          type="button"
          className="companion-figure"
          onClick={onClick}
          title={reason}
          aria-label={`${dot?.name ?? 'Your Dot'}: ${reason}`}
        >
          <Mascot
            identity={dot?.id}
            avatar={dot?.avatar}
            name={dot?.name ?? 'Dot'}
            decorative
          />
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
