import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
  modelId?: string;
  onModelChange?: (id: string) => void;
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
    onModelChange,
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
  const model = models.find((item) => item.id === modelId) ?? models[0];

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
              disabled={disabled}
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
              aria-haspopup="listbox"
              aria-expanded={modelsOpen}
              disabled={disabled || models.length === 0}
              title={
                models.length === 0
                  ? 'Connect a model in Settings'
                  : `Model: ${model?.label}`
              }
              onClick={() => setModelsOpen(!modelsOpen)}
            >
              <span className="prompt-model-name">
                {model?.label ?? 'No model'}
              </span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {modelsOpen && models.length > 0 && (
              <div className="prompt-menu wide" role="listbox">
                {models.map((item) => {
                  const caps = modelDefaults(item.model);
                  return (
                    <button
                      type="button"
                      role="option"
                      key={item.id}
                      aria-selected={item.id === model?.id}
                      className={item.id === model?.id ? 'on' : ''}
                      onClick={() => {
                        onModelChange?.(item.id);
                        setModelsOpen(false);
                      }}
                    >
                      <span className="prompt-model-row">
                        <strong>{item.label}</strong>
                        <small>
                          {item.provider} · {formatTokens(item.contextWindow)}{' '}
                          context
                          {caps.known ? '' : ' (estimated)'}
                        </small>
                      </span>
                      {item.id === model?.id && (
                        <Check size={14} aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>
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
    </div>
  );
}
