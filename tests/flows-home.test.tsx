import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { FlowsHome, relativeTime } from '../src/client/flows/FlowsHome';
import { FLOW_TEMPLATES } from '../src/shared/flow-templates';
import type { FlowSummary } from '../src/shared/flows';
import type { WorkspaceState } from '../src/shared/types';

const workspace: WorkspaceState = {
  spaces: [],
  dots: [],
  avatars: [],
  flows: [],
  conversations: [],
  setup: {
    intelligence: true,
    model: true,
    browser: false,
    voice: false,
    slack: 'offline',
    missing: [],
  },
  calls: [],
};
const render = (flows: FlowSummary[]) =>
  renderToStaticMarkup(
    <FlowsHome
      flows={flows}
      workspace={{ ...workspace, flows }}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );

it('offers every template and a friendly empty state when there are no flows', () => {
  const html = render([]);
  for (const template of FLOW_TEMPLATES) expect(html).toContain(template.name);
  expect(html.match(/Use template/g)).toHaveLength(FLOW_TEMPLATES.length);
  expect(html).toContain('No flows yet.');
  expect(html).toContain('Start from a template or create a blank flow.');
  expect(html).not.toContain('Search flows');
});

it('lists saved flows with trigger badge, node chips and edit time', () => {
  const html = render([
    {
      id: 'f1',
      name: 'Weekly digest',
      description: '',
      trigger: 'schedule',
      nodeCount: 4,
      nodeTypes: ['start', 'read-page', 'dot-task', 'finish'],
      revision: 1,
      status: 'draft',
      updatedAt: Date.now() - 120_000,
    },
  ]);
  expect(html).toContain('Weekly digest');
  expect(html).toContain('Schedule');
  expect(html).toContain('Edited 2m ago');
  expect(html).toContain('title="Read page"');
  expect(html).toContain('No description yet.');
  expect(html).toContain('Search flows');
  expect(html).not.toContain('No flows yet.');
});

it('describes edit times relative to now', () => {
  const now = Date.now();
  expect(relativeTime(now, now)).toBe('just now');
  expect(relativeTime(now - 120_000, now)).toBe('2m ago');
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
});

it('labels webhook-triggered flows as Webhook, not Manual', () => {
  const html = render([
    {
      id: 'f2',
      name: 'Inbound lead',
      description: '',
      trigger: 'webhook',
      nodeCount: 3,
      nodeTypes: ['start', 'dot-task', 'finish'],
      revision: 1,
      status: 'published',
      updatedAt: Date.now(),
    },
  ]);
  expect(html).toContain('Webhook');
  expect(html).not.toContain('>Manual<');
});
