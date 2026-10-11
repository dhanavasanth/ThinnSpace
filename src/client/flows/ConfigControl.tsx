import { X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Mascot } from '../Mascot';
import type { Page } from '../../server/pages';
import type { Connection } from '../../shared/connection-types';
import {
  listValues,
  NODE_SPECS,
  type ConfigField,
  type FlowNode,
} from '../../shared/flows';
import type { WorkspaceState } from '../../shared/types';
import { ChipField } from './ChipField';
import type { UpstreamRef } from './contract';
import { describeSchedule } from './format';
import { api } from '../api';

export interface ConfigControlProps {
  field: ConfigField;
  node: FlowNode;
  /** The node's configuration with catalog defaults applied. */
  config: Record<string, unknown>;
  workspace: WorkspaceState;
  upstream: UpstreamRef[];
  invalid: boolean;
  id: string;
  describedBy?: string;
  /** Id of the field label, for controls that are not labelable elements. */
  labelledBy?: string;
  /** Keys merged into the node config; `undefined` removes a key. */
  onPatch: (patch: Record<string, unknown>) => void;
}

/** Built-in capabilities a Dot task may be limited to. */
export const BUILTIN_TOOLS = [
  { value: 'research', label: 'Web research' },
  { value: 'pages', label: 'Pages' },
  { value: 'computer', label: 'Computer' },
];

const SCHEDULE_PRESETS = [
  { value: 'hour', label: 'Every hour', seconds: 3600 },
  { value: 'day', label: 'Every day', seconds: 86400 },
  { value: 'weekdays', label: 'Weekdays at 09:00', seconds: 86400 },
  { value: 'week', label: 'Every week', seconds: 604800 },
  { value: 'custom', label: 'Custom minutes', seconds: 0 },
] as const;
type SchedulePreset = (typeof SCHEDULE_PRESETS)[number]['value'];

