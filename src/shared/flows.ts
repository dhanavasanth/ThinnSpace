/**
 * ThinnSpace Flows: the shared contract between the canvas, the store, and the
 * (future) execution engine. Everything here is plain data plus pure helpers so
 * both the browser and the server can validate a graph the same way.
 */
export type PortKind = 'text' | 'json' | 'trigger' | 'any';
export interface PortSpec {
  id: string;
  label: string;
  kind: PortKind;
  /** Accepts several incoming edges (fan-in). */
  multiple?: boolean;
}
export type ConfigControl =
  | 'text'
  | 'textarea'
  | 'select'
  | 'dot'
  | 'space'
  | 'page'
  | 'number'
  | 'toggle'
  | 'tool'
  | 'schedule'
  | 'list'
  | 'json';
export interface ConfigOption {
  value: string;
  label: string;
  /**
   * Declared but not wired up yet: the option stays selectable so existing
   * flows keep their value, the linter warns, and the engine refuses it.
   */
  unavailable?: boolean;
}
export interface ConfigField {
  key: string;
  label: string;
  control: ConfigControl;
  required: boolean;
  help?: string;
  placeholder?: string;
  options?: ConfigOption[];
  /** Hidden behind the Advanced tab. */
  advanced?: boolean;
  default?: unknown;
  /** Only shown when another field has one of these values. */
  showWhen?: { key: string; values: string[] };
}
export interface NodeSpec {
  type: string;
  typeVersion: number;
  label: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  config: ConfigField[];
  /** Outputs derived from configuration rather than the static list. */
  dynamicOutputs?: 'branches' | 'actions';
  /** Non-executing canvas furniture (notes). */
  decorative?: boolean;
  /** Shown in the palette but not yet executable; cannot be added. */
  comingSoon?: boolean;
}
export interface NodeCategory {
  id: string;
  label: string;
  color: string;
  nodes: NodeSpec[];
}

export const PORT_COLORS: Record<PortKind, string> = {
  text: '#6366f1',
  json: '#e11d48',
  trigger: '#0ea5e9',
  any: '#94a3b8',
};

const CONTEXT_IN: PortSpec = {
  id: 'context',
  label: 'Context',
  kind: 'any',
  multiple: true,
};

/**
 * Bounds the steps that would otherwise let one flow run forever. They live
 * here because the linter reports them while the flow is drawn and the engine
 * clamps to the same numbers while it runs.
 */
/** Longest a Wait step may pause: 24 hours. */
export const WAIT_MAX_MINUTES = 1440;
/** Items a For each container handles at once. */
export const FOR_EACH_MAX_CONCURRENCY = 5;
/** How deep Run flow may nest child runs, the top-level run included. */
export const MAX_FLOW_DEPTH = 3;

