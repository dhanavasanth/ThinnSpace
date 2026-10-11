import {
  AlertCircle,
  AlertTriangle,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Mascot } from '../Mascot';
import {
  configWithDefaults,
  fieldVisible,
  NODE_SPECS,
  nodeCategory,
  nodeFields,
  nodeLabel,
  nodeOutputs,
  PORT_COLORS,
  type ConfigField,
  type FlowProblem,
} from '../../shared/flows';
import { ConfigControl } from './ConfigControl';
import type { FlowPropertiesProps } from './contract';
import { canRemove } from './flow-history';
import { NODE_LABEL_MAX, nodeIcon } from './FlowNodeCard';
import './flow-properties.css';

type Tab = 'setup' | 'advanced';
/** Controls rendered as a labelable element, so `<label for>` applies. */
const LABELABLE = new Set([
  'text',
  'textarea',
  'select',
  'number',
  'toggle',
  'space',
  'schedule',
  'list',
  'json',
]);

/** The lint problem that explains why this field is blank or stale, if any. */
function problemFor(field: ConfigField, problems: FlowProblem[]) {
  return problems.find(
    (problem) =>
      (problem.code === 'missing-config' &&
        problem.message.includes(`: ${field.label} is required`)) ||
      (problem.code === 'missing-dot' && field.control === 'dot') ||
      (problem.code === 'missing-space' && field.control === 'space'),
  );
}

/** Closes a floating element when the pointer lands outside `ref`. */
function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const handle = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', key);
    };
  }, [ref, active, onClose]);
}

