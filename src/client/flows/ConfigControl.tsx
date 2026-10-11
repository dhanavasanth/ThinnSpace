import { Check, Copy, RefreshCw, TriangleAlert, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Mascot } from '../Mascot';
import type { Page } from '../../server/pages';
import type { FlowStartInfo, FlowTriggerInfo } from '../../shared/flow-runs';
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
import { countdown, FlowDialog } from './FlowVersions';
import { describeSchedule } from './format';
import { api } from '../api';
import './flow-home.css';

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
  /**
   * The flow being edited, which the Start trigger panel asks about (webhook
   * URL, token, next run). Threaded down from FlowProperties' own `flow`.
   */
  flowId: string;
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

/**
 * The Start field the trigger panel hangs under: the last Setup field of a
 * webhook Start (its security select) and of a schedule Start (the schedule
 * itself), so the read-only block lands below the fields it explains.
 */
function triggerPanelKind(
  props: ConfigControlProps,
): 'webhook' | 'schedule' | null {
  if (props.node.type !== 'start') return null;
  const trigger = asString(props.config.trigger) || 'manual';
  if (trigger === 'webhook' && props.field.key === 'webhookAuth')
    return 'webhook';
  if (trigger === 'schedule' && props.field.key === 'schedule')
    return 'schedule';
  return null;
}

export function ConfigControl(props: ConfigControlProps) {
  const kind = triggerPanelKind(props);
  if (!kind) return <Control {...props} />;
  return (
    <>
      <Control {...props} />
      <TriggerPanel
        kind={kind}
        flowId={props.flowId}
        nodeId={props.node.id}
        config={props.config}
        scheduleKey={props.field.key}
      />
    </>
  );
}

