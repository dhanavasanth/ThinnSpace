import { Braces } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { PORT_COLORS } from '../../shared/flows';
import type { UpstreamRef } from './contract';

export interface ChipFieldProps {
  id?: string;
  value: string;
  /** Called with the committed text: ~250ms after the last keystroke, on blur, and on token insert. */
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  upstream: UpstreamRef[];
  invalid?: boolean;
  describedBy?: string;
}

const TOKEN_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const DEBOUNCE_MS = 250;

/** Distinct {{tokens}} used in a piece of text, in order of first appearance. */
export function usedTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) seen.add(match[1].trim());
  return [...seen];
}

interface Group {
  nodeId: string;
  nodeLabel: string;
  refs: UpstreamRef[];
}

/**
 * A text input that understands {{node.port}} tokens: typing "{{" or pressing
 * the braces button opens a picker of upstream outputs; the tokens already in
 * the value are listed underneath so a long task brief stays legible.
 */
export function ChipField({
  id,
  value,
  onChange,
  multiline = false,
  placeholder,
  upstream,
  invalid = false,
  describedBy,
}: ChipFieldProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Where a typed "{{" began, so picking a row replaces what was typed after it.
  const [anchor, setAnchor] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committed = useRef(value);
  const caret = useRef<number | null>(null);

  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  const pending = useRef<string | null>(null);

  const commit = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      if (next === committed.current) return;
      committed.current = next;
      onChange(next);
    },
    [onChange],
  );
  const latestCommit = useRef(commit);
  latestCommit.current = commit;

  // Flush rather than drop a debounced edit when the field unmounts.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) latestCommit.current(pending.current);
    },
    [],
  );

  const schedule = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = next;
      timer.current = setTimeout(() => commit(next), DEBOUNCE_MS);
    },
    [commit],
  );

  const handleInput = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const next = event.target.value;
    const position = event.target.selectionStart ?? next.length;
    caret.current = position;
    setDraft(next);
    schedule(next);
    if (open && anchor !== null) {
      if (position < anchor + 2) {
        setOpen(false);
        setAnchor(null);
      } else {
        setQuery(next.slice(anchor + 2, position));
        setActive(0);
      }
      return;
    }
    if (next.slice(Math.max(0, position - 2), position) === '{{') {
      setAnchor(position - 2);
      setQuery('');
      setActive(0);
      setOpen(true);
    }
  };

  const rememberCaret = () => {
    const element = inputRef.current;
    if (element) caret.current = element.selectionStart ?? null;
  };

  const groups = useMemo<Group[]>(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? upstream.filter((ref) =>
          `${ref.nodeLabel} ${ref.portLabel} ${ref.token}`
            .toLowerCase()
            .includes(needle),
        )
      : upstream;
    const out: Group[] = [];
    for (const ref of list) {
      const last = out[out.length - 1];
      if (last && last.nodeId === ref.nodeId) last.refs.push(ref);
      else
        out.push({ nodeId: ref.nodeId, nodeLabel: ref.nodeLabel, refs: [ref] });
    }
    return out;
  }, [upstream, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.refs), [groups]);

  const close = () => {
    setOpen(false);
    setAnchor(null);
    setQuery('');
  };

  const insert = (ref: UpstreamRef) => {
    const element = inputRef.current;
    const position = caret.current ?? draft.length;
    const start = anchor ?? position;
    const next = `${draft.slice(0, start)}${ref.token}${draft.slice(position)}`;
    setDraft(next);
    commit(next);
    close();
    const after = start + ref.token.length;
    caret.current = after;
    if (element) {
      element.focus();
      requestAnimationFrame(() => element.setSelectionRange(after, after));
    }
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    rememberCaret();
    setAnchor(null);
    setQuery('');
    setActive(0);
    setOpen(true);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, flat.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && flat[active]) {
      event.preventDefault();
      insert(flat[active]);
    }
  };

  const tokens = usedTokens(draft);
  const known = new Set(upstream.map((ref) => ref.token.slice(2, -2)));
  const shared = {
    id,
    value: draft,
    placeholder,
    onChange: handleInput,
    onKeyDown: handleKeyDown,
    onBlur: () => commit(draft),
    onClick: rememberCaret,
    onKeyUp: rememberCaret,
    onSelect: rememberCaret,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    className: 'chip-input',
    spellCheck: false,
  };

  return (
    <div className={`chip-field${open ? ' open' : ''}`}>
      <div className="chip-field-row">
        {multiline ? (
          <textarea
            {...shared}
            rows={4}
            ref={(element) => {
              inputRef.current = element;
            }}
          />
        ) : (
          <input
            {...shared}
            type="text"
            ref={(element) => {
              inputRef.current = element;
            }}
          />
        )}
        <button
          type="button"
          className="chip-insert"
          title="Insert an upstream output"
          aria-label="Insert an upstream output"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          <Braces size={14} aria-hidden />
        </button>
      </div>
      {open && (
        <div
          className="chip-popover"
          role="listbox"
          aria-label="Upstream outputs"
        >
          {flat.length === 0 ? (
            <p className="chip-empty muted">
              {upstream.length
                ? 'Nothing matches.'
                : 'No upstream outputs yet. Connect something into this node first.'}
            </p>
          ) : (
            groups.map((group) => (
              <div className="chip-group" key={group.nodeId}>
                <div className="chip-group-label">{group.nodeLabel}</div>
                {group.refs.map((ref) => {
                  const index = flat.indexOf(ref);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      key={ref.token}
                      className={`chip-option${index === active ? ' active' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => insert(ref)}
                    >
                      <span
                        className="kind-dot"
                        style={{ background: PORT_COLORS[ref.kind] }}
                        aria-hidden
                      />
                      <span className="chip-option-label">{ref.portLabel}</span>
                      <code className="chip-option-token">{ref.token}</code>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
      {tokens.length > 0 && (
        <div className="chip-uses">
          <span className="muted">Uses:</span>
          {tokens.map((token) => (
            <span
              key={token}
              className={`chip-token${known.has(token) ? '' : ' unknown'}`}
              title={
                known.has(token)
                  ? undefined
                  : 'Not an output of any node upstream of this one'
              }
            >
              {token}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
