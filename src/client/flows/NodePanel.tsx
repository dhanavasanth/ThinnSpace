/**
 * The "What happens next?" step picker: a right-side panel (same slot as the
 * properties panel) with a search box, n8n-style category rows that drill
 * into their steps, the workspace's real Dots on top of the Dots category,
 * and full keyboard driving (arrows, Enter, Backspace to go back).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react';
import {
  NODE_CATALOG,
  NODE_SPECS,
  kindsCompatible,
  type NodeCategory,
  type PortKind,
} from '../../shared/flows';
import type { Dot, WorkspaceState } from '../../shared/types';
import { Mascot } from '../Mascot';
import { dotRole, nodeIcon } from './FlowNodeCard';

export interface PanelItem {
  key: string;
  type: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  /** Set for the workspace's real Dots; picking one pre-binds a Dot task. */
  dot?: Dot;
}
export interface PanelGroup {
  category: NodeCategory;
  items: PanelItem[];
}

/** One-line blurbs for the category rows (the catalog carries none). */
const CATEGORY_BLURB: Record<string, string> = {
  start: 'Where a run begins and what it hands back',
  dots: 'Hand a task to one of your Dots, or let one decide',
  pages: 'Read and save pages in your Spaces',
  actions: 'Research the web, call a connected app, send a message',
  logic: 'Branch, combine and route the flow',
  people: 'Bring a person into the loop',
  notes: 'Leave a note on the canvas',
  team: 'Dot teams, loops and waits arrive in a later release',
};
export function categoryBlurb(category: NodeCategory) {
  return (
    CATEGORY_BLURB[category.id] ??
    category.nodes.map((spec) => spec.label).join(', ')
  );
}

/** The catalog with the workspace's real Dots folded into the Dots category. */
export function catalogGroups(workspace: WorkspaceState): PanelGroup[] {
  return NODE_CATALOG.map((category) => {
    const items: PanelItem[] = category.nodes.map((spec) => ({
      key: spec.type,
      type: spec.type,
      label: spec.label,
      description: spec.description,
      icon: spec.icon,
      color: category.color,
    }));
    if (category.id === 'dots')
      items.unshift(
        ...workspace.dots.map((dot) => ({
          key: `dot:${dot.id}`,
          type: 'dot-task',
          label: dot.name,
          description: dotRole(dot) || 'Hand a step to this Dot.',
          icon: 'Sparkles',
          color: category.color,
          dot,
        })),
      );
    return { category, items };
  });
}
/** Listed for discoverability but not executable yet. */
export function isComingSoon(item: Pick<PanelItem, 'type'>) {
  return !!NODE_SPECS[item.type]?.comingSoon;
}
/** Items whose inputs can take a `kind` output. */
export function acceptsKind(item: Pick<PanelItem, 'type'>, kind: PortKind) {
  const spec = NODE_SPECS[item.type];
  return (
    !!spec &&
    !spec.decorative &&
    spec.inputs.some((port) => kindsCompatible(kind, port.kind))
  );
}

/** Characters of `query` appear in order inside `text`; tighter is better. */
function subsequence(text: string, query: string) {
  let at = 0;
  let gaps = 0;
  for (const char of query) {
    const next = text.indexOf(char, at);
    if (next === -1) return 0;
    gaps += next - at;
    at = next + 1;
  }
  return Math.max(1, 40 - gaps);
}
/** 0 when the item does not match; higher ranks first. */
export function searchScore(
  item: Pick<PanelItem, 'label' | 'description' | 'type'>,
  query: string,
) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return 1;
  const label = item.label.toLowerCase();
  if (label === q) return 400;
  if (label.startsWith(q)) return 300;
  if (label.includes(q)) return 200;
  const words = label.split(/\s+/);
  if (words.some((word) => word.startsWith(q))) return 180;
  const fuzzy = subsequence(label.replace(/\s+/g, ''), q.replace(/\s+/g, ''));
  if (fuzzy) return 100 + fuzzy;
  if (item.type.includes(q)) return 80;
  const description = item.description.toLowerCase();
  if (description.includes(q)) return 60;
  return 0;
}
/** Groups filtered by `query` and `keep`, items ranked within each group. */
export function filterGroups(
  groups: PanelGroup[],
  query: string,
  keep: (item: PanelItem) => boolean = () => true,
): PanelGroup[] {
  return groups
    .map((group) => ({
      category: group.category,
      items: group.items
        .map((item) => ({ item, score: searchScore(item, query) }))
        .filter(({ item, score }) => score > 0 && keep(item))
        .sort((a, b) => b.score - a.score)
        .map(({ item }) => item),
    }))
    .filter((group) => group.items.length);
}
/** Every matching item in one ranked list (search view). */
export function flattenResults(groups: PanelGroup[], query: string) {
  return groups
    .flatMap((group) =>
      group.items.map((item) => ({
        item,
        category: group.category,
        score: searchScore(item, query),
      })),
    )
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}

function ItemIcon({ item }: { item: PanelItem }) {
  if (item.dot)
    return (
      <span className="flow-node-panel-icon avatar">
        <Mascot
          avatar={item.dot.avatar}
          identity={item.dot.id}
          name={item.dot.name}
          small
          decorative
        />
      </span>
    );
  const Icon = nodeIcon(item.icon);
  return (
    <span
      className="flow-node-panel-icon"
      style={{ color: item.color, background: `${item.color}1a` }}
    >
      <Icon size={16} />
    </span>
  );
}

