import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import {
  Check,
  Clock,
  Copy,
  FileText,
  Hash,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Webhook,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  FLOW_LIMITS,
  NODE_SPECS,
  nodeCategory,
  type Flow,
  type FlowStatus,
  type FlowSummary,
} from '../../shared/flows';
import { FLOW_TEMPLATES, type FlowTemplate } from '../../shared/flow-templates';
import { api } from '../api';
import type { FlowsHomeProps } from './contract';
import { nodeIcon as iconFor } from './FlowNodeCard';
import { ConfirmDialog } from './FlowVersions';
import { relativeTime } from './format';
import './flow-home.css';

export { relativeTime } from './format';

/** The catalog icon for a node type (one table shared with the canvas). */
export function nodeIcon(type: string): LucideIcon {
  return iconFor(NODE_SPECS[type]?.icon);
}

export const FLOW_TRIGGERS: Record<
  string,
  { label: string; icon: LucideIcon }
> = {
  manual: { label: 'Manual', icon: Play },
  schedule: { label: 'Schedule', icon: Clock },
  webhook: { label: 'Webhook', icon: Webhook },
  slack: { label: 'Slack', icon: Hash },
  page: { label: 'Page', icon: FileText },
};
export function flowTrigger(trigger: string) {
  return FLOW_TRIGGERS[trigger] ?? FLOW_TRIGGERS.manual;
}

/** Short lifecycle labels for cards and sidebar rows. */
export const FLOW_STATUS: Record<FlowStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  changed: 'Unpublished changes',
};
export function flowStatusLabel(status: FlowStatus) {
  return FLOW_STATUS[status] ?? FLOW_STATUS.draft;
}

/** Mini pipeline preview: one chip per node type, tinted with its category colour. */
export function NodeChipStrip({
  types,
  max = 7,
}: {
  types: string[];
  max?: number;
}) {
  const shown = types.slice(0, max);
  const rest = types.length - shown.length;
  const names = shown.map((type) => NODE_SPECS[type]?.label ?? type);
  return (
    <div className="flow-chip-strip" role="img" aria-label={names.join(', ')}>
      {shown.map((type, index) => {
        const Icon = nodeIcon(type);
        const color = nodeCategory(type)?.color ?? '#94a3b8';
        return (
          <Fragment key={`${type}-${index}`}>
            {index > 0 && <i className="flow-chip-link" />}
            <span
              className="flow-chip"
              title={names[index]}
              style={{
                color,
                background: `${color}1a`,
                borderColor: `${color}40`,
              }}
            >
              <Icon size={13} aria-hidden />
            </span>
          </Fragment>
        );
      })}
      {rest > 0 && <span className="flow-chip flow-chip-more">+{rest}</span>}
    </div>
  );
}

const stop = (event: MouseEvent) => event.stopPropagation();