function Control(props: ConfigControlProps) {
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
            // The name travels with the id (as for pages): an export carries
            // ids only, and an import re-links Dots and Spaces by name.
            onClick={() =>
              onPatch({ [field.key]: dot.id, [`${field.key}Name`]: dot.name })
            }
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
      onChange={(event) => {
        const picked = workspace.spaces.find(
          (space) => space.id === event.target.value,
        );
        // The name travels with the id, so an import into another workspace
        // can re-link this field instead of clearing it.
        onPatch({
          [field.key]: picked?.id || undefined,
          [`${field.key}Name`]: picked?.name,
        });
      }}
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

/* ---------- the Start trigger panel ---------- */

/** Loads a flow's trigger facts; `reload` refetches after a regenerate. */
function useTriggerInfo(flowId: string, reload: number) {
  const [state, setState] = useState<{
    info: FlowTriggerInfo | null;
    loading: boolean;
    error: string | null;
  }>({ info: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ info: null, loading: true, error: null });
    // `secrets=1`: this panel is the one surface that shows the webhook
    // token, so no other reader of this route carries it.
    api<FlowTriggerInfo>(`/flows/${flowId}/trigger-info?secrets=1`)
      .then((info) => {
        if (!cancelled) setState({ info, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ info: null, loading: false, error: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [flowId, reload]);
  return state;
}

/** Copies one value to the clipboard and says so for a moment. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      // Absent in a non-secure context, where the write cannot work at all.
      if (!navigator.clipboard) throw new Error('No clipboard here.');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      className="trigger-copy"
      title={label}
      aria-label={label}
      onClick={() => void copy()}
    >
      {state === 'copied' ? (
        <Check size={12} aria-hidden />
      ) : (
        <Copy size={12} aria-hidden />
      )}
      <span aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Press ⌘C'
            : 'Copy'}
      </span>
    </button>
  );
}

/** The curl a person can paste to call this hook. */
function curlFor(start: FlowStartInfo, info: FlowTriggerInfo) {
  return [
    `curl -X POST '${start.url ?? ''}'`,
    `  -H 'Content-Type: application/json'`,
    start.tokenRequired && info.token
      ? `  -H '${info.tokenHeader}: ${info.token}'`
      : null,
    `  -d '{"input":"Hello from a webhook"}'`,
  ]
    .filter(Boolean)
    .join(' \\\n');
}

function UnpublishedNote({ kind }: { kind: 'webhook' | 'schedule' }) {
  return (
    <p className="trigger-note warn" role="status">
      <TriangleAlert size={12} aria-hidden />
      <span>
        {kind === 'webhook'
          ? 'This flow is not published, so calls to this URL answer 404. Publish it to make the hook live.'
          : 'This flow is not published, so nothing is scheduled yet. Publish it to start the clock.'}
      </span>
    </p>
  );
}

/**
 * Read-only facts under a webhook or schedule Start: the callable URL and
 * token with copy buttons and a Regenerate action, a ready-to-paste curl,
 * or the interval and the next run time.
 */
function TriggerPanel({
  kind,
  flowId,
  nodeId,
  config,
  scheduleKey,
}: {
  kind: 'webhook' | 'schedule';
  flowId: string;
  nodeId: string;
  config: Record<string, unknown>;
  scheduleKey: string;
}) {
  const [reload, setReload] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const { info, loading, error } = useTriggerInfo(flowId, reload);
  // Keeps "in 4h" roughly honest while the panel stays open.
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const start = info?.starts.find((item) => item.nodeId === nodeId);
  // Reading the trigger facts no longer mints a token (a GET that writes
  // handed one out to every reader of the flow list). The panel that is
  // about to show the token asks for it instead, so the curl below is
  // copyable before the first publish; publishing mints one too.
  const mintToken =
    kind === 'webhook' && !!start?.tokenRequired && !info?.token;
  useEffect(() => {
    if (!mintToken) return;
    let cancelled = false;
    void api(`/flows/${flowId}/webhook-token`, 'POST')
      .then(() => {
        if (!cancelled) setReload((count) => count + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [flowId, mintToken]);
  if (loading)
    return (
      <p className="trigger-panel muted" aria-busy="true">
        Loading trigger details…
      </p>
    );
  if (error || !info)
    return (
      <p className="trigger-panel error" role="alert">
        Could not load the trigger details: {error ?? 'no answer.'}
      </p>
    );
  if (!start)
    return (
      <p className="trigger-panel muted">
        Save the flow to see its {kind === 'webhook' ? 'URL' : 'schedule'}{' '}
        details.
      </p>
    );
  if (kind === 'schedule') {
    // The time was read once per mount, so a slot that has passed is stale,
    // not imminent: "now" would sit there for as long as the panel is open.
    const upcoming =
      start.nextRunAt && start.nextRunAt > clock ? start.nextRunAt : null;
    return (
      <section className="trigger-panel" aria-label="Schedule details">
        {!info.published && <UnpublishedNote kind="schedule" />}
        <p className="trigger-headline">
          {describeSchedule(config, scheduleKey)}
        </p>
        <div className="trigger-row">
          <span className="trigger-key">Next run</span>
          {upcoming ? (
            <span>
              <strong>{countdown(upcoming, clock)}</strong>
              <span className="muted">
                {' '}
                · {new Date(upcoming).toLocaleString()}
              </span>
            </span>
          ) : (
            <span className="muted">
              {start.nextRunAt
                ? 'Due now — waiting for the runner.'
                : start.active
                  ? 'Not scheduled yet.'
                  : 'This Start is switched off.'}
            </span>
          )}
        </div>
      </section>
    );
  }
  const curl = curlFor(start, info);
  return (
    <section className="trigger-panel" aria-label="Webhook details">
      {!info.published && <UnpublishedNote kind="webhook" />}
      <div className="trigger-row">
        <span className="trigger-key">URL</span>
        <code className="trigger-value">{start.url}</code>
        <CopyButton value={start.url ?? ''} label="Copy the webhook URL" />
      </div>
      {start.tokenRequired ? (
        <div className="trigger-row">
          <span className="trigger-key">Token</span>
          <code className="trigger-value">{info.token ?? '—'}</code>
          <CopyButton value={info.token ?? ''} label="Copy the webhook token" />
          <button
            type="button"
            className="trigger-regenerate"
            onClick={() => setConfirming(true)}
          >
            <RefreshCw size={12} aria-hidden />
            Regenerate
          </button>
        </div>
      ) : (
        <p className="trigger-note" role="status">
          No token: this hook is only callable from this machine. Anything else
          is refused, so switch the security to a token header before calling it
          from elsewhere.
        </p>
      )}
      <div className="trigger-curl">
        <span className="trigger-key">Try it</span>
        <pre>
          <code>{curl}</code>
        </pre>
        <CopyButton value={curl} label="Copy the curl example" />
      </div>
      {confirming && (
        <FlowDialog
          title="Regenerate this webhook token?"
          confirmLabel="Regenerate"
          busyLabel="Regenerating…"
          danger
          onConfirm={async () => {
            await api(`/flows/${flowId}/webhook-token`, 'POST');
            setConfirming(false);
            setReload((count) => count + 1);
          }}
          onClose={() => setConfirming(false)}
        >
          <p>
            Every existing caller stops working at once: the old token starts
            answering 401. You will have to paste the new token wherever this
            hook is called from.
          </p>
        </FlowDialog>
      )}
    </section>
  );
}
