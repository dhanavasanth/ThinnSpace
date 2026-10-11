/**
 * Editor chrome around the canvas: the 56px header, the Delete confirm
 * dialog, the Versions drawer, the Problems tray, the Help > Shortcuts
 * sheet, and the loading/error screens.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  nodeLabel,
  type FlowNode,
  type FlowProblem,
  type FlowStatus,
  type FlowVersion,
} from '../../shared/flows';
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
}: FlowHeaderProps) {
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
        {'when' in chip && <span aria-hidden="true"> {chip.when}</span>}
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
      <button type="button" onClick={onValidate}>
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
        className="icon-button"
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
              {status !== 'draft' && menuItem('Unpublish', onUnpublish)}
              {menuItem('Delete flow', onDelete, true)}
            </div>
          </>
        )}
      </div>
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
