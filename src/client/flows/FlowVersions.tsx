/**
 * Editor chrome around the canvas: the 56px header, the Delete confirm
 * dialog, the Versions drawer, the Problems tray, the Help > Shortcuts
 * sheet, and the loading/error screens.
 */
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Ellipsis,
  Keyboard,
  ListOrdered,
  Redo2,
  RotateCcw,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { api } from '../api';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  nodeFields,
  nodeLabel,
  type Flow,
  type FlowGraph,
  type FlowNode,
  type FlowProblem,
  type FlowStatus,
  type FlowVersion,
} from '../../shared/flows';
import type { WorkspaceState } from '../../shared/types';
import { flowRoute } from './contract';
import type { SaveState } from './flow-history';
import { relativeTime } from './format';

export { relativeTime } from './format';

/* ---------- header ---------- */

export const FLOW_STATUS_LABEL: Record<FlowStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  changed: 'Published · unpublished changes',
};
const STATUS_TITLE: Record<FlowStatus, string> = {
  draft: 'Not published yet. Triggers run only once the flow is published.',
  published: 'Triggers run this version.',
  changed:
    'Triggers keep running the published version until you publish again.',
};

/** The grey / green / amber lifecycle chip shown in the header. */
export function FlowStatusChip({ status }: { status: FlowStatus }) {
  return (
    <span
      className={`flow-status-chip ${status}`}
      title={STATUS_TITLE[status]}
      data-testid="flow-status"
    >
      <i aria-hidden="true" />
      {FLOW_STATUS_LABEL[status]}
    </span>
  );
}

export interface FlowHeaderProps {
  name: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  /** Re-sends the last failed save (the chip offers it on an error). */
  onRetry: () => void;
  dirty: boolean;
  status: FlowStatus;
  /** Used for the default version name ("Published v<revision>"). */
  revision: number;
  problems: FlowProblem[];
  problemsOpen: boolean;
  onToggleProblems: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
  onValidate: () => void;
  /** Toggles the run-order overlay; the editor decides whether it may open. */
  previewing: boolean;
  onPreview: () => void;
  /** Resolves once the server accepted the publish; rejects with its message. */
  onPublish: (label: string) => Promise<void>;
  onUnpublish: () => void;
  onShortcuts: () => void;
  onDuplicate: () => void;
  onVersions: () => void;
  onExport: () => void;
  onDelete: () => void;
  /**
   * Called with the flow an "Import JSON" created. Left out, the header
   * navigates to the new flow itself.
   */
  onImported?: (flow: Flow) => void;
  /** Re-links an imported flow's Dot and Space ids; fetched when absent. */
  workspace?: WorkspaceState;
}

/** Why Publish is disabled right now, or undefined when it may be clicked. */
function publishBlocker(
  errors: number,
  dirty: boolean,
  saveState: SaveState,
): string | undefined {
  if (errors)
    return `Fix ${errors === 1 ? 'the problem' : `${errors} problems`} before publishing.`;
  if (saveState.status === 'saving') return 'Wait for the save to finish.';
  if (saveState.status === 'conflict')
    return 'Reload the flow before publishing.';
  if (dirty || saveState.status === 'error')
    return 'Save the flow before publishing.';
  return undefined;
}

function PublishPopover({
  defaultLabel,
  onPublish,
  onClose,
}: {
  defaultLabel: string;
  onPublish: (label: string) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = label.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPublish(value);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not publish.');
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flow-popover-backdrop" onPointerDown={onClose} />
      <form
        className="flow-publish-popover"
        role="dialog"
        aria-label="Publish this flow"
        onSubmit={(event) => void submit(event)}
      >
        <strong>Publish this flow</strong>
        <p className="muted">
          Triggers run the published version. You can keep editing the draft
          afterwards.
        </p>
        <label className="field-label" htmlFor="flow-publish-label">
          Version name
        </label>
        <input
          id="flow-publish-label"
          autoFocus
          maxLength={60}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        {error && (
          <p className="error flow-publish-error" role="alert">
            {error}
          </p>
        )}
        <div className="flow-publish-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!label.trim() || busy}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </form>
    </>
  );
}