export function FlowProperties({
  flow,
  node,
  graph,
  workspace,
  problems,
  upstream,
  onChange,
  onDuplicate,
  onDelete,
  onClose,
  onAddNext,
  onEditDot,
}: FlowPropertiesProps) {
  const spec = NODE_SPECS[node.type];
  const category = nodeCategory(node.type);
  const merged = useMemo(
    () => configWithDefaults(node.type, node.config),
    [node.type, node.config],
  );
  const dotField = spec?.config.find((field) => field.control === 'dot');
  const dot = dotField
    ? workspace.dots.find((candidate) => candidate.id === merged[dotField.key])
    : undefined;

  // Catalog order is kept: it already lists required fields first, and a
  // field revealed by a toggle or select belongs below its controller.
  const allFields = nodeFields(node.type);
  const fields = allFields.filter((field) =>
    fieldVisible(field, node.config, node.type),
  );
  const setupFields = fields.filter((field) => field.advanced !== true);
  const advancedFields = fields.filter((field) => field.advanced === true);
  const hasAdvanced = allFields.some((field) => field.advanced === true);

  const [tab, setTab] = useState<Tab>('setup');
  useEffect(() => {
    setTab('setup');
  }, [node.id]);
  const activeTab: Tab =
    tab === 'advanced' && hasAdvanced ? 'advanced' : 'setup';

  const patch = (changes: Record<string, unknown>) => {
    const config: Record<string, unknown> = { ...node.config };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete config[key];
      else config[key] = value;
    }
    onChange(node.id, { config });
  };

  // Inline-editable name.
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) nameInput.current?.select();
  }, [editing]);
  useEffect(() => {
    setEditing(false);
  }, [node.id]);
  const startEditing = () => {
    setNameDraft(node.label ?? '');
    setEditing(true);
  };
  const saveName = () => {
    const trimmed = nameDraft.trim().slice(0, NODE_LABEL_MAX);
    const current = node.label?.trim() ?? '';
    if (trimmed !== current)
      onChange(node.id, { label: trimmed ? trimmed : undefined });
    setEditing(false);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false));

  const Icon = nodeIcon(spec?.icon);
  const outputs = nodeOutputs(node);
  const errors = problems.filter((problem) => problem.level === 'error').length;
  const removable = canRemove(graph.nodes, node.id);
  const outdated = spec && node.typeVersion !== spec.typeVersion;

  const renderField = (field: ConfigField) => {
    const id = `fp-${node.id}-${field.key}`;
    const problem = problemFor(field, problems);
    const helpId = field.help ? `${id}-help` : undefined;
    const errorId = problem ? `${id}-error` : undefined;
    const labelable = LABELABLE.has(field.control);
    const labelId = `${id}-label`;
    return (
      <div
        className={`fp-field${problem ? ' has-error' : ''}`}
        key={`${node.id}:${field.key}`}
      >
        <label
          className="fp-label"
          id={labelId}
          htmlFor={labelable ? id : undefined}
        >
          {field.label}
          {field.required && (
            <span className="fp-required" title="Required">
              *
            </span>
          )}
        </label>
        <ConfigControl
          field={field}
          node={node}
          config={merged}
          flowId={flow.id}
          workspace={workspace}
          upstream={upstream}
          invalid={Boolean(problem)}
          id={id}
          describedBy={[helpId, errorId].filter(Boolean).join(' ') || undefined}
          labelledBy={labelable ? undefined : labelId}
          onPatch={patch}
        />
        {field.help && (
          <p className="fp-help muted" id={helpId}>
            {field.help}
          </p>
        )}
        {problem && (
          <p className="fp-inline-error" id={errorId}>
            <AlertCircle size={12} aria-hidden />
            {problem.message.replace(/^[^:]*:\s*/, '')}
          </p>
        )}
      </div>
    );
  };

  return (
    <aside className="flow-properties" aria-label="Node properties">
      <header className="fp-header">
        <div className="fp-identity">
          {dot ? (
            <span className="fp-avatar">
              <Mascot
                avatar={dot.avatar}
                identity={dot.id}
                name={dot.name}
                small
                decorative
              />
            </span>
          ) : (
            <span
              className="fp-icon"
              style={{
                background: category?.color ?? '#64748b',
                color: '#fff',
              }}
              aria-hidden
            >
              <Icon size={16} />
            </span>
          )}
          <div className="fp-title">
            {editing ? (
              <input
                ref={nameInput}
                className="fp-name-input"
                value={nameDraft}
                placeholder={spec?.label ?? node.type}
                aria-label="Node name"
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveName();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setEditing(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="fp-name"
                title="Rename"
                onClick={startEditing}
                onKeyDown={(event) => {
                  if (event.key === 'F2') startEditing();
                }}
              >
                <span>{nodeLabel(node)}</span>
                <Pencil size={12} aria-hidden />
              </button>
            )}
            <span className="fp-type muted">
              {dot
                ? `${spec?.label ?? node.type} · ${dot.name}`
                : (category?.label ?? '')}
            </span>
          </div>
        </div>
        <div className="fp-actions">
          <div className="fp-menu" ref={menuRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
            {menuOpen && (
              <div className="fp-menu-list" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate(node.id);
                  }}
                >
                  <Copy size={14} aria-hidden />
                  Duplicate
                </button>
                {dot && onEditDot && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onEditDot(dot.id);
                    }}
                  >
                    <Pencil size={14} aria-hidden />
                    Edit Dot
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  disabled={!removable}
                  title={
                    removable ? undefined : 'Every flow begins with a Start.'
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(node.id);
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                  Delete
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close properties"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      {spec?.description && (
        <p className="fp-description muted">{spec.description}</p>
      )}
      {outdated && (
        <div className="fp-outdated" role="status">
          <AlertTriangle size={14} aria-hidden />
          <span>
            This step uses an older version of {spec.label}. Updating keeps its
            settings.
          </span>
          <button
            type="button"
            onClick={() => onChange(node.id, { typeVersion: spec.typeVersion })}
          >
            <RefreshCw size={12} aria-hidden />
            Update node
          </button>
        </div>
      )}

      {hasAdvanced && (
        <div className="fp-tabs" role="tablist" aria-label="Settings">
          {(['setup', 'advanced'] as const).map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              aria-selected={activeTab === name}
              className={`fp-tab${activeTab === name ? ' active' : ''}`}
              onClick={() => setTab(name)}
            >
              {name === 'setup' ? 'Setup' : 'Advanced'}
            </button>
          ))}
        </div>
      )}

      <div className="fp-body" role={hasAdvanced ? 'tabpanel' : undefined}>
        {!spec && (
          <p className="fp-empty error">
            This node type ({node.type}) is not in the catalog.
          </p>
        )}
        {activeTab === 'setup' && setupFields.map(renderField)}
        {activeTab === 'advanced' && advancedFields.map(renderField)}
        {spec && activeTab === 'setup' && !setupFields.length && (
          <p className="fp-empty muted">Nothing to set up here.</p>
        )}
        {activeTab === 'advanced' && !advancedFields.length && (
          <p className="fp-empty muted">
            No advanced options apply with the current setup.
          </p>
        )}

        {problems.length > 0 && (
          <section className="fp-problems" aria-label="Problems">
            <h4 className="fp-section-title">
              {problems.length === 1
                ? '1 problem'
                : `${problems.length} problems`}
              {errors > 0 && (
                <span className="fp-pill error">
                  {errors} {errors === 1 ? 'error' : 'errors'}
                </span>
              )}
            </h4>
            <ul>
              {problems.map((problem, index) => (
                <li
                  key={`${problem.code}-${index}`}
                  className={`fp-problem ${problem.level}`}
                >
                  {problem.level === 'error' ? (
                    <AlertCircle size={14} aria-hidden />
                  ) : (
                    <AlertTriangle size={14} aria-hidden />
                  )}
                  <span>{problem.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {outputs.length > 0 && (
        <footer className="fp-next">
          <h4 className="fp-section-title">Next step</h4>
          <ul className="fp-outputs">
            {outputs.map((port) => (
              <li key={port.id} className="fp-output">
                <span
                  className="kind-dot"
                  style={{ background: PORT_COLORS[port.kind] }}
                  aria-hidden
                />
                <span className="fp-output-label">{port.label}</span>
                <span className="fp-output-kind muted">{port.kind}</span>
                {/* Opens the step picker (right slot) filtered to this output. */}
                <button
                  type="button"
                  className="fp-add"
                  aria-label={`Add a step after ${port.label}`}
                  title="Pick the next step"
                  onClick={() => onAddNext(node.id, port.id)}
                >
                  <Plus size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </aside>
  );
}
