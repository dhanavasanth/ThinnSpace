/**
 * Model registry.
 *
 * The server already talks to any OpenAI-compatible endpoint through
 * OPENAI_BASE_URL, so supporting several models is mostly a matter of
 * naming them. One entry per model the owner has configured; a Dot picks a
 * default and a conversation may override it.
 *
 * Everything downstream hangs off this: the context meter needs the
 * window, attachments need to know whether a model can see images, and the
 * tool menu needs to know whether it can call tools at all.
 */
export interface ModelSpec {
  /** Stable key used in configuration and stored on conversations. */
  id: string;
  /** What the provider calls it, sent in the request. */
  model: string;
  /** Shown in the picker. */
  label: string;
  /** Shown under the label, e.g. "OpenAI" or "Local". */
  provider: string;
  /** Total context in tokens, for the meter. */
  contextWindow: number;
  /** Largest reply this model should be asked for. */
  maxOutput: number;
  /** Can read images, which gates image attachments. */
  vision: boolean;
  /** Can call tools; a model without this cannot run flows or page tools. */
  tools: boolean;
  /** Overrides the default endpoint when a model lives elsewhere. */
  baseUrl?: string;
  /** Names the environment variable holding this endpoint's key. */
  apiKeyEnv?: string;
  /** False when the capabilities above are the conservative fallback. */
  known?: boolean;
  /** Enabled, but the endpoint no longer offers it. */
  missing?: boolean;
}

/** What the rest of the app needs to know about a model it may call. */
export type ModelCapabilities = Pick<
  ModelSpec,
  'contextWindow' | 'maxOutput' | 'vision' | 'tools'
>;

/**
 * Context windows and capabilities for models people commonly point this
 * at, keyed by the normalised model name. An unknown model still works; it
 * falls back to the conservative defaults below, and the meter says the
 * window is estimated.
 *
 * Exact names only. Families — every dated snapshot, size and quantisation
 * of a model — are matched by MODEL_FAMILIES below, because nobody is
 * going to enumerate `qwen2.5:7b-instruct-q4_K_M`.
 */
export const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  'gpt-4o': {
    contextWindow: 128_000,
    maxOutput: 16_384,
    vision: true,
    tools: true,
  },
  'gpt-4o-mini': {
    contextWindow: 128_000,
    maxOutput: 16_384,
    vision: true,
    tools: true,
  },
  'gpt-4.1': {
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    vision: true,
    tools: true,
  },
  'gpt-4.1-mini': {
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    vision: true,
    tools: true,
  },
  o3: { contextWindow: 200_000, maxOutput: 100_000, vision: true, tools: true },
  'o4-mini': {
    contextWindow: 200_000,
    maxOutput: 100_000,
    vision: true,
    tools: true,
  },
  'claude-sonnet-4': {
    contextWindow: 200_000,
    maxOutput: 64_000,
    vision: true,
    tools: true,
  },
  'claude-opus-4': {
    contextWindow: 200_000,
    maxOutput: 32_000,
    vision: true,
    tools: true,
  },
  'llama-3.3-70b': {
    contextWindow: 128_000,
    maxOutput: 8_192,
    vision: false,
    tools: true,
  },
  'qwen2.5-coder': {
    contextWindow: 32_768,
    maxOutput: 8_192,
    vision: false,
    tools: true,
  },
};

/** Used when a model is not in the table above. */
export const MODEL_FALLBACK: ModelCapabilities = {
  contextWindow: 32_000,
  maxOutput: 4_096,
  vision: false,
  tools: true,
};

export interface ModelFamily {
  /** A readable family name, for the picker's second line. */
  family: string;
  /** Tested against the normalised name; first match wins, so order from
   * most specific to least. */
  match: RegExp;
  capabilities: ModelCapabilities;
}

/**
 * Families, in match order.
 *
 * The point of a family is that the name people actually connect is never
 * the clean one: `openai/gpt-4o-2024-11-20` from OpenRouter,
 * `meta-llama/Llama-3.3-70B-Instruct-Turbo` from Together,
 * `qwen2.5:7b-instruct-q4_K_M` from Ollama. All three are the same model
 * as far as a context meter and a tool menu are concerned.
 *
 * `tools` is the field worth being careful with, since a false positive
 * there means a flow that silently never calls anything: Gemma, Phi and
 * the R1 reasoning distills get `false` because their chat templates have
 * no function-calling slot, whatever a gateway claims on their behalf.
 */