export function FlowsHome({
  flows,
  onOpen,
  onRefresh,
  createRequested,
}: FlowsHomeProps) {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  // The sidebar '+' lands here with the new-flow form open and focused.
  useEffect(() => {
    if (createRequested) setCreating(true);
  }, [createRequested]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /** Id of the flow or template an action is running for ('new' for the blank form). */
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [menuFor, setMenuFor] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  /** The flow whose delete confirmation is open. */
  const [deleting, setDeleting] = useState<FlowSummary>();

  useEffect(() => {
    if (!menuFor) return;
    const close = (event: globalThis.MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.flow-card-menu')
      )
        setMenuFor(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuFor(undefined);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menuFor]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return flows
      .filter((flow) => !query || flow.name.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [flows, search]);

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      onRefresh();
    } finally {
      setBusy('');
    }
  };
  const create = (body: {
    name: string;
    description?: string;
    templateId?: string;
  }) =>
    run(body.templateId ?? 'new', async () => {
      const flow = await api<Flow>('/flows', 'POST', body);
      setCreating(false);
      setName('');
      setDescription('');
      onRefresh();
      onOpen(flow.id);
    });
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void create({ name: name.trim(), description: description.trim() });
  };
  const startFromTemplate = (template: FlowTemplate) =>
    void create({ name: template.name, templateId: template.id });
  const rename = (flow: FlowSummary, next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === flow.name) {
      setRenaming(undefined);
      return;
    }
    void run(flow.id, async () => {
      await api(`/flows/${flow.id}`, 'PUT', {
        name: trimmed,
        revision: flow.revision,
      });
      setRenaming(undefined);
      onRefresh();
    });
  };
  const duplicate = (flow: FlowSummary) =>
    void run(flow.id, async () => {
      await api<Flow>(`/flows/${flow.id}/duplicate`, 'POST');
      setSearch('');
      onRefresh();
    });
  // Same dialog as the editor; a failed DELETE shows inside it.
  const remove = (flow: FlowSummary) => setDeleting(flow);

  return (
    <main className="flow-home" aria-label="Flows">
      <div className="flow-home-inner">
        <header className="flow-home-head">
          <div>
            <h1>Flows</h1>
            <p>
              Chain your Dots, pages and tools into repeatable work, with a
              human in the loop wherever you want one.
            </p>
          </div>
          <button
            className="primary"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            <Plus size={15} />
            New flow
          </button>
        </header>
        {error && (
          <p className="chat-error flow-home-error" role="alert">
            {error}
          </p>
        )}
        {creating && (
          <form className="flow-new" onSubmit={submitNew}>
            <div>
              <label className="field-label" htmlFor="flow-new-name">
                Name
              </label>
              <input
                id="flow-new-name"
                autoFocus
                required
                maxLength={FLOW_LIMITS.name}
                placeholder="Weekly competitor digest"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="flow-new-description">
                Description <span className="muted">(optional)</span>
              </label>
              <input
                id="flow-new-description"
                maxLength={FLOW_LIMITS.description}
                placeholder="What this flow does, in one line"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flow-new-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" disabled={!name.trim() || !!busy}>
                {busy === 'new' ? 'Creating…' : 'Create flow'}
              </button>
            </div>
          </form>
        )}

        <section className="flow-section" aria-labelledby="flow-templates">
          <div className="flow-section-head">
            <div>
              <h2 id="flow-templates">Start from a template</h2>
              <p>Four starters that show what a flow can do. Edit anything.</p>
            </div>
          </div>
          <div className="flow-template-row">
            {FLOW_TEMPLATES.map((template) => (
              <article className="flow-template-card" key={template.id}>
                <h3>{template.name}</h3>
                <p>{template.description}</p>
                <NodeChipStrip types={template.nodeTypes} />
                <button
                  className="flow-use"
                  disabled={!!busy}
                  onClick={() => startFromTemplate(template)}
                >
                  {busy === template.id ? 'Creating…' : 'Use template'}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="flow-section" aria-labelledby="flow-yours">
          <div className="flow-section-head">
            <div>
              <h2 id="flow-yours">
                Your flows
                {flows.length > 0 && <small>{flows.length}</small>}
              </h2>
            </div>
            {flows.length > 0 && (
              <label className="search-box">
                <Search size={15} />
                <input
                  aria-label="Search flows"
                  placeholder="Find a flow…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            )}
          </div>
          {flows.length === 0 ? (
            <div className="flow-empty">
              <strong>No flows yet.</strong>
              <p>Start from a template or create a blank flow.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flow-empty">
              <strong>No flows match “{search.trim()}”.</strong>
              <p>Try a different name.</p>
            </div>
          ) : (
            <div className="flow-grid">
              {visible.map((flow) => {
                const trigger = flowTrigger(flow.trigger);
                const Trigger = trigger.icon;
                const editing = renaming?.id === flow.id;
                return (
                  <article
                    className={`flow-card ${busy === flow.id ? 'busy' : ''}`}
                    key={flow.id}
                    onClick={() => {
                      if (!editing) onOpen(flow.id);
                    }}
                  >
                    <div className="flow-card-top">
                      <span className="flow-card-icon" aria-hidden>
                        <Workflow size={15} />
                      </span>
                      {editing ? (
                        <form
                          className="flow-rename"
                          onClick={stop}
                          onSubmit={(event) => {
                            event.preventDefault();
                            rename(flow, renaming.name);
                          }}
                        >
                          <input
                            aria-label="Flow name"
                            autoFocus
                            maxLength={FLOW_LIMITS.name}
                            value={renaming.name}
                            onChange={(event) =>
                              setRenaming({
                                id: flow.id,
                                name: event.target.value,
                              })
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape')
                                setRenaming(undefined);
                            }}
                          />
                          <button
                            className="icon-button"
                            aria-label="Save name"
                          >
                            <Check size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Cancel rename"
                            onClick={() => setRenaming(undefined)}
                          >
                            <X size={15} />
                          </button>
                        </form>
                      ) : (
                        <button className="flow-card-title" title={flow.name}>
                          {flow.name}
                        </button>
                      )}
                      <div className="flow-card-menu" onClick={stop}>
                        <button
                          className="icon-button"
                          aria-label={`Actions for ${flow.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuFor === flow.id}
                          onClick={() =>
                            setMenuFor(
                              menuFor === flow.id ? undefined : flow.id,
                            )
                          }
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menuFor === flow.id && (
                          <div className="flow-menu" role="menu">
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMenuFor(undefined);
                                setRenaming({ id: flow.id, name: flow.name });
                              }}
                            >
                              <Pencil size={13} />
                              Rename
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMenuFor(undefined);
                                duplicate(flow);
                              }}
                            >
                              <Copy size={13} />
                              Duplicate
                            </button>
                            <button
                              role="menuitem"
                              className="danger"
                              onClick={() => {
                                setMenuFor(undefined);
                                remove(flow);
                              }}
                            >
                              <Trash2 size={13} />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="flow-card-description">
                      {flow.description || (
                        <span className="muted">No description yet.</span>
                      )}
                    </p>
                    <NodeChipStrip types={flow.nodeTypes} />
                    <div className="flow-card-foot">
                      <span className="flow-trigger-badge">
                        <Trigger size={11} aria-hidden />
                        {trigger.label}
                      </span>
                      <span
                        className={`flow-status-chip ${flow.status}`}
                        title={
                          flow.status === 'changed'
                            ? 'Published; the draft has edits that are not live yet'
                            : flow.status === 'published'
                              ? 'Triggers run the published version'
                              : 'Not published yet'
                        }
                      >
                        <i aria-hidden />
                        {flowStatusLabel(flow.status)}
                      </span>
                      <span className="flow-card-meta">
                        {flow.nodeCount}{' '}
                        {flow.nodeCount === 1 ? 'step' : 'steps'}
                      </span>
                      <span className="flow-card-meta flow-card-edited">
                        Edited {relativeTime(flow.updatedAt)}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="Its versions and runs are removed. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api(`/flows/${deleting.id}`, 'DELETE');
            setDeleting(undefined);
            onRefresh();
          }}
          onCancel={() => setDeleting(undefined)}
        />
      )}
    </main>
  );
}
