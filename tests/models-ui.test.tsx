import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({
  api,
  authHeaders: () => ({}),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
import {
  ModelMenu,
  PromptInput,
  SOURCE_NOTE,
  activeModel,
  connectionOf,
  groupModels,
  type ModelIssue,
  type PromptInputProps,
} from '../src/client/composer/PromptInput';
import {
  TestOutcome,
  agoLabel,
  latencyLabel,
  testCandidates,
  usageLabel,
} from '../src/client/composer/ModelsSection';
import { modelDefaults, type ModelSpec } from '../src/shared/models';

/* ---------- fixtures ---------- */

/** What GET /models returns for one enabled model on one connection. */
const spec = (
  connectionId: string,
  model: string,
  provider: string,
  over: Partial<ModelSpec> = {},
): ModelSpec => {
  const caps = modelDefaults(model);
  return {
    id: `${connectionId}:${model}`,
    model,
    label: model,
    provider,
    contextWindow: caps.contextWindow,
    maxOutput: caps.maxOutput,
    vision: caps.vision,
    tools: caps.tools,
    baseUrl: 'http://127.0.0.1:11434/v1',
    ...over,
  };
};
const qwen = spec('ollama1', 'qwen2.5:7b', 'Ollama (local)');
const llama = spec('groq1', 'llama-3.3-70b-versatile', 'Groq', {
  baseUrl: 'https://api.groq.com/openai/v1',
});
const gpt = spec('openai1', 'gpt-4o', 'OpenAI', {
  baseUrl: 'https://api.openai.com/v1',
});
/** Nothing in the capability table matches this, so its numbers are guesses. */
const unknown = spec('custom1', 'house-model-v3', 'Our box');

const composerProps = (
  over: Partial<PromptInputProps> = {},
): PromptInputProps => ({
  value: '',
  onChange: () => undefined,
  onSubmit: () => undefined,
  dotName: 'Ada',
  status: 'idle',
  models: [],
  research: { id: 'research', label: 'Web research' },
  researchOn: false,
  onResearchChange: () => undefined,
  connectors: { id: 'connectors', label: 'Connected apps' },
  source: '',
  onSourceChange: () => undefined,
  voice: { id: 'voice', label: 'Voice' },
  voiceActive: false,
  onVoiceToggle: () => undefined,
  ...over,
});

/* ---------- grouping and resolution ---------- */

describe('picker grouping', () => {
  it('keeps the connection id even when the model name has colons', () => {
    expect(connectionOf(qwen.id)).toBe('ollama1');
    expect(connectionOf('ollama1:qwen2.5:7b')).toBe('ollama1');
  });

  it('groups by connection in order and carries that connection’s error', () => {
    const issues: ModelIssue[] = [
      { id: 'groq1', label: 'Groq', error: 'That key was refused.' },
    ];
    const groups = groupModels([qwen, llama, gpt], issues);
    expect(groups.map((group) => group.label)).toEqual([
      'Ollama (local)',
      'Groq',
      'OpenAI',
    ]);
    expect(groups[1].error).toBe('That key was refused.');
    expect(groups[0].error).toBeUndefined();
  });

  it('puts two models from one connection in a single group', () => {
    const second = spec('ollama1', 'llama3.2', 'Ollama (local)');
    expect(groupModels([qwen, second])).toHaveLength(1);
  });

  it('keeps two connections apart when the preset gave them the same name', () => {
    // Adding Ollama twice is ordinary — a second machine on the network —
    // and both carry the preset's label. Merging them would blame a working
    // endpoint for the other one being down.
    const other = spec('ollama2', 'llama3.2', 'Ollama (local)', {
      baseUrl: 'http://10.0.0.4:11434/v1',
    });
    const issues: ModelIssue[] = [
      { id: 'ollama2', label: 'Ollama (local)', error: 'Could not reach it.' },
    ];
    const groups = groupModels([qwen, other], issues);
    expect(groups.map((group) => group.id)).toEqual(['ollama1', 'ollama2']);
    expect(groups[0].error).toBeUndefined();
    expect(groups[1].error).toBe('Could not reach it.');
  });
});

describe('which model answers', () => {
  const models = [qwen, llama];
  it('prefers an explicit choice and says nothing about it', () => {
    const active = activeModel(models, llama.id, qwen.id);
    expect(active.spec).toBe(llama);
    expect(SOURCE_NOTE[active.source]).toBe('');
  });
  it('falls back to the Dot default and says so', () => {
    const active = activeModel(models, null, llama.id);
    expect(active.spec).toBe(llama);
    expect(SOURCE_NOTE[active.source]).toBe('Dot default');
  });
  it('falls back to the first connected model when nothing is set', () => {
    const active = activeModel(models, null, null);
    expect(active.spec).toBe(qwen);
    expect(SOURCE_NOTE[active.source]).toBe('Default');
  });
  it('says when a chosen model is no longer available', () => {
    const active = activeModel(models, 'removed1:gone', null);
    expect(active.spec).toBe(qwen);
    expect(SOURCE_NOTE[active.source]).toBe('Chosen model gone');
  });
  it('says when a Dot default is no longer available', () => {
    // Deleting the connection a Dot pointed at leaves a dangling spec id.
    // Something else answers, and calling that "Default" would hide that
    // the Dot's own choice is gone.
    const active = activeModel(models, null, 'removed1:gone');
    expect(active.spec).toBe(qwen);
    expect(SOURCE_NOTE[active.source]).toBe('Chosen model gone');
  });
  it('has nothing to offer when nothing is connected', () => {
    expect(activeModel([], 'x', 'y')).toEqual({
      spec: undefined,
      source: 'none',
    });
  });
});

/* ---------- the menu ---------- */

describe('model menu', () => {
  it('groups rows and shows context, connection and capability marks', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[qwen, llama, gpt]}
        activeId={qwen.id}
        onPick={() => undefined}
      />,
    );
    // A group heading per connection, since there is more than one.
    expect(html).toContain('Ollama (local)');
    expect(html).toContain('Groq');
    // Name, connection and window on the row itself.
    expect(html).toContain('qwen2.5:7b');
    expect(html).toContain('128k context');
    expect(html).toContain('gpt-4o');
    // Capability marks.
    expect(html).toContain('>Tools<');
    expect(html).toContain('>Vision<');
    // The active row is checked, so the menu says which model answers.
    expect(html).toContain('aria-checked="true"');
  });

  it('marks the capabilities it actually knows per row', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[llama]}
        activeId={llama.id}
        onPick={() => undefined}
      />,
    );
    // Known model: no estimate note, and no vision claim for a text model.
    expect(html).not.toContain('>Estimated<');
    expect(html).not.toContain('>Vision<');
    expect(html).toContain('>Tools<');
  });

  it('says so when a model’s capabilities are guessed, not known', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[unknown]}
        activeId={unknown.id}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('>Estimated<');
    // And when the server itself reports the model as unknown.
    expect(
      renderToStaticMarkup(
        <ModelMenu
          models={[{ ...llama, known: false }]}
          activeId={llama.id}
          onPick={() => undefined}
        />,
      ),
    ).toContain('>Estimated<');
  });

  it('flags a ticked model the endpoint no longer offers', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[{ ...qwen, missing: true }]}
        activeId={qwen.id}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('>Not offered<');
  });

  it('skips group headings when everything comes from one connection', () => {
    const html = renderToStaticMarkup(
      <ModelMenu models={[qwen]} activeId={qwen.id} onPick={() => undefined} />,
    );
    expect(html).not.toContain('prompt-menu-label');
  });

  it('shows a broken connection rather than hiding it', () => {
    const issues: ModelIssue[] = [
      {
        id: 'ollama1',
        label: 'Ollama (local)',
        error: 'Could not reach http://127.0.0.1:11434/v1.',
      },
    ];
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[qwen, llama]}
        issues={issues}
        activeId={llama.id}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('Could not reach http://127.0.0.1:11434/v1.');
    expect(html).toContain('>Offline<');
  });

  it('offers a way back to the default once a choice is in force', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[qwen, llama]}
        activeId={llama.id}
        dotModelId={qwen.id}
        overridden
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('Use the default');
    expect(html).toContain('Back to qwen2.5:7b');
  });

  it('reports a choice the server refused', () => {
    const html = renderToStaticMarkup(
      <ModelMenu
        models={[qwen]}
        activeId={qwen.id}
        error="That model is not available."
        onPick={() => undefined}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('That model is not available.');
  });
});