export const MODEL_FAMILIES: ModelFamily[] = [
  // OpenAI
  {
    family: 'GPT-4o',
    match: /^(chat)?gpt-4o/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 16_384,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'GPT-4.1',
    match: /^gpt-4\.1/,
    capabilities: {
      contextWindow: 1_047_576,
      maxOutput: 32_768,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'GPT-4 Turbo',
    match: /^gpt-4(-turbo|-\d{4})/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 4_096,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'GPT-3.5 Turbo',
    match: /^gpt-3\.5/,
    capabilities: {
      contextWindow: 16_385,
      maxOutput: 4_096,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'o-series',
    match: /^o[1345](-|$)/,
    capabilities: {
      contextWindow: 200_000,
      maxOutput: 100_000,
      vision: true,
      tools: true,
    },
  },
  // Anthropic
  {
    family: 'Claude Haiku',
    match: /^claude.*haiku/,
    capabilities: {
      contextWindow: 200_000,
      maxOutput: 8_192,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'Claude Opus',
    match: /^claude.*opus/,
    capabilities: {
      contextWindow: 200_000,
      maxOutput: 32_000,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'Claude',
    match: /^claude/,
    capabilities: {
      contextWindow: 200_000,
      maxOutput: 64_000,
      vision: true,
      tools: true,
    },
  },
  // Google
  {
    family: 'Gemini Flash',
    match: /^gemini.*flash/,
    capabilities: {
      contextWindow: 1_048_576,
      maxOutput: 8_192,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'Gemini',
    match: /^gemini/,
    capabilities: {
      contextWindow: 1_048_576,
      maxOutput: 8_192,
      vision: true,
      tools: true,
    },
  },
  // Qwen. The coder and VL variants differ enough to name separately.
  {
    family: 'Qwen Coder',
    match: /^qwen.*coder/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'Qwen VL',
    match: /^qwen.*-vl/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'QwQ',
    match: /^qwq/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: false,
    },
  },
  {
    family: 'Qwen 3',
    match: /^qwen-?3/,
    capabilities: {
      contextWindow: 40_960,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'Qwen 2.5',
    match: /^qwen-?2(\.5)?/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  // Meta Llama
  {
    family: 'Llama Vision',
    match: /^llama-?3\.2.*vision/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 8_192,
      vision: true,
      tools: false,
    },
  },
  {
    family: 'Llama 4',
    match: /^llama-?4/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 8_192,
      vision: true,
      tools: true,
    },
  },
  {
    family: 'Llama 3',
    match: /^llama-?3/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  // Mistral
  {
    family: 'Mixtral',
    match: /^mixtral/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'Codestral',
    match: /^codestral/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'Mistral Large',
    match: /^mistral-large/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'Mistral',
    match: /^(mistral|ministral|magistral|devstral)/,
    capabilities: {
      contextWindow: 32_768,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  // Google Gemma. No function-calling slot in its chat template.
  {
    family: 'Gemma 3',
    match: /^gemma-?3/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 8_192,
      vision: true,
      tools: false,
    },
  },
  {
    family: 'Gemma',
    match: /^(code)?gemma/,
    capabilities: {
      contextWindow: 8_192,
      maxOutput: 4_096,
      vision: false,
      tools: false,
    },
  },
  // DeepSeek
  {
    family: 'DeepSeek R1',
    match: /^deepseek.*r1/,
    capabilities: {
      contextWindow: 65_536,
      maxOutput: 8_192,
      vision: false,
      tools: false,
    },
  },
  {
    family: 'DeepSeek Coder',
    match: /^deepseek.*coder/,
    capabilities: {
      contextWindow: 65_536,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  {
    family: 'DeepSeek',
    match: /^deepseek/,
    capabilities: {
      contextWindow: 65_536,
      maxOutput: 8_192,
      vision: false,
      tools: true,
    },
  },
  // Microsoft Phi
  {
    family: 'Phi 4',
    match: /^phi-?4/,
    capabilities: {
      contextWindow: 16_384,
      maxOutput: 4_096,
      vision: false,
      tools: false,
    },
  },
  {
    family: 'Phi',
    match: /^phi/,
    capabilities: {
      contextWindow: 128_000,
      maxOutput: 4_096,
      vision: false,
      tools: false,
    },
  },
];

/**
 * The comparable form of a model name.
 *
 * Gateways prefix with the upstream vendor (`openai/gpt-4o`), Ollama and
 * LM Studio suffix with a tag (`qwen2.5:7b`), Together appends a serving
 * flavour (`...-Instruct-Turbo`), and several hosts pin with `@` or
 * `-latest`. None of that changes which model it is.
 */
export function normalizeModelName(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/@.*$/, '')
    .replace(/:/g, '-')
    .replace(/-latest$/, '');
}

/**
 * Best-effort capabilities for a provider model name.
 *
 * Exact name first, then family, then the conservative fallback. `known`
 * is false only in that last case, which is the signal the context meter
 * uses to call its window an estimate — so a wrong family match would be
 * worse than no match, and the patterns are anchored at the start of the
 * normalised name rather than searching inside it.
 */
export function modelDefaults(
  model: string,
): ModelCapabilities & { known: boolean; family?: string } {
  const name = normalizeModelName(model);
  const exact = KNOWN_MODELS[name];
  if (exact) return { ...exact, known: true };
  const family = MODEL_FAMILIES.find((entry) => entry.match.test(name));
  if (family)
    return { ...family.capabilities, known: true, family: family.family };
  return { ...MODEL_FALLBACK, known: false };
}

/**
 * A rough token count. Real counting needs the model's own tokenizer,
 * which differs per provider and is not worth shipping for a gauge, so
 * the meter labels this an estimate rather than pretending to precision.
 * Four characters per token is the usual approximation for English prose;
 * code and other scripts run denser, so this errs low and we round up.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextUsage {
  used: number;
  window: number;
  /** 0 to 1, clamped. */
  ratio: number;
  /** Past this the meter warns; past 1 the request will not fit. */
  level: 'ok' | 'high' | 'full';
  estimated: boolean;
}

/** What the meter under the composer shows. */
export function contextUsage(
  used: number,
  spec: Pick<ModelSpec, 'contextWindow' | 'maxOutput'>,
  estimated = true,
): ContextUsage {
  // The reply has to fit too, so the usable window is what remains.
  const window = Math.max(1, spec.contextWindow - spec.maxOutput);
  const ratio = Math.min(1, used / window);
  return {
    used,
    window,
    ratio,
    level: ratio >= 1 ? 'full' : ratio >= 0.75 ? 'high' : 'ok',
    estimated,
  };
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000)
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