export interface NodePanelProps {
  workspace: WorkspaceState;
  /** Set when opened from an output: titles the panel and filters the list. */
  from?: { label: string; port: string; kind: PortKind };
  onPick: (type: string, dotId?: string) => void;
  onClose: () => void;
  /** Where focus goes on close when the opener is gone (the source card). */
  onReturnFocus?: () => void;
}

export function NodePanel({
  workspace,
  from,
  onPick,
  onClose,
  onReturnFocus,
}: NodePanelProps) {
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const kind = from?.kind;
    return filterGroups(catalogGroups(workspace), '', (item) =>
      kind ? acceptsKind(item, kind) : true,
    );
  }, [workspace, from?.kind]);
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? flattenResults(groups, query) : []),
    [groups, query, searching],
  );
  const category = categoryId
    ? groups.find((group) => group.category.id === categoryId)
    : undefined;
  // What the arrow keys walk through in the current view.
  const rows: (
    | { kind: 'category'; group: PanelGroup }
    | { kind: 'item'; item: PanelItem; category: NodeCategory }
  )[] = searching
    ? results.map(({ item, category: cat }) => ({
        kind: 'item',
        item,
        category: cat,
      }))
    : category
      ? category.items.map((item) => ({
          kind: 'item',
          item,
          category: category.category,
        }))
      : groups.map((group) => ({ kind: 'category', group }));
  // Captured during the first render, before the search box autofocuses, so
  // focus can return to the '+' button or node that opened the panel. When
  // that opener unmounted meanwhile (the properties panel's '+'), the editor
  // says where focus should land instead.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );
  const returnFocus = useRef(onReturnFocus);
  returnFocus.current = onReturnFocus;
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else returnFocus.current?.();
    },
    [opener],
  );
  useEffect(() => setActive(0), [query, categoryId]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const pick = (item: PanelItem) => {
    if (isComingSoon(item)) return;
    onPick(item.type, item.dot?.id);
  };
  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === 'category') setCategoryId(row.group.category.id);
    else pick(row.item);
  };
  const back = () => {
    setCategoryId(null);
    inputRef.current?.focus();
  };
  const title = from
    ? 'What should this step connect to?'
    : 'What happens next?';
  return (
    <aside
      className="flow-node-panel"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        // Only the search box drives the list; a focused row or the close
        // button keeps its own Enter, so Tab + Enter activates what is focused.
        if (event.target !== inputRef.current) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => Math.min(index + 1, rows.length - 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => Math.max(index - 1, 0));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          choose(active);
        } else if (
          event.key === 'ArrowRight' &&
          !searching &&
          rows[active]?.kind === 'category'
        ) {
          event.preventDefault();
          choose(active);
        } else if (
          (event.key === 'Backspace' || event.key === 'ArrowLeft') &&
          !query &&
          categoryId
        ) {
          event.preventDefault();
          back();
        }
      }}
    >
      <header className="flow-node-panel-head">
        <div className="flow-node-panel-titles">
          <h2>{title}</h2>
          {from ? (
            <p className="muted">
              From <strong>{from.label}</strong> · {from.port}
            </p>
          ) : (
            <p className="muted">Pick a step to add to the canvas.</p>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close step picker"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="flow-node-panel-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          autoFocus
          type="search"
          aria-label="Search steps"
          placeholder={from ? 'Search compatible steps…' : 'Search steps…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="flow-node-panel-list" ref={listRef}>
        {!searching && category && (
          <div className="flow-node-panel-crumb">
            <button type="button" onClick={back}>
              <ArrowLeft size={13} />
              All steps
            </button>
            <strong>{category.category.label}</strong>
          </div>
        )}
        {rows.length === 0 && (
          <p className="muted flow-node-panel-empty">
            {searching
              ? `No steps match “${query.trim()}”.`
              : from
                ? `Nothing takes a ${from.kind} output here.`
                : 'No steps to add.'}
          </p>
        )}
        {rows.map((row, index) => {
          const isActive = index === active;
          if (row.kind === 'category') {
            const { category: cat, items } = row.group;
            const soon = cat.id === 'team';
            const Icon = nodeIcon(cat.nodes[0]?.icon);
            return (
              <button
                type="button"
                key={cat.id}
                data-index={index}
                className={`flow-node-panel-row category${isActive ? ' active' : ''}${soon ? ' soon' : ''}`}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setCategoryId(cat.id)}
              >
                <span
                  className="flow-node-panel-icon"
                  style={{ color: cat.color, background: `${cat.color}1a` }}
                >
                  <Icon size={16} />
                </span>
                <span className="flow-node-panel-text">
                  <strong>
                    {cat.label}
                    <small className="muted">{items.length}</small>
                  </strong>
                  <span>{categoryBlurb(cat)}</span>
                </span>
                <ChevronRight size={15} className="flow-node-panel-chevron" />
              </button>
            );
          }
          const { item, category: cat } = row;
          const blocked = isComingSoon(item);
          return (
            <button
              type="button"
              key={item.key}
              data-index={index}
              className={`flow-node-panel-row${isActive ? ' active' : ''}`}
              aria-disabled={blocked}
              title={
                blocked
                  ? `${item.label} arrives in a later release.`
                  : undefined
              }
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onClick={() => pick(item)}
            >
              <ItemIcon item={item} />
              <span className="flow-node-panel-text">
                <strong>
                  {item.label}
                  {blocked && <em className="flow-soon">Soon</em>}
                </strong>
                <span>
                  {item.dot
                    ? `Dot task · ${item.description}`
                    : item.description}
                </span>
              </span>
              {searching && (
                <small className="flow-node-panel-tag muted">{cat.label}</small>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
