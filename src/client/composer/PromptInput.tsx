import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  Globe,
  Link2,
  Loader2,
  Mic,
  Plug,
  Plus,
  Square,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import {
  contextUsage,
  estimateTokens,
  formatTokens,
  modelDefaults,
  type ModelSpec,
} from '../../shared/models';
import type { ModelConnection } from '../../shared/providers';
import { api } from '../api';
import './prompt-input.css';

/**
 * The conversation composer.
 *
 * Ported from the 21st.dev prompt-input pattern rather than installed: that
 * component needs Tailwind, shadcn and framer-motion, and this app is plain
 * CSS whose dark theme is generated at build time by reading hex literals.
 * Tailwind classes would bypass that generation entirely. So the layout and
 * behaviour are the same and the motion is CSS.
 *
 * Every control here maps to something the app can actually do. Nothing is
 * offered that would fail when clicked; what is not built yet says so.
 */

export type SendStatus = 'idle' | 'sending';

export interface PromptTool {
  id: string;
  label: string;
  /** Off means the control shows why rather than silently doing nothing. */
  unavailable?: string;
}

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Name shown in the resting placeholder. */
  dotName: string;
  status: SendStatus;
  disabled?: boolean;
  /** Models the owner has configured; empty until one is connected. */
  models: ModelSpec[];
  /** An explicit choice for this conversation, if one was made. */
  modelId?: string | null;
  /** What this Dot falls back to, so the picker can say where it came from. */
  dotModelId?: string | null;
  /** `null` clears the choice and goes back to the Dot's own model. */
  onModelChange?: (id: string | null) => void;
  /** True while a choice is being saved. */
  modelPending?: boolean;
  /** Why the last choice did not stick. */
  modelError?: string;
  /** Connections the server could not reach, shown rather than hidden. */
  modelIssues?: ModelIssue[];
  /** Opens wherever models are configured, when none exist yet. */
  onConnectModel?: () => void;
  /** Everything already in the conversation, for the context meter. */
  priorText?: string;
  /** Public-web research, when this Dot is allowed it. */
  research: PromptTool;
  researchOn: boolean;
  onResearchChange: (on: boolean) => void;
  /** Connected apps for this Dot. */
  connectors: PromptTool;
  onConnectors?: () => void;
  /** A page URL folded in as context. */
  source: string;
  onSourceChange: (value: string) => void;
  /** Realtime voice, when the server has it configured. */
  voice: PromptTool;
  voiceActive: boolean;
  onVoiceToggle: () => void;
  onStop?: () => void;
  running?: boolean;
}

const PLACEHOLDERS = [
  'Ask anything…',
  'Research a topic and save the findings…',
  'Draft a page from these notes…',
  'Summarise what changed this week…',
  'Plan this out step by step…',
];
const ROTATE_MS = 4200;

/** Rotates the resting placeholder, and stops once anyone is looking. */
function usePlaceholder(active: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % PLACEHOLDERS.length),
      ROTATE_MS,
    );
    return () => clearInterval(timer);
  }, [active]);
  return PLACEHOLDERS[index];
}

/** Closes a menu on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open, close]);
  return ref;
}

/* ---------- models ---------- */

/** A connection the server could not reach. Shown, not hidden. */
export interface ModelIssue {
  /** Connection id, which is the prefix of every spec id it serves. */
  id: string;
  label: string;
  error: string;
}

/** Spec ids are `<connectionId>:<model>`, so the prefix names the connection. */
export function connectionOf(specId: string) {
  return specId.split(':')[0];
}

export interface ModelGroup {
  /** The connection these rows came from, which is what groups them. */
  id: string;
  /** The connection's own label, which is what `spec.provider` holds. */
  label: string;
  models: ModelSpec[];
  /** Set when that connection last failed, so the group can say so. */
  error?: string;
}

/**
 * One group per connection, in the order the server listed them. Two
 * endpoints can serve the same model name, so the connection is the only
 * thing that tells those rows apart.
 *
 * Grouping is by connection id rather than label, because labels are not
 * unique: a second Ollama connection added from the preset carries the
 * same name as the first. Merging those would mark a working endpoint's
 * models offline because an unrelated one that happens to share its name
 * is failing, and would hide that the two rows come from different places.
 */
export function groupModels(
  models: ModelSpec[],
  issues: ModelIssue[] = [],
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    const id = connectionOf(model.id);
    const existing = groups.find((group) => group.id === id);
    const group = existing ?? { id, label: model.provider, models: [] };
    if (!existing) groups.push(group);
    group.models.push(model);
    const issue = issues.find((item) => item.id === id);
    if (issue) group.error = issue.error;
  }
  return groups;
}

/** Where the model in use came from, which the picker says quietly. */
export type ModelSource = 'chosen' | 'dot' | 'default' | 'orphan' | 'none';