/* ---------- the composer around it ---------- */

describe('composer model affordance', () => {
  it('offers to connect a model when none exists', () => {
    const html = renderToStaticMarkup(
      <PromptInput {...composerProps({ models: [] })} />,
    );
    expect(html).toContain('Connect a model');
    expect(html).toContain('No model connected yet. Opens Settings.');
  });

  it('names the model in use and where it came from', () => {
    const html = renderToStaticMarkup(
      <PromptInput
        {...composerProps({ models: [qwen, llama], dotModelId: llama.id })}
      />,
    );
    expect(html).toContain('llama-3.3-70b-versatile');
    expect(html).toContain('Dot default');
  });

  it('says nothing extra once a model is chosen here', () => {
    const html = renderToStaticMarkup(
      <PromptInput
        {...composerProps({
          models: [qwen, llama],
          modelId: qwen.id,
          dotModelId: llama.id,
        })}
      />,
    );
    expect(html).toContain('qwen2.5:7b');
    expect(html).not.toContain('Dot default');
  });

  it('says out loud when a choice was refused, with the menu closed', () => {
    const html = renderToStaticMarkup(
      <PromptInput
        {...composerProps({
          models: [qwen],
          modelId: qwen.id,
          modelError: 'That model is not available.',
        })}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('That model is not available.');
  });

  it('keeps the menus usable while an unfinished setup blocks sending', () => {
    const html = renderToStaticMarkup(
      <PromptInput {...composerProps({ models: [qwen], disabled: true })} />,
    );
    // The send button and field are off, the model and actions menus are not.
    expect(html).toContain('aria-label="Send message" disabled=""');
    expect(html).not.toContain('class="prompt-model " disabled');
    expect(html).toContain('aria-label="Add to this message"');
  });
});

/* ---------- testing a connection ---------- */

describe('connection test', () => {
  it('tests the ticked models, or whatever discovery just found', () => {
    expect(testCandidates({ models: ['qwen2.5:7b'] }, ['a', 'b'])).toEqual([
      'qwen2.5:7b',
    ]);
    expect(testCandidates({ models: [] }, ['qwen2.5:7b'])).toEqual([
      'qwen2.5:7b',
    ]);
    expect(testCandidates({ models: [] })).toEqual([]);
  });

  it('reads latency in the unit a person expects', () => {
    expect(latencyLabel(640)).toBe('640ms');
    expect(latencyLabel(2480)).toBe('2.5s');
    expect(latencyLabel(-1)).toBe('');
  });

  it('ages an older result rather than implying it is current', () => {
    const now = 1_700_000_000_000;
    expect(agoLabel(now - 20_000, now)).toBe('');
    expect(agoLabel(now - 300_000, now)).toBe('5 min ago');
    expect(agoLabel(now - 7_200_000, now)).toBe('2 h ago');
    expect(agoLabel(now - 172_800_000, now)).toBe('2 d ago');
  });

  it('reports tokens only when the provider counted them', () => {
    expect(usageLabel({ promptTokens: 35, completionTokens: 3 })).toBe(
      '38 tokens',
    );
    expect(usageLabel({ totalTokens: 38 })).toBe('38 tokens');
    expect(usageLabel(undefined)).toBe('');
  });

  it('shows the reply, the time it took and what it cost', () => {
    const now = 1_700_000_000_000;
    const html = renderToStaticMarkup(
      <TestOutcome
        now={now}
        result={{
          ok: true,
          model: 'qwen2.5:7b',
          reply: 'connection ok',
          latencyMs: 1840,
          usage: { promptTokens: 35, completionTokens: 3, totalTokens: 38 },
          at: now,
        }}
      />,
    );
    expect(html).toContain('qwen2.5:7b replied in 1.8s');
    expect(html).toContain('38 tokens');
    expect(html).toContain('connection ok');
  });

  it('shows a failure in words the owner can act on', () => {
    const now = 1_700_000_000_000;
    const html = renderToStaticMarkup(
      <TestOutcome
        now={now}
        result={{
          ok: false,
          model: 'qwen2.5:7b',
          latencyMs: 0,
          error: 'Could not reach http://127.0.0.1:11434/v1. Is it running?',
          kind: 'unreachable',
          at: now - 600_000,
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('qwen2.5:7b did not answer.');
    expect(html).toContain('Is it running?');
    // An old failure says how old it is.
    expect(html).toContain('10 min ago');
  });
});
