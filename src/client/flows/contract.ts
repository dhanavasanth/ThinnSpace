/**
 * Component contract for the Flows canvas. Each component lives in its own
 * file and is built against these props so the pieces compose without
 * knowing each other's internals.
 */
import type { Dot, WorkspaceState } from '../../shared/types';
import type {
  Flow,
  FlowGraph,
  FlowNode,
  FlowProblem,
  FlowSummary,
  UpstreamRef,
} from '../../shared/flows';

export type { UpstreamRef } from '../../shared/flows';

/** The `data` payload of every React Flow node on the canvas. */
export interface FlowNodeData extends Record<string, unknown> {
  node: FlowNode;
  problems: FlowProblem[];
  /** Resolved for Dot-bound nodes so the card can show the avatar. */
  dot?: Dot;
  /** Resolved Space name for page nodes. */
  spaceName?: string;
  /** Live run state, painted by the editor from the loaded run's steps. */
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
}

export interface FlowEditorProps {
  flowId: string;
  workspace: WorkspaceState;
  /** Return to the Flows list. */
  onBack: () => void;
  /** Ask the app shell to reload workspace state (flow list, names). */
  onRefresh: () => void;
  /** Open a Dot's settings dialog from a node. */
  onEditDot?: (dotId: string) => void;
  /** Tell the shell whether there are unsaved edits (leave-page guard). */
  onDirty: (dirty: boolean) => void;
  /**
   * Called after the canvas's "Run flow" button started a run (the editor
   * starts and tracks runs itself; the button is disabled while the linter
   * reports errors).
   */
  onRun?: () => void;
}

export interface FlowPropertiesProps {
  flow: Flow;
  node: FlowNode;
  graph: FlowGraph;
  workspace: WorkspaceState;
  problems: FlowProblem[];
  upstream: UpstreamRef[];
  /** `typeVersion` is patched by the one-click "Update node" migration. */
  onChange: (
    nodeId: string,
    patch: Partial<Pick<FlowNode, 'label' | 'config' | 'typeVersion'>>,
  ) => void;
  onDuplicate: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
  /**
   * "Next step" '+': opens the step picker filtered to steps that can take
   * this output; the chosen step is wired from it.
   */
  onAddNext: (nodeId: string, port: string) => void;
  onEditDot?: (dotId: string) => void;
}

export interface FlowsHomeProps {
  flows: FlowSummary[];
  workspace: WorkspaceState;
  onOpen: (flowId: string) => void;
  /** Called after a flow was created or deleted so the shell refreshes. */
  onRefresh: () => void;
  /** Bumped by the shell (sidebar '+') to open the new-flow form. */
  createRequested?: number;
}

/** Hash routes used by the app shell. */
export const FLOWS_ROUTE = '#/flows';
export function flowRoute(id: string) {
  return `${FLOWS_ROUTE}/${id}`;
}