export const NODE_CATALOG: NodeCategory[] = [
  {
    id: 'start',
    label: 'Start & finish',
    color: '#0ea5e9',
    nodes: [
      {
        type: 'start',
        typeVersion: 1,
        label: 'Start',
        description:
          'An entry point. Choose what starts the flow: a manual run, a schedule, a Slack mention, a webhook, or a page change in a Space. A flow can have several.',
        icon: 'Play',
        inputs: [],
        outputs: [{ id: 'started', label: 'Input', kind: 'trigger' }],
        config: [
          {
            key: 'trigger',
            label: 'What starts this flow?',
            control: 'select',
            required: true,
            default: 'manual',
            options: [
              { value: 'manual', label: 'Run manually' },
              { value: 'schedule', label: 'On a schedule' },
              { value: 'slack', label: 'A Slack mention' },
              { value: 'webhook', label: 'A webhook call' },
              { value: 'page', label: 'A page changes in a Space' },
            ],
          },
          {
            key: 'schedule',
            label: 'Schedule',
            control: 'schedule',
            required: true,
            showWhen: { key: 'trigger', values: ['schedule'] },
            default: 86400,
          },
          {
            key: 'slackChannel',
            label: 'Only in channel',
            control: 'text',
            required: false,
            placeholder: 'C01ABCDEF (leave empty for any)',
            help: 'The channel id Slack reports, as shown by "Copy link".',
            showWhen: { key: 'trigger', values: ['slack'] },
          },
          {
            key: 'slackKeyword',
            label: 'Only when the message contains',
            control: 'text',
            required: false,
            placeholder: 'digest',
            showWhen: { key: 'trigger', values: ['slack'] },
          },
          {
            key: 'slackAcknowledge',
            label: 'Reply "On it" immediately',
            control: 'toggle',
            required: false,
            default: true,
            showWhen: { key: 'trigger', values: ['slack'] },
          },
          {
            key: 'webhookAuth',
            label: 'Webhook security',
            control: 'select',
            required: false,
            default: 'token',
            showWhen: { key: 'trigger', values: ['webhook'] },
            options: [
              { value: 'token', label: 'Secret token header' },
              { value: 'none', label: 'None (local only)' },
            ],
          },
          {
            key: 'watchSpace',
            label: 'Space to watch',
            control: 'space',
            required: true,
            showWhen: { key: 'trigger', values: ['page'] },
          },
          {
            key: 'pageEvent',
            label: 'When a page is',
            control: 'select',
            required: false,
            default: 'created',
            showWhen: { key: 'trigger', values: ['page'] },
            options: [
              { value: 'created', label: 'Created' },
              { value: 'updated', label: 'Created or updated' },
            ],
          },
          {
            key: 'inputLabel',
            label: 'Ask for an input',
            control: 'text',
            required: false,
            placeholder: 'Topic',
            help: 'Shown when someone runs the flow by hand.',
            showWhen: { key: 'trigger', values: ['manual'] },
          },
          {
            key: 'inputFields',
            label: 'Run form fields',
            control: 'json',
            required: false,
            advanced: true,
            placeholder:
              '[{ "name": "audience", "label": "Audience", "type": "text", "required": true }]',
            help: 'Extra typed inputs, available as {{start.<name>}}.',
            showWhen: { key: 'trigger', values: ['manual'] },
          },
          {
            key: 'sampleInput',
            label: 'Sample input',
            control: 'textarea',
            required: false,
            advanced: true,
            help: 'Drives Preview run order and test runs.',
          },
          {
            key: 'active',
            label: 'Active',
            control: 'toggle',
            required: false,
            default: true,
            advanced: true,
            help: 'Paused triggers do not start runs.',
            showWhen: {
              key: 'trigger',
              values: ['schedule', 'slack', 'webhook', 'page'],
            },
          },
        ],
      },
      {
        type: 'finish',
        typeVersion: 1,
        label: 'Finish',
        description:
          'Marks the result of the flow. Whatever is wired in becomes the run result and, later, the return value when the flow is used as a tool.',
        icon: 'Flag',
        inputs: [
          { id: 'value', label: 'Result', kind: 'any', multiple: true },
          { id: 'sources', label: 'Sources', kind: 'json', multiple: true },
        ],
        outputs: [],
        config: [
          {
            key: 'label',
            label: 'Result label',
            control: 'text',
            required: false,
            placeholder: 'Result',
          },
          {
            key: 'format',
            label: 'Returns',
            control: 'select',
            required: false,
            default: 'text',
            options: [
              { value: 'text', label: 'Text' },
              { value: 'page', label: 'Page link' },
              { value: 'json', label: 'JSON' },
            ],
          },
          {
            key: 'replyToTrigger',
            label: 'Reply in the Slack thread that started this flow',
            control: 'toggle',
            required: false,
            default: false,
          },
        ],
      },
    ],
  },
  {
    id: 'dots',
    label: 'Dots',
    color: '#ff6a1f',
    nodes: [
      {
        type: 'dot-task',
        typeVersion: 1,
        label: 'Dot task',
        description:
          'Hand one step to a Dot. It keeps its own instructions, avatar, permissions, Space access, and connections; you only write the task for this step.',
        icon: 'Sparkles',
        inputs: [CONTEXT_IN],
        outputs: [
          { id: 'result', label: 'Result', kind: 'text' },
          { id: 'data', label: 'Data', kind: 'json' },
          { id: 'pages', label: 'Pages touched', kind: 'json' },
        ],
        config: [
          { key: 'dot', label: 'Dot', control: 'dot', required: true },
          {
            key: 'task',
            label: 'Task',
            control: 'textarea',
            required: true,
            placeholder:
              'Write a page about {{start.input}} using {{research.findings}}.',
            help: 'Type {{ to insert an upstream output.',
          },
          {
            key: 'expectedOutput',
            label: 'What a good result looks like',
            control: 'textarea',
            required: false,
            placeholder:
              'A 600-word page with three sections and cited sources.',
          },
          {
            key: 'outputFormat',
            label: 'Output',
            control: 'select',
            required: false,
            default: 'text',
            options: [
              { value: 'text', label: 'Text' },
              { value: 'json', label: 'Structured JSON' },
            ],
          },
          {
            key: 'outputSchema',
            label: 'JSON shape',
            control: 'json',
            required: false,
            advanced: true,
            showWhen: { key: 'outputFormat', values: ['json'] },
            placeholder: '{ "score": "number", "fixes": "text" }',
          },
          {
            key: 'tools',
            label: 'Allowed tools',
            control: 'tool',
            required: false,
            advanced: true,
            help: 'Defaults to everything the Dot is permitted to use.',
          },
          {
            key: 'perItem',
            label: 'Run once per item',
            control: 'toggle',
            required: false,
            advanced: true,
            help: 'When the input is a list, run this step for each item.',
            showWhen: { key: 'reviewBeforeSave', values: ['', 'false'] },
          },
          {
            key: 'reviewBeforeSave',
            label: 'Ask me before this Dot saves a page',
            control: 'toggle',
            required: false,
            advanced: true,
          },
          {
            key: 'thread',
            label: 'Conversation',
            control: 'select',
            required: false,
            advanced: true,
            default: 'fresh',
            help: 'Keyed threads remember earlier runs with the same key, such as a Slack thread.',
            options: [
              { value: 'fresh', label: 'Fresh thread each run' },
              { value: 'continue', label: "Continue this flow's thread" },
              { value: 'keyed', label: 'One thread per key' },
            ],
          },
          {
            key: 'threadKey',
            label: 'Thread key',
            control: 'text',
            required: true,
            advanced: true,
            placeholder: '{{start.slackThread}}',
            showWhen: { key: 'thread', values: ['keyed'] },
          },
        ],
      },
      {
        type: 'dot-decide',
        typeVersion: 1,
        label: 'Dot decides',
        description:
          'Let a Dot read the input and pick one of the branches you name. Each branch becomes its own output.',
        icon: 'Split',
        dynamicOutputs: 'branches',
        inputs: [{ id: 'input', label: 'Input', kind: 'any' }],
        outputs: [],
        config: [
          { key: 'dot', label: 'Dot', control: 'dot', required: true },
          {
            key: 'question',
            label: 'Question',
            control: 'textarea',
            required: true,
            placeholder:
              'Is this a bug report, a how-to question, or a feature request?',
          },
          {
            key: 'branches',
            label: 'Branches',
            control: 'list',
            required: true,
            placeholder: 'Bug, Question, Request',
            help: 'One output per branch.',
          },
          {
            key: 'otherwise',
            label: 'Add an Otherwise branch',
            control: 'toggle',
            required: false,
            default: true,
          },
        ],
      },
    ],
  },
  {
    id: 'pages',
    label: 'Pages',
    color: '#0d9488',
    nodes: [
      {
        type: 'read-page',
        typeVersion: 1,
        label: 'Read page',
        description:
          'Pull a page, or the index of a Space, into the flow so Dots can work from what is already written.',
        icon: 'FileText',
        inputs: [CONTEXT_IN],
        outputs: [
          { id: 'text', label: 'Text', kind: 'text' },
          { id: 'page', label: 'Page', kind: 'json' },
        ],
        config: [
          { key: 'space', label: 'Space', control: 'space', required: true },
          {
            key: 'mode',
            label: 'Read',
            control: 'select',
            required: false,
            default: 'page',
            options: [
              { value: 'page', label: 'One page' },
              { value: 'newest', label: 'The newest pages' },
              { value: 'all', label: 'All pages in the Space' },
            ],
          },
          {
            key: 'page',
            label: 'Page',
            control: 'page',
            required: true,
            showWhen: { key: 'mode', values: ['page'] },
          },
          {
            key: 'limit',
            label: 'How many',
            control: 'number',
            required: false,
            default: 5,
            showWhen: { key: 'mode', values: ['newest'] },
          },
          {
            key: 'includeContent',
            label: 'Include full page text',
            control: 'toggle',
            required: false,
            default: true,
            advanced: true,
            showWhen: { key: 'mode', values: ['newest', 'all'] },
          },
        ],
      },
      {
        type: 'save-page',
        typeVersion: 1,
        label: 'Save page',
        description:
          'Create, update, or append to a page in a Space. With review on, the flow pauses on the Approve & save card first.',
        icon: 'FilePlus2',
        inputs: [
          { id: 'content', label: 'Content', kind: 'text', multiple: true },
          { id: 'title', label: 'Title', kind: 'text' },
          { id: 'page', label: 'Page ref', kind: 'json' },
        ],
        outputs: [
          { id: 'saved', label: 'Saved page', kind: 'json' },
          { id: 'declined', label: 'Declined', kind: 'any' },
        ],
        config: [
          { key: 'space', label: 'Space', control: 'space', required: true },
          {
            key: 'mode',
            label: 'Action',
            control: 'select',
            required: false,
            default: 'create',
            options: [
              { value: 'create', label: 'Create a page' },
              { value: 'update', label: 'Replace a page' },
              { value: 'append', label: 'Append to a page' },
            ],
          },
          {
            key: 'title',
            label: 'Title',
            control: 'text',
            required: false,
            placeholder: '{{start.input}}',
            showWhen: { key: 'mode', values: ['create'] },
          },
          {
            key: 'page',
            label: 'Page',
            control: 'page',
            required: true,
            showWhen: { key: 'mode', values: ['update', 'append'] },
          },
          {
            key: 'parentPage',
            label: 'Inside page',
            control: 'page',
            required: false,
            advanced: true,
            showWhen: { key: 'mode', values: ['create'] },
          },
          {
            key: 'review',
            label: 'Ask me before saving',
            control: 'toggle',
            required: false,
            default: true,
          },
          {
            key: 'onConflict',
            label: 'If the page changed meanwhile',
            control: 'select',
            required: false,
            advanced: true,
            default: 'retry',
            showWhen: { key: 'mode', values: ['update', 'append'] },
            options: [
              { value: 'retry', label: 'Re-read and retry' },
              { value: 'stop', label: 'Stop the run' },
            ],
          },
          {
            key: 'perItem',
            label: 'Save once per item',
            control: 'toggle',
            required: false,
            advanced: true,
            help: 'Available when the page is saved without asking first.',
            showWhen: { key: 'review', values: ['false'] },
          },
        ],
      },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    color: '#7c3aed',
    nodes: [
      {
        type: 'web-research',
        typeVersion: 1,
        label: 'Web research',
        description:
          'Search the web and read the top pages, returning findings with sources. No Dot needed.',
        icon: 'Globe',
        inputs: [CONTEXT_IN],
        outputs: [
          { id: 'findings', label: 'Findings', kind: 'text' },
          { id: 'sources', label: 'Sources', kind: 'json' },
        ],
        config: [
          {
            key: 'mode',
            label: 'Mode',
            control: 'select',
            required: false,
            default: 'search',
            options: [
              { value: 'search', label: 'Search the web' },
              { value: 'read', label: 'Read specific URLs' },
            ],
          },
          {
            key: 'query',
            label: 'Research question',
            control: 'textarea',
            required: true,
            placeholder: 'Latest news about {{start.input}}',
          },
          {
            key: 'depth',
            label: 'Depth',
            control: 'select',
            required: false,
            default: 'quick',
            options: [
              { value: 'quick', label: 'Quick' },
              { value: 'thorough', label: 'Thorough' },
            ],
          },
          {
            key: 'maxSources',
            label: 'Max sources',
            control: 'number',
            required: false,
            default: 5,
            advanced: true,
          },
        ],
      },
      {
        type: 'mcp-tool',
        typeVersion: 1,
        label: 'Connected app',
        description:
          "Call one tool from a Dot's connection at a fixed point, without asking a Dot to decide.",
        icon: 'Plug',
        inputs: [{ id: 'input', label: 'Input', kind: 'any' }],
        outputs: [
          { id: 'result', label: 'Result', kind: 'json' },
          { id: 'text', label: 'Text', kind: 'text' },
        ],
        config: [
          {
            key: 'dot',
            label: 'Dot with the connection',
            control: 'dot',
            required: true,
          },
          { key: 'tool', label: 'Tool', control: 'tool', required: true },
          {
            key: 'arguments',
            label: 'Arguments',
            control: 'json',
            required: false,
            placeholder: '{ "query": "{{start.input}}" }',
          },
          {
            key: 'approval',
            label: 'Approval',
            control: 'select',
            required: false,
            default: 'inherit',
            advanced: true,
            options: [
              { value: 'inherit', label: 'Use the connection setting' },
              { value: 'always', label: 'Always ask me' },
              { value: 'never', label: 'Never ask' },
            ],
          },
        ],
      },
      {
        type: 'send-message',
        typeVersion: 1,
        label: 'Send message',
        description:
          'Post a message to Slack or to your in-app inbox. The usual last step of digests and triage flows.',
        icon: 'Send',
        inputs: [
          { id: 'content', label: 'Content', kind: 'any', multiple: true },
        ],
        outputs: [{ id: 'sent', label: 'Sent', kind: 'json' }],
        config: [
          {
            key: 'destination',
            label: 'Send to',
            control: 'select',
            required: true,
            default: 'inbox',
            options: [
              { value: 'inbox', label: 'Run log' },
              // Posting into an arbitrary channel needs an API the Channels
              // SDK does not expose yet, so it stays declared-but-unavailable
              // and lintFlow warns before the run rather than during it.
              // Replying in the thread that started the run works: the Slack
              // Start hands the run that thread.
              { value: 'slack', label: 'Slack channel', unavailable: true },
              {
                value: 'thread',
                label: 'The Slack thread that started this flow',
              },
            ],
          },
          {
            key: 'slackChannel',
            label: 'Channel',
            control: 'text',
            required: true,
            placeholder: '#team-updates',
            showWhen: { key: 'destination', values: ['slack'] },
          },
          {
            key: 'message',
            label: 'Message',
            control: 'textarea',
            required: true,
            placeholder: '{{digest.result}}',
          },
        ],
      },
    ],
  },
  {
    id: 'logic',
    label: 'Logic',
    color: '#64748b',
    nodes: [
      {
        type: 'branch',
        typeVersion: 1,
        label: 'Branch',
        description:
          'A deterministic yes/no on a value: contains, equals, is empty, greater than, matches. For rules that never need a Dot.',
        icon: 'GitFork',
        inputs: [{ id: 'input', label: 'Input', kind: 'any' }],
        outputs: [
          { id: 'yes', label: 'Yes', kind: 'any' },
          { id: 'no', label: 'No', kind: 'any' },
        ],
        config: [
          {
            key: 'field',
            label: 'Check',
            control: 'text',
            required: true,
            placeholder: '{{editor.data.score}}',
          },
          {
            key: 'operator',
            label: 'Condition',
            control: 'select',
            required: true,
            default: 'contains',
            options: [
              { value: 'contains', label: 'contains' },
              { value: 'equals', label: 'equals' },
              { value: 'empty', label: 'is empty' },
              { value: 'gt', label: 'is greater than' },
              { value: 'lt', label: 'is less than' },
              { value: 'matches', label: 'matches pattern' },
            ],
          },
          {
            key: 'value',
            label: 'Value',
            control: 'text',
            required: false,
            placeholder: '7',
          },
          {
            key: 'caseSensitive',
            label: 'Case sensitive',
            control: 'toggle',
            required: false,
            advanced: true,
          },
        ],
      },
      {
        type: 'combine',
        typeVersion: 1,
        label: 'Combine',
        description:
          'Wait for several branches and join their results into one text, without spending a Dot turn.',
        icon: 'Merge',
        inputs: [
          { id: 'values', label: 'Values', kind: 'any', multiple: true },
        ],
        outputs: [{ id: 'text', label: 'Text', kind: 'text' }],
        config: [
          {
            key: 'template',
            label: 'Template',
            control: 'textarea',
            required: false,
            placeholder:
              'Research:\n{{research.findings}}\n\nDraft:\n{{writer.result}}',
            help: 'Leave empty to join the inputs in arrival order.',
          },
          {
            key: 'separator',
            label: 'Separator',
            control: 'text',
            required: false,
            default: '\n\n',
            advanced: true,
          },
        ],
      },
    ],
  },
  {
    id: 'people',
    label: 'People',
    color: '#16a34a',
    nodes: [
      {
        type: 'human-review',
        typeVersion: 1,
        label: 'Human review',
        description:
          'Pause and ask a person. Reuses the Approve & save / Decline card in-app and can notify Slack. Each button becomes a branch.',
        icon: 'UserCheck',
        dynamicOutputs: 'actions',
        inputs: [{ id: 'draft', label: 'Draft', kind: 'any' }],
        outputs: [],
        config: [
          {
            key: 'message',
            label: 'What to ask',
            control: 'textarea',
            required: true,
            placeholder: 'Review this draft before it is published.',
          },
          {
            key: 'actions',
            label: 'Buttons',
            control: 'select',
            required: false,
            default: 'approve-changes-decline',
            options: [
              { value: 'approve-decline', label: 'Approve / Decline' },
              {
                value: 'approve-changes-decline',
                label: 'Approve / Request changes / Decline',
              },
            ],
          },
          {
            key: 'allowEdits',
            label: 'Reviewer can edit the draft',
            control: 'toggle',
            required: false,
            default: true,
            help: 'Edited text leaves on Approved.',
          },
          {
            key: 'saveApproved',
            label: 'Save the approved draft as a page',
            control: 'toggle',
            required: false,
            default: false,
          },
          {
            key: 'space',
            label: 'Save into',
            control: 'space',
            required: true,
            showWhen: { key: 'saveApproved', values: ['true'] },
          },
          {
            key: 'pageTitle',
            label: 'Page title',
            control: 'text',
            required: false,
            placeholder: '{{start.input}}',
            showWhen: { key: 'saveApproved', values: ['true'] },
          },
          {
            key: 'notify',
            label: 'Notify',
            control: 'select',
            required: false,
            default: 'app',
            options: [
              { value: 'app', label: 'In the app' },
              { value: 'slack', label: 'Slack DM' },
              { value: 'both', label: 'Both' },
            ],
          },
          {
            key: 'requireFeedback',
            label: 'Require a note on Request changes or Decline',
            control: 'toggle',
            required: false,
            advanced: true,
            default: true,
          },
          {
            key: 'maxRevisions',
            label: 'Max revision rounds',
            control: 'number',
            required: false,
            advanced: true,
            default: 3,
            help: 'When Changes requested loops back to an earlier step.',
          },
          {
            key: 'timeoutHours',
            label: 'Time out after (hours)',
            control: 'number',
            required: false,
            advanced: true,
          },
          {
            key: 'onTimeout',
            label: 'On timeout',
            control: 'select',
            required: false,
            advanced: true,
            default: 'wait',
            options: [
              { value: 'wait', label: 'Keep waiting' },
              { value: 'decline', label: 'Decline' },
              { value: 'approve', label: 'Approve' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'notes',
    label: 'Notes',
    color: '#f59e0b',
    nodes: [
      {
        type: 'note',
        typeVersion: 1,
        label: 'Note',
        description:
          'A sticky note for the humans reading the canvas. Not executed and has no ports.',
        icon: 'StickyNote',
        decorative: true,
        inputs: [],
        outputs: [],
        config: [
          {
            key: 'text',
            label: 'Text',
            control: 'textarea',
            required: false,
            placeholder: 'Explain what this part of the flow does.',
          },
          {
            key: 'color',
            label: 'Colour',
            control: 'select',
            required: false,
            default: 'amber',
            options: [
              { value: 'amber', label: 'Amber' },
              { value: 'orange', label: 'Orange' },
              { value: 'mint', label: 'Mint' },
              { value: 'sky', label: 'Sky' },
              { value: 'grey', label: 'Grey' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'team',
    label: 'Advanced',
    // Every node filed here ships, so the category carries a colour of its
    // own rather than the grey that used to mean "coming soon". Indigo keeps
    // it apart from Logic's slate and Actions' violet.
    color: '#4f46e5',
    nodes: [
      {
        type: 'dot-team',
        typeVersion: 1,
        label: 'Dot team',
        description:
          'A manager Dot delegates to specialist Dots in a bounded huddle and returns one result.',
        icon: 'Users',
        inputs: [CONTEXT_IN],
        outputs: [
          { id: 'result', label: 'Result', kind: 'text' },
          { id: 'log', label: 'Delegation log', kind: 'json' },
        ],
        config: [
          {
            key: 'manager',
            label: 'Manager Dot',
            control: 'dot',
            required: true,
          },
          { key: 'goal', label: 'Goal', control: 'textarea', required: true },
          {
            key: 'workers',
            label: 'Workers',
            control: 'json',
            required: true,
            placeholder:
              '[{ "dotId": "dot_123", "when": "Checks the numbers" }]',
            help: 'Rows of { dotId, when }. The manager asks a worker by name and reads its answer.',
          },
          {
            key: 'maxRounds',
            label: 'Max rounds',
            control: 'number',
            required: false,
            default: 8,
            help: 'How many times the manager may delegate before it has to conclude.',
          },
        ],
      },
      {
        type: 'for-each',
        typeVersion: 1,
        label: 'For each',
        description:
          'Run the steps inside once per item of a list, then continue with the collected results.',
        icon: 'Repeat',
        inputs: [{ id: 'list', label: 'List', kind: 'json' }],
        outputs: [
          { id: 'item', label: 'Item', kind: 'json' },
          { id: 'results', label: 'Results', kind: 'json' },
        ],
        config: [
          {
            key: 'maxItems',
            label: 'Max items',
            control: 'number',
            required: false,
            default: 25,
          },
          {
            key: 'onItemError',
            label: 'If one item fails',
            control: 'select',
            required: false,
            default: 'skip',
            options: [
              { value: 'skip', label: 'Skip that item and carry on' },
              { value: 'stop', label: 'Stop the loop' },
            ],
          },
          {
            key: 'concurrency',
            label: 'Items at once',
            control: 'number',
            required: false,
            advanced: true,
            default: 1,
            help: `One at a time by default; up to ${FOR_EACH_MAX_CONCURRENCY}.`,
          },
        ],
      },
      {
        type: 'run-flow',
        typeVersion: 1,
        label: 'Run flow',
        description: 'Use another flow as a step.',
        icon: 'Workflow',
        inputs: [{ id: 'input', label: 'Input', kind: 'any' }],
        outputs: [{ id: 'result', label: 'Result', kind: 'any' }],
        config: [
          {
            key: 'flow',
            label: 'Flow',
            control: 'select',
            required: true,
            options: [],
          },
          {
            key: 'inputMapping',
            label: 'Inputs',
            control: 'json',
            required: false,
            advanced: true,
            placeholder: '{ "audience": "{{start.input}}" }',
            help: 'Fields handed to that flow, where they read as {{start.<name>}}.',
          },
        ],
      },
      {
        type: 'computer-task',
        typeVersion: 1,
        label: 'Computer task',
        description:
          'Have a Dot with an isolated computer do browser, file, or shell work.',
        icon: 'Monitor',
        inputs: [CONTEXT_IN],
        outputs: [{ id: 'result', label: 'Result', kind: 'text' }],
        config: [
          { key: 'dot', label: 'Dot', control: 'dot', required: true },
          { key: 'task', label: 'Task', control: 'textarea', required: true },
          {
            key: 'startUrl',
            label: 'Start at',
            control: 'text',
            required: false,
            placeholder: 'https://example.com',
            help: 'Opened in the computer before the Dot starts.',
          },
        ],
      },
      {
        type: 'wait',
        typeVersion: 1,
        label: 'Wait',
        description: 'Pause for a duration before continuing.',
        icon: 'Clock',
        inputs: [{ id: 'input', label: 'Input', kind: 'any' }],
        outputs: [{ id: 'output', label: 'Output', kind: 'any' }],
        config: [
          {
            key: 'minutes',
            label: 'Minutes',
            control: 'number',
            required: true,
            default: 30,
            help: `Up to ${WAIT_MAX_MINUTES} (24 hours). The run parks and nothing is held open while it waits.`,
          },
        ],
      },
    ],
  },
];

export const NODE_SPECS: Record<string, NodeSpec> = Object.fromEntries(
  NODE_CATALOG.flatMap((category) =>
    category.nodes.map((node) => [node.type, node]),
  ),
);
/** Settings every executable node shares; shown in the Advanced tab. */
export const COMMON_SETTINGS: ConfigField[] = [
  {
    key: 'startWhen',
    label: 'Start when',
    control: 'select',
    required: false,
    advanced: true,
    default: 'all',
    options: [
      { value: 'all', label: 'All connected inputs have arrived' },
      { value: 'first', label: 'The first input arrives' },
    ],
  },
  {
    key: 'onError',
    label: 'If this step fails',
    control: 'select',
    required: false,
    advanced: true,
    default: 'stop',
    options: [
      { value: 'stop', label: 'Stop the run' },
      { value: 'retry', label: 'Retry once, then stop' },
      { value: 'continue', label: 'Continue with an empty result' },
    ],
  },
  {
    key: 'timeLimitMinutes',
    label: 'Time limit (minutes)',
    control: 'number',
    required: false,
    advanced: true,
  },
  {
    key: 'cardNote',
    label: 'Note shown on the card',
    control: 'text',
    required: false,
    advanced: true,
    placeholder: 'Why this step exists',
  },
];
/** Catalog fields plus the shared settings for executable nodes. */
export function nodeFields(type: string): ConfigField[] {
  const spec = NODE_SPECS[type];
  if (!spec) return [];
  if (spec.decorative || spec.type === 'start') return spec.config;
  return [...spec.config, ...COMMON_SETTINGS];
}
/**
 * True when the value chosen for a select is one the catalog declares but
 * cannot carry out yet (see ConfigOption.unavailable).
 */
export function optionUnavailable(type: string, key: string, value: unknown) {
  return !!nodeFields(type)
    .find((field) => field.key === key)
    ?.options?.find((option) => option.value === String(value ?? ''))
    ?.unavailable;
}
export function nodeCategory(type: string): NodeCategory | undefined {
  return NODE_CATALOG.find((category) =>
    category.nodes.some((node) => node.type === type),
  );
}

/** Stored graph. Positions are canvas coordinates. */
export interface FlowNode {
  id: string;
  type: string;
  typeVersion: number;
  /** User-given name; falls back to the spec label. */
  label?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  collapsed?: boolean;
  width?: number;
  height?: number;
  /**
   * Container membership. A node inside a For each body carries the
   * container's id; its `position` is then relative to the container's
   * top-left, matching React Flow's parent/child model. Only `for-each`
   * may be a parent, and containers do not nest.
   */
  parentId?: string;
}
export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}
export interface FlowGraph {
  schema: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
}
export interface Flow {
  id: string;
  name: string;
  description: string;
  graph: FlowGraph;
  /** Optimistic concurrency token; increments on every saved change. */
  revision: number;
  /** Named version that triggers run; null while the flow is a draft. */
  publishedVersionId: string | null;
  /** Revision at the time of the last publish, to detect unpublished edits. */
  publishedRevision: number | null;
  createdAt: number;
  updatedAt: number;
}
export type FlowStatus = 'draft' | 'published' | 'changed';
export function flowStatus(
  flow: Pick<Flow, 'publishedVersionId' | 'publishedRevision' | 'revision'>,
): FlowStatus {
  if (!flow.publishedVersionId) return 'draft';
  return flow.publishedRevision === flow.revision ? 'published' : 'changed';
}
export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  trigger: string;
  nodeCount: number;
  nodeTypes: string[];
  revision: number;
  status: FlowStatus;
  updatedAt: number;
}
export interface FlowVersion {
  id: string;
  flowId: string;
  label: string | null;
  source: 'autosave' | 'named' | 'restore';
  createdAt: number;
}
export const FLOW_LIMITS = {
  nodes: 200,
  edges: 400,
  name: 80,
  description: 500,
};

export function nodeLabel(node: Pick<FlowNode, 'type' | 'label'>) {
  return node.label?.trim() || NODE_SPECS[node.type]?.label || node.type;
}
export function listValues(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}
/** Output ports, including ones derived from configuration. */
export function nodeOutputs(
  node: Pick<FlowNode, 'type' | 'config'>,
): PortSpec[] {
  const spec = NODE_SPECS[node.type];
  if (!spec) return [];
  if (spec.dynamicOutputs === 'branches') {
    const branches = listValues(node.config.branches).map((label) => ({
      id: `branch:${label}`,
      label,
      kind: 'any' as const,
    }));
    const otherwise = node.config.otherwise ?? true;
    return otherwise
      ? [...branches, { id: 'otherwise', label: 'Otherwise', kind: 'any' }]
      : branches;
  }
  if (spec.dynamicOutputs === 'actions') {
    const actions = String(node.config.actions ?? 'approve-changes-decline');
    const ports: PortSpec[] = [
      { id: 'approved', label: 'Approved', kind: 'any' },
    ];
    if (actions === 'approve-changes-decline')
      ports.push({ id: 'changes', label: 'Changes requested', kind: 'text' });
    ports.push({ id: 'declined', label: 'Declined', kind: 'any' });
    return ports;
  }
  return spec.outputs;
}
export function nodeInputs(node: Pick<FlowNode, 'type'>): PortSpec[] {
  return NODE_SPECS[node.type]?.inputs ?? [];
}
export function kindsCompatible(source: PortKind, target: PortKind) {
  if (source === 'any' || target === 'any') return true;
  if (source === 'trigger') return target === 'trigger';
  return source === target;
}
/** Whether a field is visible given the node's current configuration. */
export function fieldVisible(
  field: ConfigField,
  config: Record<string, unknown>,
  type: string,
) {
  if (!field.showWhen) return true;
  const merged = configWithDefaults(type, config);
  return field.showWhen.values.includes(
    String(merged[field.showWhen.key] ?? ''),
  );
}
/** The node's configuration with catalog defaults filled in. */
export function configWithDefaults(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of NODE_SPECS[type]?.config ?? [])
    if (field.default !== undefined) merged[field.key] = field.default;
  for (const [key, value] of Object.entries(config))
    if (value !== undefined && value !== null && value !== '')
      merged[key] = value;
  return merged;
}
function isBlank(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}

export interface FlowProblem {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
export interface LintContext {
  dots: { id: string }[];
  spaces: { id: string }[];
  /**
   * The flow being linted, and every flow a Run flow step could point at.
   * Both are optional: without them a Run flow step is only checked for a
   * chosen flow, and the recursion rules below stay quiet rather than
   * guessing. With them, `flow-cycle` catches a flow that calls itself
   * directly or through another flow before the run ever starts.
   */
  flowId?: string;
  flows?: { id: string; name?: string; graph: Pick<FlowGraph, 'nodes'> }[];
}
/** The flows a graph's Run flow steps point at. */
export function flowReferences(graph: Pick<FlowGraph, 'nodes'>): string[] {
  return [
    ...new Set(
      graph.nodes
        .filter((node) => node.type === 'run-flow')
        .map((node) => String(node.config.flow ?? '').trim())
        .filter(Boolean),
    ),
  ];
}
/**
 * Whether `from` can reach `to` by following Run flow references, `from`
 * included: the static half of the engine's recursion guard.
 */
export function flowReaches(
  flows: { id: string; graph: Pick<FlowGraph, 'nodes'> }[],
  from: string,
  to: string,
): boolean {
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const flow = byId.get(current);
    if (flow) queue.push(...flowReferences(flow.graph));
  }
  return false;
}
/** Whether adding source->target would create a cycle. */
export function createsCycle(
  edges: Pick<FlowEdge, 'source' | 'target'>[],
  source: string,
  target: string,
) {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.source) ?? [];
    list.push(edge.target);
    next.set(edge.source, list);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(next.get(current) ?? []));
  }
  return false;
}
/**
 * Why a step cannot sit inside a For each body, or undefined when it can.
 *
 * Driven by the same facts the engine reads rather than a hand-kept list: a
 * body step must hand back an output (`runBodyStep` in
 * src/server/flow-runner.ts refuses anything else), so every step that can
 * park — a review, an approval, a Wait — is refused while the flow is drawn
 * instead of silently producing nothing once per item. Control-flow nodes are
 * refused for the opposite reason: the body is driven by its container, so a
 * Start in there is never fired and a Finish in there rewrites the run result
 * once per item.
 */
export function bodyRefusal(
  node: Pick<FlowNode, 'type' | 'config'>,
): { level: FlowProblem['level']; reason: string } | undefined {
  const config = configWithDefaults(node.type, node.config);
  switch (node.type) {
    case 'for-each':
      return { level: 'error', reason: 'For each containers do not nest' };
    case 'start':
      return {
        level: 'error',
        reason:
          'a loop body is driven by its container, so a Start in there never fires',
      };
    case 'finish':
      return {
        level: 'error',
        reason: 'the run result cannot be rewritten once per item',
      };
    case 'human-review':
      return {
        level: 'error',
        reason: 'a loop cannot pause for a person in this release',
      };
    case 'wait':
      return { level: 'error', reason: 'a loop cannot pause partway through' };
    case 'save-page':
      return config.review !== false
        ? {
            level: 'error',
            reason:
              'it asks you before saving; turn "Ask me before saving" off',
          }
        : undefined;
    case 'dot-task':
      return config.reviewBeforeSave
        ? {
            level: 'error',
            reason:
              'it asks you before saving; turn "Ask me before saving" off',
          }
        : undefined;
    case 'mcp-tool': {
      const approval = String(config.approval ?? 'inherit');
      if (approval === 'always')
        return {
          level: 'error',
          reason:
            'it always asks before running; set its approval to "Never ask"',
        };
      // 'inherit' depends on the tool, which only the server can resolve.
      return approval === 'inherit'
        ? {
            level: 'warning',
            reason:
              'it will fail for every item if the chosen tool asks before running; set its approval to "Never ask"',
          }
        : undefined;
    }
    default:
      return undefined;
  }
}
export function lintFlow(
  graph: FlowGraph,
  context: LintContext,
): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const starts = graph.nodes.filter((node) => node.type === 'start');
  if (!starts.length)
    problems.push({
      level: 'error',
      code: 'no-start',
      message: 'Add a Start node.',
    });
  const finishes = graph.nodes.filter((node) => node.type === 'finish');
  if (!finishes.length)
    problems.push({
      level: 'warning',
      code: 'no-finish',
      message: 'Add a Finish node so the run has a result.',
    });
  const finishLabels = new Map<string, FlowNode>();
  for (const node of finishes) {
    const label = String(node.config.label ?? '').trim() || 'Result';
    if (finishLabels.has(label))
      problems.push({
        level: 'error',
        code: 'duplicate-finish',
        message: `Two Finish nodes are both called "${label}". Give each a different label.`,
        nodeId: node.id,
      });
    finishLabels.set(label, node);
  }
  // The same shape the engine resolves (TOKEN_PATTERN in flow-runner.ts),
  // including the `{{slug.port.key}}` form that indexes into a json value —
  // a stale one of those must be reported, not quietly rendered as ''.
  const tokensOf = (config: Record<string, unknown>) =>
    Object.values(config).flatMap((value) =>
      typeof value === 'string'
        ? [
            ...value.matchAll(
              /\{\{\s*([\w-]+)\.([\w:-]+)(?:\.[\w-]+)*\s*\}\}/g,
            ),
          ].map((m) => ({
            node: m[1],
            port: m[2],
          }))
        : [],
    );
  for (const node of graph.nodes) {
    const spec = NODE_SPECS[node.type];
    const name = nodeLabel(node);
    if (!spec) {
      problems.push({
        level: 'error',
        code: 'unknown-type',
        message: `${name} has an unknown type "${node.type}".`,
        nodeId: node.id,
      });
      continue;
    }
    if (node.typeVersion !== spec.typeVersion)
      problems.push({
        level: 'warning',
        code: 'outdated',
        message: `${name} uses an older version of ${spec.label}. Update the node.`,
        nodeId: node.id,
      });
    const config = configWithDefaults(node.type, node.config);
    for (const field of nodeFields(node.type)) {
      if (!field.required || !fieldVisible(field, config, node.type)) continue;
      const value = config[field.key];
      if (isBlank(value))
        problems.push({
          level: 'error',
          code: 'missing-config',
          message: `${name}: ${field.label} is required.`,
          nodeId: node.id,
        });
      else if (
        field.control === 'dot' &&
        !context.dots.some((dot) => dot.id === value)
      )
        problems.push({
          level: 'error',
          code: 'missing-dot',
          message: `${name}: the chosen Dot no longer exists.`,
          nodeId: node.id,
        });
      else if (
        field.control === 'space' &&
        !context.spaces.some((space) => space.id === value)
      )
        problems.push({
          level: 'error',
          code: 'missing-space',
          message: `${name}: the chosen Space no longer exists.`,
          nodeId: node.id,
        });
    }
    if (spec.decorative) continue;
    if (spec.comingSoon)
      problems.push({
        level: 'error',
        code: 'coming-soon',
        message: `${name} is not available yet.`,
        nodeId: node.id,
      });
    // Design-time honesty: the catalog marks the Slack destinations
    // unavailable, so a flow that picks one hears about it while it is being
    // drawn instead of mid-run. A warning, never a blocker: a draft that
    // wants Slack is still worth saving.
    if (
      (node.type === 'send-message' &&
        optionUnavailable(node.type, 'destination', config.destination)) ||
      (node.type === 'human-review' && config.notify !== 'app')
    )
      problems.push({
        level: 'warning',
        code: 'slack-proactive-unavailable',
        message: `${name}: Slack delivery is not available yet; ${
          node.type === 'send-message'
            ? 'this step will fail'
            : 'this step notifies in the app only'
        }.`,
        nodeId: node.id,
      });
    if (
      config.perItem &&
      ((node.type === 'save-page' && config.review !== false) ||
        (node.type === 'dot-task' && config.reviewBeforeSave))
    )
      problems.push({
        level: 'error',
        code: 'per-item-review',
        message: `${name}: a step that asks you first cannot run once per item. Turn one of them off.`,
        nodeId: node.id,
      });
    // Honesty about the one review setting the engine does not read yet: a
    // review with no decision parks indefinitely, so a flow that counted on
    // the timeout hears about it while it is drawn.
    if (node.type === 'human-review' && Number(config.timeoutHours) > 0)
      problems.push({
        level: 'warning',
        code: 'review-timeout-unavailable',
        message: `${name}: the review timeout is not enforced yet, so this run waits until someone decides.`,
        nodeId: node.id,
      });
    if (node.type === 'wait' && Number(config.minutes) > WAIT_MAX_MINUTES)
      problems.push({
        level: 'error',
        code: 'wait-too-long',
        message: `${name}: a Wait can pause for at most ${WAIT_MAX_MINUTES} minutes (24 hours).`,
        nodeId: node.id,
      });
    if (node.type === 'for-each') {
      const body = bodyNodes(graph, node.id);
      if (node.parentId)
        problems.push({
          level: 'error',
          code: 'nested-container',
          message: `${name}: a For each cannot sit inside another For each.`,
          nodeId: node.id,
        });
      else if (!body.length)
        problems.push({
          level: 'error',
          code: 'empty-body',
          message: `${name} has no steps inside it. Drop the steps to repeat into the container.`,
          nodeId: node.id,
        });
      for (const inner of body) {
        const refusal = bodyRefusal(inner);
        if (refusal)
          problems.push({
            level: refusal.level,
            code: 'body-not-supported',
            message: `${nodeLabel(inner)} cannot run inside ${name}: ${refusal.reason}.`,
            nodeId: inner.id,
          });
        // The per-item fan-out lives in the outer scheduler, so a body step
        // asking for it would have the setting quietly dropped.
        if (configWithDefaults(inner.type, inner.config).perItem)
          problems.push({
            level: 'error',
            code: 'body-not-supported',
            message: `${nodeLabel(inner)} cannot run inside ${name}: a step in a loop already runs once per item, so "once per item" cannot apply again.`,
            nodeId: inner.id,
          });
      }
    }
    // A membership no container drives is a step the engine skips in silence,
    // so the canvas refuses it rather than waiting for the save to 400.
    if (
      node.parentId &&
      node.type !== 'for-each' &&
      !canContain(graph, node.parentId)
    )
      problems.push({
        level: 'error',
        code: 'invalid-container',
        message: `${name} sits inside ${
          byId.get(node.parentId)
            ? nodeLabel(byId.get(node.parentId)!)
            : 'a step'
        }, which is not a For each. Only a For each can hold steps.`,
        nodeId: node.id,
      });
    // Finish and Send message can post back into the Slack thread that
    // started the run, which only exists when a Slack Start fired it.
    if (
      ((node.type === 'finish' && config.replyToTrigger) ||
        (node.type === 'send-message' && config.destination === 'thread')) &&
      !starts.some(
        (start) =>
          configWithDefaults('start', start.config).trigger === 'slack',
      )
    )
      problems.push({
        level: 'warning',
        code: 'reply-without-slack-start',
        message: `${name} replies in the Slack thread that started the flow, but no Start of this flow listens for a Slack mention, so there is no such thread.`,
        nodeId: node.id,
      });
    if (node.type === 'run-flow') {
      const target = String(config.flow ?? '').trim();
      const others = context.flows;
      if (target && others && !others.some((flow) => flow.id === target))
        problems.push({
          level: 'error',
          code: 'missing-flow',
          message: `${name}: the chosen flow no longer exists.`,
          nodeId: node.id,
        });
      else if (target && context.flowId && target === context.flowId)
        problems.push({
          level: 'error',
          code: 'flow-cycle',
          message: `${name}: a flow cannot run itself.`,
          nodeId: node.id,
        });
      else if (
        target &&
        others &&
        context.flowId &&
        flowReaches(others, target, context.flowId)
      )
        problems.push({
          level: 'error',
          code: 'flow-cycle',
          message: `${name}: that flow runs this one again, directly or through another flow.`,
          nodeId: node.id,
        });
    }
    const known = new Set(
      upstreamRefs(graph, node.id).map((ref) =>
        ref.token.replace(/[{}\s]/g, ''),
      ),
    );
    for (const token of tokensOf(node.config))
      if (!known.has(`${token.node}.${token.port}`))
        problems.push({
          level: 'warning',
          code: 'unknown-token',
          message: `${name} refers to {{${token.node}.${token.port}}}, which is not an upstream output.`,
          nodeId: node.id,
        });
    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    const outgoing = graph.edges.filter((edge) => edge.source === node.id);
    if (node.type !== 'start' && !incoming.length)
      problems.push({
        level: 'warning',
        code: 'unreachable',
        message: `${name} has no incoming connection and will never run.`,
        nodeId: node.id,
      });
    // A step at the end of a For each body is not a dead end: the container
    // collects its result for the Results port.
    if (
      node.type !== 'finish' &&
      !node.parentId &&
      nodeOutputs(node).length &&
      !outgoing.length
    )
      problems.push({
        level: 'warning',
        code: 'dead-end',
        message: `${name} leads nowhere.`,
        nodeId: node.id,
      });
  }
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      problems.push({
        level: 'error',
        code: 'dangling-edge',
        message: 'A connection points at a missing node.',
        edgeId: edge.id,
      });
      continue;
    }
    const out = nodeOutputs(source).find(
      (port) => port.id === edge.sourceHandle,
    );
    const inp = nodeInputs(target).find(
      (port) => port.id === edge.targetHandle,
    );
    if (!out || !inp)
      problems.push({
        level: 'error',
        code: 'bad-port',
        message: `The connection from ${nodeLabel(source)} to ${nodeLabel(target)} uses a port that no longer exists.`,
        edgeId: edge.id,
      });
    else if (!kindsCompatible(out.kind, inp.kind))
      problems.push({
        level: 'error',
        code: 'kind-mismatch',
        message: `${nodeLabel(source)} sends ${out.kind} but ${nodeLabel(target)} expects ${inp.kind}.`,
        edgeId: edge.id,
      });
    // A For each body is its own little graph: the only way in is the
    // container's Item port and the only way out is its Results port, which
    // the container fills itself. Anything else would be a step the outer
    // readiness pass can neither schedule nor settle.
    if (source.parentId !== target.parentId) {
      const entering =
        source.id === target.parentId && edge.sourceHandle === 'item';
      if (!entering)
        problems.push({
          level: 'error',
          code: 'container-boundary',
          message: `The connection between ${nodeLabel(source)} and ${nodeLabel(target)} crosses the edge of a For each. Steps inside only connect to each other, to the container's Item, and out through its Results.`,
          edgeId: edge.id,
        });
    }
  }
  const inputCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    const key = `${edge.target}:${edge.targetHandle}`;
    inputCounts.set(key, (inputCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of inputCounts) {
    if (count < 2) continue;
    const [nodeId, handle] = key.split(':');
    const node = byId.get(nodeId);
    const port = node && nodeInputs(node).find((p) => p.id === handle);
    if (node && port && !port.multiple)
      problems.push({
        level: 'error',
        code: 'too-many-inputs',
        message: `${nodeLabel(node)}: ${port.label} accepts one connection.`,
        nodeId,
      });
  }
  for (const edge of graph.edges)
    if (
      createsCycle(
        graph.edges.filter((e) => e.id !== edge.id),
        edge.source,
        edge.target,
      )
    )
      problems.push({
        level: 'error',
        code: 'cycle',
        message: 'Flows cannot loop back on themselves.',
        edgeId: edge.id,
      });
  return problems;
}

/** An output somewhere upstream of a node, usable as a {{chip}}. */
export interface UpstreamRef {
  nodeId: string;
  nodeLabel: string;
  port: string;
  portLabel: string;
  kind: PortKind;
  /** Token inserted into text, e.g. "{{research.findings}}". */
  token: string;
}
/** Short, stable token name for a node: "Web research" -> "web_research". */
export function tokenSlug(node: Pick<FlowNode, 'type' | 'label'>) {
  return (
    nodeLabel(node)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || node.type
  );
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Every node reachable by following edges forward out of `nodeId`. */
function downstreamIds(graph: FlowGraph, nodeId: string) {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }
  const seen = new Set<string>();
  const queue = [...(children.get(nodeId) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === nodeId || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return seen;
}
/**
 * Repair `{{slug.port}}` references after a node is renamed. Chips are written
 * against the slug derived from a node's label, so without this a rename
 * leaves every downstream reference pointing at a name that no longer exists
 * (the linter reports those as `unknown-token`).
 *
 * Returns a new graph whose downstream nodes have `{{oldSlug.<port>}}` (and
 * the `{{oldSlug.<port>.<key>}}` indexing form) rewritten to the new slug in
 * their string config values; applying the new label itself is the caller's
 * job. The graph comes back untouched when the slug does not actually change,
 * when nothing downstream mentions it, or when either slug is ambiguous:
 *
 * - the new slug already belongs to another node, so rewriting would point
 *   two cards at one token;
 * - another node still answers to the old slug, which is the default state
 *   for two cards of the same type (`upstreamRefs` disambiguates them
 *   positionally as `slug` and `slug_2`), so rewriting would silently point
 *   a chip that reads the *other* card at this one.
 *
 * In both cases the references are left for the linter to report rather than
 * repaired into a different meaning.
 */
export function renameToken(
  graph: FlowGraph,
  nodeId: string,
  oldLabel: string | undefined,
  newLabel: string | undefined,
): FlowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  const oldSlug = tokenSlug({ type: node.type, label: oldLabel });
  const newSlug = tokenSlug({ type: node.type, label: newLabel });
  if (oldSlug === newSlug) return graph;
  const ambiguous = (slug: string) =>
    graph.nodes.some(
      (candidate) => candidate.id !== nodeId && tokenSlug(candidate) === slug,
    );
  if (ambiguous(newSlug) || ambiguous(oldSlug)) return graph;
  const downstream = downstreamIds(graph, nodeId);
  if (!downstream.size) return graph;
  // Same shape the linter scans for and the engine resolves, so a repaired
  // reference always matches the chip the linter would otherwise flag; the
  // third group carries the `.key` path of an indexed chip through.
  const pattern = new RegExp(
    `\\{\\{(\\s*)${escapeRegExp(oldSlug)}\\.([\\w:-]+)((?:\\.[\\w-]+)*)(\\s*)\\}\\}`,
    'g',
  );
  let changed = false;
  const nodes = graph.nodes.map((candidate) => {
    if (!downstream.has(candidate.id)) return candidate;
    let touched = false;
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate.config)) {
      if (typeof value !== 'string') {
        config[key] = value;
        continue;
      }
      const next = value.replace(pattern, `{{$1${newSlug}.$2$3$4}}`);
      if (next !== value) touched = true;
      config[key] = next;
    }
    if (!touched) return candidate;
    changed = true;
    return { ...candidate, config };
  });
  return changed ? { ...graph, nodes } : graph;
}
/** Every output reachable upstream of `nodeId`, nearest ancestors first. */
export function upstreamRefs(graph: FlowGraph, nodeId: string): UpstreamRef[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = parents.get(edge.target) ?? [];
    list.push(edge.source);
    parents.set(edge.target, list);
  }
  const order: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [...(parents.get(nodeId) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    queue.push(...(parents.get(current) ?? []));
  }
  const slugs = new Map<string, string>();
  const used = new Set<string>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    let slug = tokenSlug(node);
    let n = 2;
    while (used.has(slug)) slug = `${tokenSlug(node)}_${n++}`;
    used.add(slug);
    slugs.set(id, slug);
  }
  return order.flatMap((id) => {
    const node = byId.get(id);
    if (!node) return [];
    const outputs =
      node.type === 'start'
        ? [{ id: 'input', label: 'Input', kind: 'text' as const }]
        : nodeOutputs(node);
    return outputs.map((port) => ({
      nodeId: id,
      nodeLabel: nodeLabel(node),
      port: port.id,
      portLabel: port.label,
      kind: port.kind,
      token: `{{${slugs.get(id)}.${port.id.replace(/^branch:/, '')}}}`,
    }));
  });
}
/**
 * Execution preview: nodes grouped into waves. Every node in a wave can run in
 * parallel once the previous wave settled. Decorative nodes are left out.
 */
export function runOrder(
  graph: FlowGraph,
): { nodeId: string; step: number; wave: number }[] {
  // Body steps are not outer steps: the container runs the whole body to
  // completion once per item before its Results output exists, so numbering
  // them beside the step fed by Results would describe an order the engine
  // never follows (see pump in src/server/flow-runner.ts, which skips them).
  const executable = graph.nodes.filter(
    (node) => !NODE_SPECS[node.type]?.decorative && !node.parentId,
  );
  const ids = new Set(executable.map((node) => node.id));
  const remaining = new Map<string, number>();
  for (const node of executable)
    remaining.set(
      node.id,
      graph.edges.filter(
        (edge) => edge.target === node.id && ids.has(edge.source),
      ).length,
    );
  const result: { nodeId: string; step: number; wave: number }[] = [];
  let wave = 0;
  let step = 0;
  let ready = executable
    .filter((node) => remaining.get(node.id) === 0)
    .map((node) => node.id);
  const done = new Set<string>();
  while (ready.length) {
    const next: string[] = [];
    for (const id of ready) {
      done.add(id);
      result.push({ nodeId: id, step: ++step, wave });
    }
    for (const id of ready)
      for (const edge of graph.edges)
        if (
          edge.source === id &&
          ids.has(edge.target) &&
          !done.has(edge.target)
        ) {
          const left = (remaining.get(edge.target) ?? 1) - 1;
          remaining.set(edge.target, left);
          if (left === 0) next.push(edge.target);
        }
    ready = [...new Set(next)];
    wave += 1;
  }
  return result;
}
/** Nodes inside a container, in stable order. */
export function bodyNodes(graph: FlowGraph, containerId: string): FlowNode[] {
  return graph.nodes.filter((node) => node.parentId === containerId);
}
/** Containers cannot nest and only `for-each` may hold a body. */
export function canContain(graph: FlowGraph, containerId: string) {
  const container = graph.nodes.find((node) => node.id === containerId);
  return container?.type === 'for-each' && !container.parentId;
}
/**
 * Absolute canvas position, resolving one level of container offset.
 * Edges and layout work in absolute space; storage keeps child positions
 * relative so moving a container moves its body with it.
 */
export function absolutePosition(graph: FlowGraph, node: FlowNode) {
  if (!node.parentId) return node.position;
  const parent = graph.nodes.find((item) => item.id === node.parentId);
  return parent
    ? {
        x: parent.position.x + node.position.x,
        y: parent.position.y + node.position.y,
      }
    : node.position;
}
export function incomingCount(graph: FlowGraph, nodeId: string) {
  return graph.edges.filter((edge) => edge.target === nodeId).length;
}

let counter = 0;
export function newNodeId(prefix = 'n') {
  counter += 1;
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}
export function makeNode(
  type: string,
  position: { x: number; y: number },
  config: Record<string, unknown> = {},
): FlowNode {
  const spec = NODE_SPECS[type];
  return {
    id: newNodeId(),
    type,
    typeVersion: spec?.typeVersion ?? 1,
    position,
    config,
  };
}
export function emptyGraph(): FlowGraph {
  return {
    schema: 1,
    nodes: [makeNode('start', { x: 80, y: 160 })],
    edges: [],
  };
}
export function summarizeGraph(
  graph: FlowGraph,
): Pick<FlowSummary, 'trigger' | 'nodeCount' | 'nodeTypes'> {
  const start = graph.nodes.find((node) => node.type === 'start');
  const trigger = String(start?.config.trigger ?? 'manual');
  const executable = graph.nodes.filter(
    (node) => !NODE_SPECS[node.type]?.decorative,
  );
  return {
    trigger,
    nodeCount: executable.length,
    nodeTypes: [...new Set(executable.map((node) => node.type))],
  };
}