function asString(value: unknown) {
  return value === undefined || value === null ? '' : String(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function fetchList<T>(path: string): Promise<T[]> {
  return api<T[]>(path);
}

/**
 * Loads a list once per key; errors never throw out of the control. A key the
 * effect has not caught up with yet reads as loading, so a picker never flashes
 * its empty state between choosing a Space (or Dot) and the request starting.
 */
function useFetched<T>(key: string | null, load: () => Promise<T[]>) {
  const [state, setState] = useState<{
    key: string | null;
    items: T[];
    loading: boolean;
    error: string | null;
  }>({ key: null, items: [], loading: false, error: null });
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!key) {
      setState({ key: null, items: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ key, items: [], loading: true, error: null });
    loader
      .current()
      .then((items) => {
        if (!cancelled) setState({ key, items, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ key, items: [], loading: false, error: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  if (state.key !== key)
    return { key, items: [] as T[], loading: !!key, error: null };
  return state;
}

export function ConfigControl(props: ConfigControlProps) {
  const { field } = props;
  switch (field.control) {
    case 'text':
    case 'textarea':
      return (
        <TextControl {...props} multiline={field.control === 'textarea'} />
      );
    case 'select':
      return <SelectControl {...props} />;
    case 'number':
      return <NumberControl {...props} />;
    case 'toggle':
      return <ToggleControl {...props} />;
    case 'dot':
      return <DotControl {...props} />;
    case 'space':
      return <SpaceControl {...props} />;
    case 'page':
      return <PageControl {...props} />;
    case 'tool':
      return props.node.type === 'dot-task' ? (
        <AllowedToolsControl {...props} />
      ) : (
        <ConnectionToolControl {...props} />
      );
    case 'schedule':
      return <ScheduleControl {...props} />;
    case 'list':
      return <ListControl {...props} />;
    case 'json':
      return <JsonControl {...props} />;
    default:
      return <TextControl {...props} multiline={false} />;
  }
}

function TextControl({
  field,
  config,
  upstream,
  invalid,
  id,
  describedBy,
  onPatch,
  multiline,
}: ConfigControlProps & { multiline: boolean }) {
  return (
    <ChipField
      id={id}
      value={asString(config[field.key])}
      multiline={multiline}
      placeholder={field.placeholder}
      upstream={upstream}
      invalid={invalid}
      describedBy={describedBy}
      onChange={(value) => onPatch({ [field.key]: value || undefined })}
    />
  );
}

function SelectControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const value = asString(config[field.key]);
  // A stored value outside the catalog (an import, an API write) stays
  // visible as such instead of silently showing the first option.
  const unknown =
    !!value && !(field.options ?? []).some((option) => option.value === value);
  return (
    <select
      id={id}
      className={`fp-select${unknown ? ' invalid' : ''}`}
      value={value}
      aria-invalid={invalid || unknown || undefined}
      aria-describedby={describedBy}
      onChange={(event) =>
        onPatch({ [field.key]: event.target.value || undefined })
      }
    >
      {(!value || !field.required) && (
        <option value="">{field.required ? 'Choose…' : 'Not set'}</option>
      )}
      {unknown && (
        <option value={value} disabled>
          Unknown value: {value}
        </option>
      )}
      {(field.options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function NumberControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  return (
    <input
      id={id}
      type="number"
      className="fp-input"
      value={asString(config[field.key])}
      placeholder={field.placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        const raw = event.target.value;
        const parsed = raw === '' ? undefined : Number(raw);
        onPatch({
          [field.key]:
            parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
        });
      }}
    />
  );
}

function ToggleControl({
  field,
  config,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const on = Boolean(config[field.key]);
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={on}
      aria-describedby={describedBy}
      className={`fp-switch${on ? ' on' : ''}`}
      onClick={() => onPatch({ [field.key]: !on })}
    >
      <span className="fp-switch-knob" aria-hidden />
      <span className="fp-switch-text">{on ? 'On' : 'Off'}</span>
    </button>
  );
}

function DotControl({
  field,
  config,
  workspace,
  invalid,
  id,
  describedBy,
  labelledBy,
  onPatch,
}: ConfigControlProps) {
  const selected = asString(config[field.key]);
  if (!workspace.dots.length)
    return (
      <p className="fp-empty muted" id={id} aria-labelledby={labelledBy}>
        No Dots yet. Create a Dot first, then pick it here.
      </p>
    );
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={labelledBy ? undefined : field.label}
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={`dot-picker${invalid ? ' invalid' : ''}`}
    >
      {workspace.dots.map((dot) => {
        const active = dot.id === selected;
        return (
          <button
            type="button"
            key={dot.id}
            role="radio"
            aria-checked={active}
            className={`dot-option${active ? ' active' : ''}`}
            onClick={() => onPatch({ [field.key]: dot.id })}
          >
            <Mascot
              avatar={dot.avatar}
              identity={dot.id}
              name={dot.name}
              small
              decorative
            />
            <span className="dot-option-name">{dot.name}</span>
            {dot.instructions && (
              <span className="dot-option-role muted">{dot.instructions}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SpaceControl({
  field,
  config,
  workspace,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const value = asString(config[field.key]);
  const known = workspace.spaces.some((space) => space.id === value);
  return (
    <select
      id={id}
      className="fp-select"
      value={known ? value : ''}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) =>
        onPatch({ [field.key]: event.target.value || undefined })
      }
    >
      <option value="">
        {workspace.spaces.length ? 'Choose a Space…' : 'No Spaces yet'}
      </option>
      {workspace.spaces.map((space) => (
        <option key={space.id} value={space.id}>
          {space.name}
        </option>
      ))}
    </select>
  );
}

/** The Space a page field belongs to: the node's first `space` control. */
function spaceKeyFor(type: string) {
  return (
    NODE_SPECS[type]?.config.find((field) => field.control === 'space')?.key ??
    'space'
  );
}

/** Stores the page id plus its title (`<key>Name`) so cards can show it. */
function PageControl({
  field,
  node,
  config,
  invalid,
  id,
  describedBy,
  labelledBy,
  onPatch,
}: ConfigControlProps) {
  const spaceId = asString(config[spaceKeyFor(node.type)]) || null;
  const pages = useFetched<Page>(spaceId, () =>
    fetchList<Page>(`/spaces/${spaceId}/pages`),
  );
  const value = asString(config[field.key]);
  if (!spaceId)
    return (
      <p className="fp-empty muted" id={id} aria-labelledby={labelledBy}>
        Choose a Space first.
      </p>
    );
  if (pages.error)
    return (
      <p className="fp-empty error" id={id} aria-labelledby={labelledBy}>
        Could not load pages: {pages.error}
      </p>
    );
  if (!pages.loading && !pages.items.length)
    return (
      <p className="fp-empty muted" id={id} aria-labelledby={labelledBy}>
        No pages yet.
      </p>
    );
  const known = pages.items.some((page) => page.id === value);
  return (
    <select
      id={id}
      className="fp-select"
      value={known ? value : ''}
      disabled={pages.loading}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      onChange={(event) => {
        const picked = pages.items.find(
          (page) => page.id === event.target.value,
        );
        onPatch({
          [field.key]: picked?.id || undefined,
          [`${field.key}Name`]: picked ? picked.title || 'Untitled' : undefined,
        });
      }}
    >
      <option value="">
        {pages.loading ? 'Loading pages…' : 'Choose a page…'}
      </option>
      {pages.items.map((page) => (
        <option key={page.id} value={page.id}>
          {page.title || 'Untitled'}
        </option>
      ))}
    </select>
  );
}

/**
 * Stored as "connectionId:toolName" so the engine can find both halves, with
 * the tool title (`<key>Title`) and connection name (`<key>Connection`)
 * alongside so the card can show them.
 */
function ConnectionToolControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  labelledBy,
  onPatch,
}: ConfigControlProps) {
  const dotId = asString(config.dot) || null;
  const connections = useFetched<Connection>(dotId, () =>
    fetchList<Connection>(`/dots/${dotId}/connections`),
  );
  const value = asString(config[field.key]);
  if (!dotId)
    return (
      <p className="fp-empty muted" id={id} aria-labelledby={labelledBy}>
        Choose a Dot first.
      </p>
    );
  if (connections.error)
    return (
      <p className="fp-empty error" id={id} aria-labelledby={labelledBy}>
        Could not load connections: {connections.error}
      </p>
    );
  const withTools = connections.items.filter((c) => c.tools.length);
  if (!connections.loading && !withTools.length)
    return (
      <p className="fp-empty muted" id={id} aria-labelledby={labelledBy}>
        This Dot has no connected apps with tools. Add a connection in the
        Dot&apos;s settings.
      </p>
    );
  const known = withTools.some((connection) =>
    connection.tools.some((tool) => `${connection.id}:${tool.name}` === value),
  );
  return (
    <select
      id={id}
      className="fp-select"
      value={known ? value : ''}
      disabled={connections.loading}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      onChange={(event) => {
        const next = event.target.value;
        const connection = withTools.find((c) =>
          c.tools.some((tool) => `${c.id}:${tool.name}` === next),
        );
        const tool = connection?.tools.find(
          (item) => `${connection.id}:${item.name}` === next,
        );
        onPatch({
          [field.key]: next || undefined,
          [`${field.key}Title`]: tool ? tool.title || tool.name : undefined,
          [`${field.key}Connection`]: connection?.name || undefined,
        });
      }}
    >
      <option value="">
        {connections.loading ? 'Loading tools…' : 'Choose a tool…'}
      </option>
      {withTools.map((connection) => (
        <optgroup key={connection.id} label={connection.name}>
          {connection.tools.map((tool) => (
            <option
              key={tool.name}
              value={`${connection.id}:${tool.name}`}
              disabled={!tool.enabled}
            >
              {tool.title || tool.name}
              {tool.requiresApproval ? ' (asks first)' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Multi-select of what a Dot task may use; empty means everything it is allowed. */
function AllowedToolsControl({
  field,
  config,
  id,
  describedBy,
  labelledBy,
  onPatch,
}: ConfigControlProps) {
  const dotId = asString(config.dot) || null;
  const connections = useFetched<Connection>(dotId, () =>
    fetchList<Connection>(`/dots/${dotId}/connections`),
  );
  const chosen = listValues(config[field.key]);
  const options = [
    ...BUILTIN_TOOLS,
    ...connections.items.map((connection) => ({
      value: `connection:${connection.id}`,
      label: connection.name,
    })),
  ];
  const toggle = (value: string) => {
    const next = chosen.includes(value)
      ? chosen.filter((item) => item !== value)
      : [...chosen, value];
    onPatch({ [field.key]: next.length ? next : undefined });
  };
  return (
    <div
      id={id}
      className="tool-chips"
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {options.map((option) => {
        const on = chosen.includes(option.value);
        return (
          <button
            type="button"
            key={option.value}
            aria-pressed={on}
            className={`tool-chip${on ? ' on' : ''}`}
            onClick={() => toggle(option.value)}
          >
            {option.label}
          </button>
        );
      })}
      {connections.loading && (
        <span className="muted">Loading connections…</span>
      )}
      {connections.error && (
        <span className="error">
          Connections unavailable: {connections.error}
        </span>
      )}
      {!chosen.length && (
        <span className="tool-chips-note muted">
          Nothing selected means everything this Dot may use.
        </span>
      )}
    </div>
  );
}

function presetFor(
  config: Record<string, unknown>,
  key: string,
): SchedulePreset {
  const seconds = Number(config[key]);
  if (config[`${key}Days`] === 'weekdays') return 'weekdays';
  const match = SCHEDULE_PRESETS.find(
    (preset) => preset.value !== 'custom' && preset.seconds === seconds,
  );
  return match?.value ?? 'custom';
}

function ScheduleControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const key = field.key;
  const seconds = Number(config[key]) || 0;
  // "Custom minutes" is a mode the user enters, not something derived from
  // the stored seconds (which still equal a preset until they type).
  const [custom, setCustom] = useState(
    () => presetFor(config, key) === 'custom',
  );
  const preset: SchedulePreset = custom ? 'custom' : presetFor(config, key);
  const [minutes, setMinutes] = useState(
    seconds ? String(Math.max(1, Math.round(seconds / 60))) : '',
  );
  const choose = (value: SchedulePreset) => {
    setCustom(value === 'custom');
    if (value === 'custom') {
      // Keep the current interval until the user types a number.
      if (
        config[`${key}Days`] !== undefined ||
        config[`${key}At`] !== undefined
      )
        onPatch({ [`${key}Days`]: undefined, [`${key}At`]: undefined });
      return;
    }
    const chosen = SCHEDULE_PRESETS.find((item) => item.value === value)!;
    onPatch({
      [key]: chosen.seconds,
      [`${key}Days`]: value === 'weekdays' ? 'weekdays' : undefined,
      [`${key}At`]: value === 'weekdays' ? '09:00' : undefined,
    });
  };
  return (
    <div className="schedule-picker">
      <select
        id={id}
        className="fp-select"
        value={preset}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => choose(event.target.value as SchedulePreset)}
      >
        {SCHEDULE_PRESETS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      {custom && (
        <label className="schedule-custom">
          <span>Every</span>
          <input
            type="number"
            min={1}
            className="fp-input"
            value={minutes}
            autoFocus
            placeholder="30"
            aria-label="Minutes between runs"
            onChange={(event) => {
              setMinutes(event.target.value);
              const parsed = Number(event.target.value);
              onPatch({
                [key]: parsed > 0 ? Math.round(parsed * 60) : undefined,
                [`${key}Days`]: undefined,
                [`${key}At`]: undefined,
              });
            }}
          />
          <span>minutes</span>
        </label>
      )}
      <span className="schedule-summary muted">
        {describeSchedule(config, key)}
      </span>
    </div>
  );
}

function ListControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const items = listValues(config[field.key]);
  const [draft, setDraft] = useState('');
  const commit = (next: string[]) =>
    onPatch({ [field.key]: next.length ? next : undefined });
  const add = (raw: string) => {
    const parts = raw
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter((part) => part && !items.includes(part));
    if (parts.length) commit([...items, ...parts]);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Backspace' && !draft && items.length) {
      event.preventDefault();
      commit(items.slice(0, -1));
    }
  };
  return (
    <div
      className={`tag-editor${invalid ? ' invalid' : ''}`}
      onClick={(event) =>
        (
          event.currentTarget.querySelector('input') as HTMLInputElement | null
        )?.focus()
      }
    >
      {items.map((item) => (
        <span className="tag" key={item}>
          {item}
          <button
            type="button"
            className="tag-remove"
            aria-label={`Remove ${item}`}
            onClick={(event) => {
              event.stopPropagation();
              commit(items.filter((other) => other !== item));
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        className="tag-input"
        value={draft}
        placeholder={items.length ? 'Add another…' : field.placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          setDraft(event.target.value)
        }
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

function jsonText(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function jsonError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid JSON.';
  }
}

/** Stored as the raw string so {{tokens}} inside values survive round trips. */
function JsonControl({
  field,
  config,
  invalid,
  id,
  describedBy,
  onPatch,
}: ConfigControlProps) {
  const stored = jsonText(config[field.key]);
  const [draft, setDraft] = useState(stored);
  const committed = useRef(stored);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (stored !== committed.current) {
      committed.current = stored;
      setDraft(stored);
    }
  }, [stored]);
  const commit = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (text === committed.current) return;
    committed.current = text;
    onPatch({ [field.key]: text.trim() ? text : undefined });
  };
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  // Flush rather than drop a debounced edit when the editor unmounts.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) latestCommit.current(pending.current);
    },
    [],
  );
  const problem = jsonError(draft);
  const errorId = `${id}-json-error`;
  return (
    <div className="json-editor">
      <textarea
        id={id}
        className={`fp-input json-input${problem ? ' invalid' : ''}`}
        rows={5}
        spellCheck={false}
        value={draft}
        placeholder={field.placeholder}
        aria-invalid={invalid || Boolean(problem) || undefined}
        aria-describedby={
          [describedBy, problem ? errorId : null].filter(Boolean).join(' ') ||
          undefined
        }
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (timer.current) clearTimeout(timer.current);
          pending.current = text;
          timer.current = setTimeout(() => commit(text), 250);
        }}
        onBlur={() => commit(draft)}
      />
      {problem && (
        <p className="fp-inline-error" id={errorId} role="alert">
          Not valid JSON: {problem}
        </p>
      )}
    </div>
  );
}
