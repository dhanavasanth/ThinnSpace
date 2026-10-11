import {
  makeNode,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from './flows.js';

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  /** Node types in order, for the chip-strip preview. */
  nodeTypes: string[];
  build: () => FlowGraph;
}

/** Lays nodes out left-to-right in columns; rows separate parallel branches. */
function graph(
  nodes: [
    key: string,
    type: string,
    column: number,
    row: number,
    config?: Record<string, unknown>,
  ][],
  edges: [from: string, port: string, to: string, input: string][],
): FlowGraph {
  const built = new Map<string, FlowNode>();
  for (const [key, type, column, row, config] of nodes) {
    const node = makeNode(
      type,
      { x: 80 + column * 320, y: 120 + row * 220 },
      config ?? {},
    );
    // The key doubles as the card label so template tokens resolve by slug.
    node.label = key.charAt(0).toUpperCase() + key.slice(1);
    built.set(key, node);
  }
  const list: FlowEdge[] = edges.map(([from, port, to, input], index) => ({
    id: `e_${index}`,
    source: built.get(from)!.id,
    sourceHandle: port,
    target: built.get(to)!.id,
    targetHandle: input,
  }));
  return { schema: 1, nodes: [...built.values()], edges: list };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: 'research-draft-review-publish',
    name: 'Research, draft, review, publish',
    description:
      'Research a topic on the web, have a writer Dot draft a page, get your approval, and save it into a Space.',
    nodeTypes: [
      'start',
      'web-research',
      'dot-task',
      'human-review',
      'save-page',
      'finish',
    ],
    build: () =>
      graph(
        [
          [
            'start',
            'start',
            0,
            0,
            {
              trigger: 'manual',
              inputLabel: 'Topic',
              sampleInput: 'Q4 launch plan',
            },
          ],
          [
            'research',
            'web-research',
            1,
            0,
            {
              query: 'Everything relevant about {{start.input}}',
              depth: 'thorough',
            },
          ],
          [
            'writer',
            'dot-task',
            2,
            0,
            {
              task: 'Write a page about {{start.input}} using {{research.findings}}. Cite {{research.sources}}.',
            },
          ],
          [
            'review',
            'human-review',
            3,
            0,
            {
              message: 'Review this draft before it is saved.',
              actions: 'approve-changes-decline',
            },
          ],
          [
            'revise',
            'dot-task',
            3,
            1,
            { task: 'Revise the draft with this feedback: {{review.changes}}' },
          ],
          [
            'save',
            'save-page',
            4,
            0,
            { mode: 'create', title: '{{start.input}}', review: false },
          ],
          ['finish', 'finish', 5, 0, { format: 'page' }],
        ],
        [
          ['start', 'started', 'research', 'context'],
          ['research', 'findings', 'writer', 'context'],
          ['writer', 'result', 'review', 'draft'],
          ['review', 'changes', 'revise', 'context'],
          ['revise', 'result', 'save', 'content'],
          ['review', 'approved', 'save', 'content'],
          ['save', 'saved', 'finish', 'value'],
        ],
      ),
  },
  {
    id: 'daily-digest',
    name: 'Daily digest to Slack',
    description:
      'Every weekday morning a Dot reads what changed in a Space and posts a short digest to a channel.',
    nodeTypes: ['start', 'read-page', 'dot-task', 'send-message', 'finish'],
    build: () =>
      graph(
        [
          ['start', 'start', 0, 0, { trigger: 'schedule', schedule: 86400 }],
          ['pages', 'read-page', 1, 0, { mode: 'all' }],
          [
            'digest',
            'dot-task',
            2,
            0,
            {
              task: 'Summarise what changed in the last day in {{pages.text}} as five bullets.',
            },
          ],
          [
            'send',
            'send-message',
            3,
            0,
            {
              destination: 'slack',
              slackChannel: '#team-updates',
              message: '{{digest.result}}',
            },
          ],
          ['finish', 'finish', 4, 0, { format: 'text' }],
        ],
        [
          ['start', 'started', 'pages', 'context'],
          ['pages', 'text', 'digest', 'context'],
          ['digest', 'result', 'send', 'content'],
          ['send', 'sent', 'finish', 'value'],
        ],
      ),
  },
  {
    id: 'slack-triage',
    name: 'Slack triage',
    description:
      'When a Dot is mentioned in Slack, a Dot classifies the message and the right specialist answers in the thread.',
    nodeTypes: [
      'start',
      'dot-decide',
      'dot-task',
      'save-page',
      'send-message',
      'finish',
    ],
    build: () =>
      graph(
        [
          [
            'start',
            'start',
            0,
            1,
            { trigger: 'slack', slackChannel: '#support' },
          ],
          [
            'decide',
            'dot-decide',
            1,
            1,
            {
              question:
                'Is this a bug report, a how-to question, or a feature request?',
              branches: 'Bug, Question, Request',
              otherwise: true,
            },
          ],
          [
            'bug',
            'dot-task',
            2,
            0,
            { task: 'Reproduce and summarise this bug: {{start.input}}' },
          ],
          [
            'answer',
            'dot-task',
            2,
            1,
            { task: 'Answer this using the help pages: {{start.input}}' },
          ],
          ['log', 'save-page', 2, 2, { mode: 'append', review: false }],
          ['outcome', 'combine', 3, 1, {}],
          [
            'reply',
            'send-message',
            4,
            1,
            { destination: 'thread', message: '{{outcome.text}}' },
          ],
          ['finish', 'finish', 5, 1, { format: 'text' }],
        ],
        [
          ['start', 'started', 'decide', 'input'],
          ['decide', 'branch:Bug', 'bug', 'context'],
          ['decide', 'branch:Question', 'answer', 'context'],
          ['decide', 'branch:Request', 'log', 'content'],
          ['bug', 'result', 'outcome', 'values'],
          ['answer', 'result', 'outcome', 'values'],
          ['log', 'saved', 'outcome', 'values'],
          ['outcome', 'text', 'reply', 'content'],
          ['reply', 'sent', 'finish', 'value'],
        ],
      ),
  },
  {
    id: 'draft-critique-revise',
    name: 'Draft, critique, revise',
    description:
      'A writer drafts, an editor scores it, and a Branch decides whether to publish or send it back for fixes.',
    nodeTypes: [
      'start',
      'dot-task',
      'dot-task',
      'branch',
      'save-page',
      'finish',
    ],
    build: () =>
      graph(
        [
          ['start', 'start', 0, 0, { trigger: 'manual', inputLabel: 'Brief' }],
          ['writer', 'dot-task', 1, 0, { task: 'Draft: {{start.input}}' }],
          [
            'editor',
            'dot-task',
            2,
            0,
            {
              task: 'Score this draft 1-10 and list fixes.',
              outputFormat: 'json',
              outputSchema: '{ "score": "number", "fixes": "text" }',
            },
          ],
          [
            'gate',
            'branch',
            3,
            0,
            { field: '{{editor.data.score}}', operator: 'gt', value: '7' },
          ],
          [
            'fix',
            'dot-task',
            3,
            1,
            { task: 'Apply these fixes: {{editor.data.fixes}}' },
          ],
          [
            'save',
            'save-page',
            4,
            0,
            { mode: 'create', title: '{{start.input}}', review: true },
          ],
          ['finish', 'finish', 5, 0, { format: 'page' }],
        ],
        [
          ['start', 'started', 'writer', 'context'],
          ['writer', 'result', 'editor', 'context'],
          ['editor', 'data', 'gate', 'input'],
          ['gate', 'yes', 'save', 'content'],
          ['gate', 'no', 'fix', 'context'],
          ['fix', 'result', 'save', 'content'],
          ['save', 'saved', 'finish', 'value'],
        ],
      ),
  },
];
export function flowTemplate(id: string) {
  return FLOW_TEMPLATES.find((template) => template.id === id);
}