export function FlowHeader({
  name,
  onRename,
  saveState,
  onRetry,
  dirty,
  status,
  revision,
  problems,
  problemsOpen,
  onToggleProblems,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onBack,
  onValidate,
  previewing,
  onPreview,
  onPublish,
  onUnpublish,
  onShortcuts,
  onDuplicate,
  onVersions,
  onExport,
  onDelete,
  onImported,
  workspace,
}: FlowHeaderProps) {
  const importer = useFlowImport({ workspace, onCreated: onImported });
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) =>
      event.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  const errors = problems.filter((p) => p.level === 'error').length;
  const blocker = publishBlocker(errors, dirty, saveState);
  const failed =
    saveState.status === 'error' || saveState.status === 'conflict';
  // Only failures are announced; "Saving…" and the ticking clock stay visual.
  const announcement =
    saveState.status === 'conflict'
      ? 'This flow changed elsewhere. Reload to pick up the latest version.'
      : saveState.status === 'error'
        ? `Could not save. ${saveState.message}`
        : '';
  const chip =
    saveState.status === 'saving'
      ? { text: 'Saving…', tone: 'muted', title: undefined }
      : saveState.status === 'conflict'
        ? { text: 'Changed elsewhere', tone: 'error', title: undefined }
        : saveState.status === 'error'
          ? { text: 'Could not save', tone: 'error', title: saveState.message }
          : dirty
            ? { text: 'Unsaved changes', tone: 'warn', title: undefined }
            : {
                text: 'Saved',
                tone: 'ok',
                title: new Date(saveState.at).toLocaleString(),
                when: relativeTime(saveState.at, clock),
              };
  const menuItem = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'danger' : undefined}
      onClick={() => {
        setMenuOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <header className="flow-header">
      <button
        type="button"
        className="icon-button"
        aria-label="Back to flows"
        onClick={onBack}
      >
        <ChevronLeft size={18} />
      </button>
      {editing ? (
        <input
          className="flow-name-input"
          aria-label="Flow name"
          autoFocus
          defaultValue={name}
          maxLength={80}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            setEditing(false);
            onRename(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="flow-name"
          title="Rename flow"
          onClick={() => setEditing(true)}
        >
          {name}
        </button>
      )}
      <span className={`flow-save-chip ${chip.tone}`} title={chip.title}>
        {chip.text}
        {'when' in chip && (
          <span className="flow-save-when" aria-hidden="true">
            {' '}
            {chip.when}
          </span>
        )}
        {saveState.status === 'error' && (
          <button
            type="button"
            className="flow-save-retry"
            onClick={onRetry}
            title={saveState.message}
          >
            Retry
          </button>
        )}
      </span>
      <span className="sr-only" aria-live="polite">
        {failed ? announcement : ''}
      </span>
      <div className="flow-header-spacer" />
      <FlowStatusChip status={status} />
      <button
        type="button"
        className={`flow-problems-pill ${errors ? 'error' : problems.length ? 'warning' : 'ok'}`}
        aria-pressed={problemsOpen}
        onClick={onToggleProblems}
      >
        {errors ? (
          <CircleAlert size={13} />
        ) : problems.length ? (
          <TriangleAlert size={13} />
        ) : (
          <Check size={13} />
        )}
        {problems.length
          ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`
          : 'No problems'}
      </button>
      <span className="flow-header-divider" aria-hidden="true" />
      <div className="flow-header-group">
        <button
          type="button"
          className="icon-button"
          aria-label="Undo"
          title="Undo (⌘Z)"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Redo"
          title="Redo (⌘⇧Z)"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={15} />
        </button>
      </div>
      <button
        type="button"
        className="flow-validate-button"
        onClick={onValidate}
      >
        Validate
      </button>
      <button
        type="button"
        className={`flow-preview-button${previewing ? ' active' : ''}`}
        aria-pressed={previewing}
        title={
          previewing
            ? 'Exit the run-order preview (Esc)'
            : 'Number the steps in the order the engine will run them'
        }
        onClick={onPreview}
      >
        <ListOrdered size={14} />
        {previewing ? 'Exit preview' : 'Preview run order'}
      </button>
      <div className="flow-menu-wrap">
        <span className="flow-disabled-wrap" title={blocker}>
          <button
            type="button"
            className="primary"
            disabled={!!blocker}
            aria-haspopup="dialog"
            aria-expanded={publishOpen}
            onClick={() => setPublishOpen((open) => !open)}
          >
            Publish
          </button>
        </span>
        {publishOpen && (
          <PublishPopover
            defaultLabel={`Published v${revision}`}
            onPublish={onPublish}
            onClose={() => setPublishOpen(false)}
          />
        )}
      </div>
      <button
        type="button"
        className="icon-button flow-shortcuts-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        onClick={onShortcuts}
      >
        <Keyboard size={16} />
      </button>
      <div className="flow-menu-wrap">
        <button
          type="button"
          className="icon-button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Ellipsis size={16} />
        </button>
        {menuOpen && (
          <>
            <div
              className="flow-popover-backdrop"
              onPointerDown={() => setMenuOpen(false)}
            />
            <div className="flow-menu" role="menu">
              {menuItem('Duplicate flow', onDuplicate)}
              {menuItem('Versions', onVersions)}
              {menuItem('Export JSON', onExport)}
              {menuItem('Import JSON', importer.begin)}
              {status !== 'draft' && menuItem('Unpublish', onUnpublish)}
              {menuItem('Delete flow', onDelete, true)}
            </div>
          </>
        )}
      </div>
      {importer.element}
    </header>
  );
}

/* ---------- confirm dialog ---------- */

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** Rejections are shown inline; the dialog stays open. */
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

/** A small modal confirm (Delete flow); Cancel starts focused, Esc cancels. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus lands on Cancel once, when the dialog opens; the Escape listener
  // below re-registers with its callback and must not pull focus back.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onCancel]);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Something went wrong.',
      );
      setBusy(false);
    }
  };
  return (
    <div className="flow-sheet-backdrop" onPointerDown={onCancel}>
      <div
        className="flow-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="flow-confirm-title"
        aria-describedby="flow-confirm-body"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <strong id="flow-confirm-title">{title}</strong>
        <p id="flow-confirm-body" className="muted">
          {body}
        </p>
        {error && (
          <p className="error flow-confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="flow-confirm-actions">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- loading and error screens ---------- */

export function FlowLoading() {
  return (
    <div className="flow-editor loading" aria-busy="true">
      <div className="flow-skeleton-header" />
      <div className="flow-body">
        <div className="flow-skeleton-canvas" />
      </div>
    </div>
  );
}
export function FlowLoadError({
  message,
  onRetry,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flow-editor">
      <div className="flow-state" role="alert">
        <CircleAlert size={22} />
        <p>{message}</p>
        <div>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
          <button type="button" onClick={onBack}>
            Back to flows
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- versions drawer ---------- */

const SOURCE_LABEL: Record<FlowVersion['source'], string> = {
  autosave: 'Autosave',
  named: 'Named',
  restore: 'Restored',
};

export interface FlowVersionsProps {
  flowId: string;
  open: boolean;
  onClose: () => void;
  /** Flushes unsaved edits, restores, and reloads the flow. */
  onRestore: (versionId: string) => Promise<void>;
}

export function FlowVersions({
  flowId,
  open,
  onClose,
  onRestore,
}: FlowVersionsProps) {
  const [versions, setVersions] = useState<FlowVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      setVersions(await api<FlowVersion[]>(`/flows/${flowId}/versions`));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not load versions.',
      );
    }
  };
  useEffect(() => {
    if (!open) {
      setVersions(null);
      return;
    }
    let cancelled = false;
    setError(null);
    api<FlowVersion[]>(`/flows/${flowId}/versions`)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setError(null);
      })
      .catch(
        (cause) =>
          !cancelled &&
          setError(
            cause instanceof Error ? cause.message : 'Could not load versions.',
          ),
      );
    return () => {
      cancelled = true;
    };
  }, [open, flowId]);
  if (!open) return null;
  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Something went wrong.',
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <aside className="flow-drawer" role="dialog" aria-label="Versions">
      <header>
        <strong>Versions</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Close versions"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <form
        className="flow-drawer-name"
        onSubmit={(event) => {
          event.preventDefault();
          const value = label.trim();
          if (!value) return;
          void run('name', async () => {
            await api<FlowVersion>(`/flows/${flowId}/versions`, 'POST', {
              label: value,
            });
            setLabel('');
            await load();
          });
        }}
      >
        <input
          aria-label="Version name"
          placeholder="Name this version"
          maxLength={60}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button
          type="submit"
          className="primary"
          disabled={!label.trim() || busy !== null}
        >
          Save
        </button>
      </form>
      {error && (
        <p className="error flow-drawer-error" role="alert">
          {error}
        </p>
      )}
      <div className="flow-drawer-list">
        {versions === null && !error && (
          <p className="muted flow-list-empty">Loading…</p>
        )}
        {versions?.length === 0 && (
          <p className="muted flow-list-empty">
            Versions appear here as the flow is saved.
          </p>
        )}
        {versions?.map((version) => (
          <div className="flow-version" key={version.id}>
            <div className="flow-version-text">
              <strong>{version.label ?? 'Autosave'}</strong>
              <small className="muted">
                {SOURCE_LABEL[version.source]} ·{' '}
                <time
                  dateTime={new Date(version.createdAt).toISOString()}
                  title={new Date(version.createdAt).toLocaleString()}
                >
                  {relativeTime(version.createdAt)}
                </time>
              </small>
            </div>
            <button
              type="button"
              disabled={busy !== null}
              aria-label={`Restore ${version.label ?? 'this autosave'}`}
              onClick={() =>
                void run(version.id, async () => {
                  await onRestore(version.id);
                  await load();
                })
              }
            >
              <RotateCcw size={12} />
              {busy === version.id ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

/* ---------- problems tray ---------- */

export interface ProblemsTrayProps {
  problems: FlowProblem[];
  nodes: FlowNode[];
  onSelect: (problem: FlowProblem) => void;
  onClose: () => void;
}

export function ProblemsTray({
  problems,
  nodes,
  onSelect,
  onClose,
}: ProblemsTrayProps) {
  const names = new Map(nodes.map((node) => [node.id, nodeLabel(node)]));
  const errors = problems.filter((problem) => problem.level === 'error');
  return (
    <section className="flow-problems" aria-label="Problems">
      <header>
        <strong>
          {problems.length === 0
            ? 'No problems'
            : `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`}
        </strong>
        {problems.length > 0 && (
          <span className="muted">
            {errors.length} must be fixed before publishing
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Close problems"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      {problems.length === 0 ? (
        <p className="flow-problems-empty">
          <CircleCheck size={14} /> This flow is ready.
        </p>
      ) : (
        <ul>
          {problems.map((problem, index) => (
            <li
              key={`${problem.code}-${problem.nodeId ?? problem.edgeId ?? ''}-${index}`}
            >
              <button
                type="button"
                className={`flow-problem ${problem.level}`}
                onClick={() => onSelect(problem)}
              >
                {problem.level === 'error' ? (
                  <CircleAlert size={13} />
                ) : (
                  <TriangleAlert size={13} />
                )}
                <span>{problem.message}</span>
                {problem.nodeId && (
                  <small className="muted">{names.get(problem.nodeId)}</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- shortcuts sheet ---------- */

const SHORTCUTS: [keys: string, action: string][] = [
  ['/  ·  ⌘ K', 'Open the step picker'],
  ['↑ ↓  ·  ⏎', 'In the picker: move through steps · add the highlighted one'],
  ['⌫  ·  ←', 'In the picker: back to all categories'],
  ['⌘ S', 'Save now'],
  ['⌘ Z  ·  ⌘ ⇧ Z', 'Undo · redo'],
  ['⌘ A', 'Select every step'],
  ['⌘ C  ·  ⌘ V  ·  ⌘ D', 'Copy · paste · duplicate'],
  ['⌘ .', 'Collapse or expand the selected steps'],
  ['⌘ G', 'Tidy up the layout'],
  ['⌫', 'Delete the selection'],
  ['Arrows  ·  ⇧ Arrows', 'Nudge by 10px · 50px'],
  ['F2  ·  double-click', 'Rename a step'],
  ['1  ·  0', 'Fit the flow · zoom to 100%'],
  ['Drag  ·  scroll', 'Pan the canvas'],
  ['⇧ drag  ·  ⇧ click', 'Marquee select · add to selection'],
  ['Right-click canvas', 'Add a step here'],
  ['Esc', 'Close the picker, panel, popover or run-order preview'],
];

export function ShortcutsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const show = (keys: string) => (mac ? keys : keys.replace(/⌘/g, 'Ctrl'));
  return (
    <div className="flow-sheet-backdrop" onPointerDown={onClose}>
      <div
        className="flow-sheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>Keyboard shortcuts</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="Close shortcuts"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <dl>
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys}>
              <dt>
                <kbd>{show(keys)}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* ---------- a small dialog, and importing a flow from a file ---------- */

export interface FlowDialogProps {
  title: string;
  children: ReactNode;
  /** Omitted for a message that only needs dismissing. */
  confirmLabel?: string;
  busyLabel?: string;
  danger?: boolean;
  /** A rejection is shown inline and the dialog stays open. */
  onConfirm?: () => Promise<void> | void;
  onClose: () => void;
  closeLabel?: string;
}

/**
 * The confirm dialog's shell with a free-form body, shared by the import
 * summary, its error message and the webhook-token warning.
 */
export function FlowDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  danger,
  onConfirm,
  onClose,
  closeLabel = 'Cancel',
}: FlowDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);
  const confirm = async () => {
    if (busy || !onConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Something went wrong.',
      );
      setBusy(false);
    }
  };
  return (
    <div className="flow-sheet-backdrop" onPointerDown={onClose}>
      <div
        className="flow-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="flow-dialog-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <strong id="flow-dialog-title">{title}</strong>
        <div className="flow-dialog-body">{children}</div>
        {error && (
          <p className="error flow-confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="flow-confirm-actions">
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            disabled={busy}
          >
            {onConfirm ? closeLabel : 'Close'}
          </button>
          {onConfirm && (
            <button
              type="button"
              className={danger ? 'danger' : 'primary'}
              onClick={() => void confirm()}
              disabled={busy}
            >
              {busy ? (busyLabel ?? 'Working…') : (confirmLabel ?? 'Confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A reference an import had to drop, because this workspace has no such id. */
export interface ClearedRef {
  /** The step the field belongs to. */
  node: string;
  /** The field's label ("Dot", "Space"). */
  field: string;
  /** The name the exporting workspace recorded, when the file carried one. */
  name?: string;
}
/** A reference matched to a Dot or Space of this workspace by its name. */
export interface RelinkedRef {
  node: string;
  field: string;
  /** The name both workspaces agree on. */
  name: string;
}
/** What `relinkGraph` did to a parsed file. */
export interface RelinkResult {
  cleared: ClearedRef[];
  relinked: RelinkedRef[];
}
/** A file that parsed and was re-linked against this workspace. */
export interface StagedImport extends RelinkResult {
  name: string;
  description: string;
  graph: FlowGraph;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads an exported `{name, description, graph}` file. Throws an Error whose
 * message is the sentence to show the person, so every refusal explains
 * itself rather than failing later on the server.
 */
export function parseFlowFile(
  text: string,
): Pick<StagedImport, 'name' | 'description' | 'graph'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON.');
  }
  if (!isRecord(parsed)) throw new Error('That file does not describe a flow.');
  const graph = parsed.graph;
  if (
    !isRecord(graph) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    throw new Error(
      'That file has no flow graph. Export a flow to see the shape this expects.',
    );
  if (graph.schema !== 1)
    throw new Error(
      `This file uses graph schema ${String(graph.schema)}; this version reads schema 1.`,
    );
  if (!graph.nodes.length) throw new Error('That flow has no steps.');
  if (graph.nodes.length > FLOW_LIMITS.nodes)
    throw new Error(
      `That flow has ${graph.nodes.length} steps; the limit is ${FLOW_LIMITS.nodes}.`,
    );
  if (graph.edges.length > FLOW_LIMITS.edges)
    throw new Error(
      `That flow has ${graph.edges.length} connections; the limit is ${FLOW_LIMITS.edges}.`,
    );
  const unknown = new Set<string>();
  for (const node of graph.nodes) {
    if (
      !isRecord(node) ||
      typeof node.id !== 'string' ||
      typeof node.type !== 'string' ||
      typeof node.typeVersion !== 'number' ||
      !isRecord(node.position) ||
      typeof node.position.x !== 'number' ||
      typeof node.position.y !== 'number' ||
      !isRecord(node.config)
    )
      throw new Error('A step in that file is missing its basic fields.');
    if (!NODE_SPECS[node.type]) unknown.add(node.type);
  }
  for (const edge of graph.edges)
    if (
      !isRecord(edge) ||
      typeof edge.id !== 'string' ||
      typeof edge.source !== 'string' ||
      typeof edge.target !== 'string' ||
      typeof edge.sourceHandle !== 'string' ||
      typeof edge.targetHandle !== 'string'
    )
      throw new Error('A connection in that file is missing its ends.');
  if (unknown.size)
    throw new Error(
      `That file uses ${unknown.size === 1 ? 'a step' : 'steps'} this version does not know: ${[...unknown].join(', ')}.`,
    );
  const name =
    (typeof parsed.name === 'string' ? parsed.name.trim() : '') ||
    'Imported flow';
  return {
    name: name.slice(0, FLOW_LIMITS.name),
    description:
      typeof parsed.description === 'string'
        ? parsed.description.slice(0, FLOW_LIMITS.description)
        : '',
    graph: graph as unknown as FlowGraph,
  };
}

/** Lowercased name -> every id of this workspace answering to it. */
function byName(items: { id: string; name: string }[]) {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!key) continue;
    map.set(key, [...(map.get(key) ?? []), item.id]);
  }
  return map;
}

/**
 * Re-links an imported graph against this workspace. A Dot or Space id the
 * workspace does not have is matched to a local one by the name the export
 * recorded (`<key>Name`, written beside every id since this version) when
 * exactly one local Dot or Space answers to it; otherwise the field is
 * cleared, so the flow imports with honest "required" problems instead of
 * silently pointing at nothing.
 *
 * Ids that only mean something *under* another binding go with it, because
 * the new workspace numbers them differently: page fields follow their
 * Space, and tool fields (plus the `<key>Title` / `<key>Connection` labels
 * written beside them) follow their Dot — a tool left pointing at the
 * exporting workspace's connection id passes the linter and then fails at
 * run time in `resolveTool`.
 *
 * Mutates `graph` and reports what it changed.
 */
export function relinkGraph(
  graph: FlowGraph,
  workspace: {
    dots: { id: string; name: string }[];
    spaces: { id: string; name: string }[];
  },
): RelinkResult {
  const ids = {
    dot: new Set(workspace.dots.map((dot) => dot.id)),
    space: new Set(workspace.spaces.map((space) => space.id)),
  };
  const names = {
    dot: byName(workspace.dots),
    space: byName(workspace.spaces),
  };
  const cleared: ClearedRef[] = [];
  const relinked: RelinkedRef[] = [];
  for (const node of graph.nodes) {
    const fields = nodeFields(node.type);
    let spaceMoved = false;
    let dotMoved = false;
    for (const field of fields) {
      const kind = field.control;
      if (kind !== 'dot' && kind !== 'space') continue;
      const value = node.config[field.key];
      if (typeof value !== 'string' || !value) continue;
      if (ids[kind].has(value)) continue;
      const recorded =
        typeof node.config[`${field.key}Name`] === 'string'
          ? (node.config[`${field.key}Name`] as string).trim()
          : '';
      const matches = recorded
        ? (names[kind].get(recorded.toLowerCase()) ?? [])
        : [];
      if (kind === 'space') spaceMoved = true;
      else dotMoved = true;
      if (matches.length === 1) {
        node.config[field.key] = matches[0];
        relinked.push({
          node: nodeLabel(node),
          field: field.label,
          name: recorded,
        });
        continue;
      }
      delete node.config[field.key];
      delete node.config[`${field.key}Name`];
      cleared.push({
        node: nodeLabel(node),
        field: field.label,
        ...(recorded ? { name: recorded } : {}),
      });
    }
    // A page id only means anything inside its Space, and a tool id only
    // inside the connections of its Dot.
    for (const field of fields) {
      const follows =
        (spaceMoved && field.control === 'page') ||
        (dotMoved && field.control === 'tool');
      if (!follows || node.config[field.key] === undefined) continue;
      delete node.config[field.key];
      delete node.config[`${field.key}Name`];
      delete node.config[`${field.key}Title`];
      delete node.config[`${field.key}Connection`];
      if (field.control === 'tool')
        cleared.push({ node: nodeLabel(node), field: field.label });
    }
  }
  return { cleared, relinked };
}

/**
 * The "Import JSON" action: a hidden file input, the summary dialog and the
 * POST that creates the flow. `element` must be rendered; `begin` opens the
 * file picker. Without `onCreated` the browser navigates to the new flow.
 */
export function useFlowImport({
  workspace,
  onCreated,
}: {
  /** Used to re-link Dot and Space ids; fetched when it is not given. */
  workspace?: WorkspaceState;
  onCreated?: (flow: Flow) => void;
} = {}) {
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const begin = () => {
    setError(null);
    setStaged(null);
    if (input.current) input.current.value = '';
    input.current?.click();
  };
  const read = async (file: File) => {
    try {
      const parsed = parseFlowFile(await file.text());
      const known = workspace ?? (await api<WorkspaceState>('/workspace'));
      setStaged({ ...parsed, ...relinkGraph(parsed.graph, known) });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'That file could not be read.',
      );
    }
  };
  const create = async () => {
    if (!staged) return;
    const flow = await api<Flow>('/flows', 'POST', {
      name: staged.name,
      description: staged.description,
      graph: staged.graph,
    });
    setStaged(null);
    if (onCreated) onCreated(flow);
    else window.location.hash = flowRoute(flow.id);
  };
  const steps = staged?.graph.nodes.length ?? 0;
  const element = (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void read(file);
        }}
      />
      {error && (
        <FlowDialog
          title="That file is not a flow"
          onClose={() => setError(null)}
        >
          <p>{error}</p>
        </FlowDialog>
      )}
      {staged && (
        <FlowDialog
          title={`Import “${staged.name}”?`}
          confirmLabel="Create flow"
          busyLabel="Creating…"
          onConfirm={create}
          onClose={() => setStaged(null)}
        >
          <p>
            {steps} {steps === 1 ? 'step' : 'steps'}
            {staged.description ? ` · ${staged.description}` : ''}
          </p>
          {staged.relinked.length > 0 && (
            <>
              <p className="muted">
                {staged.relinked.length}{' '}
                {staged.relinked.length === 1 ? 'reference' : 'references'}{' '}
                {staged.relinked.length === 1 ? 'was' : 'were'} matched to a Dot
                or Space here with the same name.
              </p>
              <ul className="flow-import-cleared">
                {staged.relinked.slice(0, 8).map((ref, index) => (
                  <li key={`relinked-${ref.node}-${ref.field}-${index}`}>
                    {ref.node} · {ref.field} → {ref.name}
                  </li>
                ))}
                {staged.relinked.length > 8 && (
                  <li className="muted">
                    and {staged.relinked.length - 8} more
                  </li>
                )}
              </ul>
            </>
          )}
          {staged.cleared.length > 0 ? (
            <>
              <p className="flow-import-warn">
                {staged.cleared.length}{' '}
                {staged.cleared.length === 1 ? 'reference' : 'references'} from
                the other workspace{' '}
                {staged.cleared.length === 1 ? 'does' : 'do'} not exist here and{' '}
                {staged.cleared.length === 1 ? 'was' : 'were'} cleared. The new
                flow shows them as required so you can pick replacements.
              </p>
              <ul className="flow-import-cleared">
                {staged.cleared.slice(0, 8).map((ref, index) => (
                  <li key={`${ref.node}-${ref.field}-${index}`}>
                    {ref.node} · {ref.field}
                    {ref.name ? ` (was “${ref.name}”)` : ''}
                  </li>
                ))}
                {staged.cleared.length > 8 && (
                  <li className="muted">
                    and {staged.cleared.length - 8} more
                  </li>
                )}
              </ul>
            </>
          ) : (
            !staged.relinked.length && (
              <p className="muted">
                Every Dot and Space this flow uses exists here.
              </p>
            )
          )}
        </FlowDialog>
      )}
    </>
  );
  return { begin, element };
}

/** "now", "in 12m", "in 4h", "in 3d": a future time, for trigger panels. */
export function countdown(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 30) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