export const SOURCE_NOTE: Record<ModelSource, string> = {
  chosen: '',
  dot: 'Dot default',
  default: 'Default',
  orphan: 'Chosen model gone',
  none: '',
};

/**
 * Which model a message would actually use. An explicit choice wins; then
 * the Dot's own default; then the first connected model, which is what the
 * server falls back to. A choice that no longer exists is called out
 * rather than silently replaced.
 */
export function activeModel(
  models: ModelSpec[],
  modelId?: string | null,
  dotModelId?: string | null,
): { spec?: ModelSpec; source: ModelSource } {
  const chosen = modelId
    ? models.find((item) => item.id === modelId)
    : undefined;
  if (chosen) return { spec: chosen, source: 'chosen' };
  const fromDot = dotModelId
    ? models.find((item) => item.id === dotModelId)
    : undefined;
  if (modelId) {
    const spec = fromDot ?? models[0];
    return { spec, source: spec ? 'orphan' : 'none' };
  }
  // The same loss, one rung down: deleting a connection a Dot pointed at
  // leaves a dangling default. Something else will answer, and saying
  // "Default" would hide that the Dot's own choice is gone.
  if (dotModelId && !fromDot) {
    const spec = models[0];
    return { spec, source: spec ? 'orphan' : 'none' };
  }
  if (fromDot) return { spec: fromDot, source: 'dot' };
  return models[0]
    ? { spec: models[0], source: 'default' }
    : { spec: undefined, source: 'none' };
}

/**
 * The composer's view of what is connected: the enabled models, and any
 * connection currently in error. Both come from endpoints the Settings
 * panel already writes to, so this reloads rather than caching.
 */
export function useModelCatalog(enabled = true, version = 0) {
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [issues, setIssues] = useState<ModelIssue[]>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    void api<ModelSpec[]>('/models')
      .then(setModels)
      .catch(() => undefined);
    void api<{ connections: ModelConnection[] }>('/model-connections')
      .then(({ connections }) =>
        setIssues(
          connections
            .filter((connection) => connection.error)
            .map((connection) => ({
              id: connection.id,
              label: connection.label,
              error: connection.error as string,
            })),
        ),
      )
      .catch(() => undefined);
    // `version` is the caller's way of saying "something changed": the
    // Settings panel writes to these same endpoints from outside this
    // tree, and a composer that never refetched would keep offering to
    // connect a model the owner has just connected.
  }, [enabled, version]);
  useEffect(reload, [reload]);
  return { models, issues, reload };
}

/**
 * The model list itself, split out so it can be rendered and checked on
 * its own: it carries the only place that says what a model can do.
 */
