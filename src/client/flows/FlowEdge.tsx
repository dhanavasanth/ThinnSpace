/**
 * A connection: a neutral 2px bezier with an arrowhead at the target. It turns
 * orange (with a subtle gradient) when hovered or selected, carries a label
 * pill near its source for multi-output nodes, and shows a delete button at
 * its midpoint on hover. Colours live in flow-cards.css so the dark theme can
 * flip them; only the per-edge gradient reference is inline.
 */
import { memo, useContext, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useNodesData,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { X } from 'lucide-react';
import { PORT_COLORS, nodeOutputs } from '../../shared/flows';
import { EditorActionsContext, type EditorNode } from './FlowNodeCard';

export type EditorEdge = Edge<Record<string, unknown>, 'flow'>;

/** Mirrors React Flow's bezier control points (curvature 0.25). */
function controlOffset(distance: number) {
  return distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance);
}
function control(
  pos: Position,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  switch (pos) {
    case Position.Left:
      return [x1 - controlOffset(x1 - x2), y1];
    case Position.Right:
      return [x1 + controlOffset(x2 - x1), y1];
    case Position.Top:
      return [x1, y1 - controlOffset(y1 - y2)];
    default:
      return [x1, y1 + controlOffset(y2 - y1)];
  }
}
/** Where the label pill sits: a little way along the curve from the source,
 *  or the midpoint when the edge is too short for that to clear the card.
 *  48px clears a 96px square's half-width plus the port tail; the editor's
 *  standard spacing (320px columns) puts the t=0.3 point well past it. */
const PILL_T = 0.3;
const PILL_MIN_DISTANCE = 48;
/** When the pill has to sit at the midpoint, the delete button moves up. */
const DELETE_LIFT = 16;
export function pillPoint(
  sx: number,
  sy: number,
  sp: Position,
  tx: number,
  ty: number,
  tp: Position,
  mid: [number, number],
): { x: number; y: number; atMid: boolean } {
  const [c1x, c1y] = control(sp, sx, sy, tx, ty);
  const [c2x, c2y] = control(tp, tx, ty, sx, sy);
  const t = PILL_T;
  const u = 1 - t;
  const x =
    u ** 3 * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * tx;
  const y =
    u ** 3 * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * ty;
  if (Math.hypot(x - sx, y - sy) < PILL_MIN_DISTANCE)
    return { x: mid[0], y: mid[1], atMid: true };
  return { x, y, atMid: false };
}

export const FlowEdge = memo(function FlowEdge({
  id,
  source,
  sourceHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps<EditorEdge>) {
  const actions = useContext(EditorActionsContext);
  const sourceNode = useNodesData<EditorNode>(source);
  const [hovered, setHovered] = useState(false);
  const outputs = sourceNode ? nodeOutputs(sourceNode.data.node) : [];
  const out =
    outputs.length > 1
      ? outputs.find((port) => port.id === sourceHandleId)
      : undefined;
  const label = out?.label ?? '';
  const [path, midX, midY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = selected || hovered;
  const gradient = `fedge-grad-${id}`;
  const marker = `fedge-arrow-${id}`;
  const pill = label
    ? pillPoint(
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        [midX, midY],
      )
    : null;
  const enter = () => setHovered(true);
  const leave = () => setHovered(false);
  return (
    <g
      className={`fedge${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <defs>
        {active && (
          <linearGradient
            id={gradient}
            gradientUnits="userSpaceOnUse"
            x1={sourceX}
            y1={sourceY}
            x2={targetX}
            y2={targetY}
          >
            <stop offset="0%" className="fedge-stop-a" />
            <stop offset="100%" className="fedge-stop-b" />
          </linearGradient>
        )}
        <marker
          id={marker}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path className="fedge-arrow" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${marker})`}
        interactionWidth={18}
        style={active ? { stroke: `url(#${gradient})` } : undefined}
      />
      <EdgeLabelRenderer>
        {pill && (
          <div
            className={`fedge-label nodrag nopan${active ? ' active' : ''}${pill.atMid ? ' at-mid' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${pill.x}px, ${pill.y}px)`,
            }}
            onMouseEnter={enter}
            onMouseLeave={leave}
          >
            <span className="fedge-pill">
              <i
                className="fedge-pill-dot"
                style={{ background: PORT_COLORS[out?.kind ?? 'any'] }}
              />
              {label}
            </span>
          </div>
        )}
        <div
          className={`fedge-label at-mid nodrag nopan${active ? ' active' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${midX}px, ${
              pill?.atMid ? midY - DELETE_LIFT : midY
            }px)`,
          }}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <button
            type="button"
            className="fedge-delete"
            aria-label="Remove connection"
            title="Remove connection"
            tabIndex={active ? 0 : -1}
            onClick={() => actions?.removeEdge(id)}
          >
            <X size={11} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </g>
  );
});