export function ModelMenu({
  models,
  issues = [],
  activeId,
  dotModelId,
  overridden,
  error,
  onPick,
}: {
  models: ModelSpec[];
  issues?: ModelIssue[];
  /** The model a message would use right now. */
  activeId?: string;
  dotModelId?: string | null;
  /** True when an explicit choice is in force, which can be cleared. */
  overridden?: boolean;
  error?: string;
  onPick: (id: string | null) => void;
}) {
  const groups = groupModels(models, issues);
  const fallback = dotModelId
    ? models.find((item) => item.id === dotModelId)
    : undefined;
  /**
   * Two connections to the same provider share a preset label, so the name
   * alone would label both groups identically. Where that happens the
   * endpoint is what tells them apart, so it joins the heading.
   */
  const heading = (group: ModelGroup) =>
    groups.some((other) => other.id !== group.id && other.label === group.label)
      ? `${group.label} · ${group.models[0]?.baseUrl ?? ''}`
      : group.label;
  return (
    <div className="prompt-menu wide" role="menu" aria-label="Model">
      {groups.map((group) => (
        <div
          className="prompt-menu-group"
          role="group"
          aria-label={heading(group)}
          key={group.id}
        >
          {groups.length > 1 && (
            <p className="prompt-menu-label">
              <span>{heading(group)}</span>
              {group.error && (
                <span className="prompt-cap warn" title={group.error}>
                  Offline
                </span>
              )}
            </p>
          )}
          {group.models.map((item) => {
            // The server already resolved the capability table; the local
            // fallback only matters for a payload that predates it.
            const known = item.known ?? modelDefaults(item.model).known;
            const on = item.id === activeId;
            const offline = issues.some(
              (issue) => issue.id === connectionOf(item.id),
            );
            return (
              <button
                type="button"
                role="menuitemradio"
                key={item.id}
                aria-checked={on}
                className={on ? 'on' : ''}
                onClick={() => onPick(item.id)}
              >
                <span className="prompt-model-row">
                  <strong>{item.label}</strong>
                  <small>
                    {item.provider} · {formatTokens(item.contextWindow)} context
                  </small>
                  <span className="prompt-model-caps">
                    {item.vision && (
                      <span className="prompt-cap" title="Can read images">
                        Vision
                      </span>
                    )}
                    {item.tools && (
                      <span className="prompt-cap" title="Can call tools">
                        Tools
                      </span>
                    )}
                    {!known && (
                      <span
                        className="prompt-cap estimate"
                        title="This model is not in the capability table, so its window and abilities are guesses."
                      >
                        Estimated
                      </span>
                    )}
                    {item.missing && (
                      <span
                        className="prompt-cap warn"
                        title="This connection no longer lists this model. Refresh it in Settings."
                      >
                        Not offered
                      </span>
                    )}
                    {offline && (
                      <span
                        className="prompt-cap warn"
                        title="This connection last failed. Test it in Settings."
                      >
                        Offline
                      </span>
                    )}
                  </span>
                </span>
                {on && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ))}

      {overridden && (
        <>
          <div className="prompt-menu-rule" role="separator" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={false}
            onClick={() => onPick(null)}
          >
            <span className="prompt-model-row">
              <strong>Use the default</strong>
              <small>
                {fallback
                  ? `Back to ${fallback.label}`
                  : 'Back to whatever this Dot is set to'}
              </small>
            </span>
          </button>
        </>
      )}

      {issues.length > 0 && (
        <>
          <div className="prompt-menu-rule" role="separator" />
          {issues.map((issue) => (
            <p className="prompt-menu-issue" key={issue.id}>
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                <strong>{issue.label}</strong>
                <small>{issue.error}</small>
              </span>
            </p>
          ))}
        </>
      )}

      {error && (
        <p className="prompt-menu-issue" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>
            <strong>Not saved</strong>
            <small>{error}</small>
          </span>
        </p>
      )}
    </div>
  );
}

export function PromptInput(props: PromptInputProps) {
  const {
    value,
    onChange,
    onSubmit,
    dotName,
    status,
    disabled,
    models,
    modelId,
    dotModelId,
    onModelChange,
    modelPending,
    modelError,
    modelIssues = [],
    onConnectModel,
    priorText = '',
    research,
    researchOn,
    onResearchChange,
    connectors,
    onConnectors,
    source,
    onSourceChange,
    voice,
    voiceActive,
    onVoiceToggle,
    onStop,
    running,
  } = props;

  const [actionsOpen, setActionsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const actionsRef = useDismiss(actionsOpen, () => setActionsOpen(false));
  const modelsRef = useDismiss(modelsOpen, () => setModelsOpen(false));

  const trimmed = value.trim();
  const placeholder = usePlaceholder(!value && !focused);
  const { spec: model, source: modelSource } = activeModel(
    models,
    modelId,
    dotModelId,
  );
  const sourceNote = SOURCE_NOTE[modelSource];

  // Auto-grow. Reset to auto first so the box can shrink as well as grow.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 8 * 28 + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const usage = model
    ? contextUsage(estimateTokens(`${priorText}\n${value}`), model)
    : undefined;

  const submit = () => {
    if (disabled || status === 'sending' || !trimmed) return;
    onSubmit(trimmed);
  };

  const chips = [
    researchOn && {
      id: 'research',
      label: 'Web research',
      icon: <Globe size={13} aria-hidden="true" />,
      off: () => onResearchChange(false),
    },
    source && {
      id: 'source',
      label: new URL(source.startsWith('http') ? source : `https://${source}`)
        .hostname,
      icon: <Link2 size={13} aria-hidden="true" />,
      off: () => {
        onSourceChange('');
        setSourceOpen(false);
      },
    },
  ].filter(Boolean) as {
    id: string;
    label: string;
    icon: React.ReactNode;
    off: () => void;
  }[];

  return (
    <div
      className={`prompt-input ${focused ? 'focused' : ''} ${
        disabled ? 'disabled' : ''
      }`}
    >
      {chips.length > 0 && (
        <div className="prompt-chips">
          {chips.map((chip) => (
            <span className="prompt-chip" key={chip.id}>
              {chip.icon}
              <span>{chip.label}</span>
              <button
                type="button"
                onClick={chip.off}
                aria-label={`Remove ${chip.label}`}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {sourceOpen && (
        <div className="prompt-source">
          <Link2 size={14} aria-hidden="true" />
          <input
            type="url"
            value={source}
            autoFocus
            placeholder="https://example.com/page"
            aria-label="Source page URL"
            onChange={(event) => onSourceChange(event.target.value)}
          />
          <button
            type="button"
            aria-label="Cancel source"
            onClick={() => {
              onSourceChange('');
              setSourceOpen(false);
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="prompt-field">
        {!value && !focused && (
          <span className="prompt-placeholder" aria-hidden="true">
            {placeholder}
          </span>
        )}
        <textarea
          id={fieldId}
          ref={field}
          rows={1}
          value={value}
          maxLength={4000}
          disabled={disabled}
          aria-label={`Message ${dotName}`}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="prompt-toolbar">
        <div className="prompt-actions">
          <div className="prompt-menu-anchor" ref={actionsRef}>
            <button
              type="button"
              className={`prompt-icon ${actionsOpen ? 'open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              aria-label="Add to this message"
              onClick={() => setActionsOpen(!actionsOpen)}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
            {actionsOpen && (
              <div className="prompt-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="disabled"
                  disabled
                  title="Attachments arrive once a model with vision is connected."
                >
                  <Upload size={15} aria-hidden="true" />
                  <span>Upload file</span>
                  <small>Soon</small>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSourceOpen(true);
                    setActionsOpen(false);
                  }}
                >
                  <Link2 size={15} aria-hidden="true" />
                  <span>Add a page link</span>
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={researchOn}
                  disabled={!!research.unavailable}
                  title={research.unavailable}
                  className={researchOn ? 'on' : ''}
                  onClick={() => {
                    onResearchChange(!researchOn);
                    setActionsOpen(false);
                  }}
                >
                  <Globe size={15} aria-hidden="true" />
                  <span>{research.label}</span>
                  {researchOn && <Check size={14} aria-hidden="true" />}
                  {research.unavailable && <small>Off</small>}
                </button>
                <div className="prompt-menu-rule" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!!connectors.unavailable}
                  title={connectors.unavailable}
                  onClick={() => {
                    onConnectors?.();
                    setActionsOpen(false);
                  }}
                >
                  <Plug size={15} aria-hidden="true" />
                  <span>{connectors.label}</span>
                </button>
              </div>
            )}
          </div>

          <div className="prompt-menu-anchor" ref={modelsRef}>
            <button
              type="button"
              className={`prompt-model ${modelsOpen ? 'open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={modelsOpen}
              title={
                models.length === 0
                  ? 'No model connected yet. Opens Settings.'
                  : `Model: ${model?.label}${sourceNote ? ` · ${sourceNote}` : ''}`
              }
              onClick={() =>
                models.length === 0
                  ? onConnectModel?.()
                  : setModelsOpen(!modelsOpen)
              }
            >
              <span className="prompt-model-name">
                {model?.label ?? 'Connect a model'}
              </span>
              {sourceNote && (
                <span className="prompt-model-note">{sourceNote}</span>
              )}
              {modelPending ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : (
                <ChevronDown size={13} aria-hidden="true" />
              )}
            </button>
            {modelsOpen && models.length > 0 && (
              <ModelMenu
                models={models}
                issues={modelIssues}
                activeId={model?.id}
                dotModelId={dotModelId}
                overridden={
                  modelSource === 'chosen' || modelSource === 'orphan'
                }
                error={modelError}
                onPick={(id) => {
                  onModelChange?.(id);
                  setModelsOpen(false);
                }}
              />
            )}
          </div>
        </div>

        <div className="prompt-send">
          {usage && (
            <span
              className={`prompt-context ${usage.level}`}
              title={`About ${formatTokens(usage.used)} of ${formatTokens(
                usage.window,
              )} tokens. Estimated, not counted by the model.`}
            >
              <span
                className="prompt-context-bar"
                style={{ ['--fill' as string]: `${usage.ratio * 100}%` }}
                aria-hidden="true"
              />
              <span className="prompt-context-text">
                {formatTokens(usage.used)}/{formatTokens(usage.window)}
              </span>
            </span>
          )}
          <button
            type="button"
            className={`prompt-icon ${voiceActive ? 'active' : ''}`}
            aria-label={voiceActive ? 'End voice' : 'Start voice'}
            aria-pressed={voiceActive}
            disabled={disabled || !!voice.unavailable}
            title={voice.unavailable ?? 'Talk with your Dot'}
            onClick={onVoiceToggle}
          >
            {voiceActive ? (
              <AudioLines size={17} aria-hidden="true" />
            ) : (
              <Mic size={17} aria-hidden="true" />
            )}
          </button>
          {running ? (
            <button
              type="button"
              className="prompt-action"
              aria-label="Stop response"
              onClick={onStop}
            >
              <Square size={14} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="prompt-action"
              aria-label="Send message"
              disabled={disabled || !trimmed || status === 'sending'}
              onClick={submit}
            >
              {status === 'sending' ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <ArrowUp size={17} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* The menu closes on a choice, so a refusal has to say so out here. */}
      {modelError && !modelsOpen && (
        <p className="prompt-model-error" role="alert">
          <TriangleAlert size={12} aria-hidden="true" />
          <span>{modelError}</span>
        </p>
      )}
    </div>
  );
}
