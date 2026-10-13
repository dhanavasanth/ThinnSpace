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
}

/**
 * Context windows and capabilities for models people commonly point this
 * at. An unknown model still works; it simply falls back to the
 * conservative defaults below, and the meter says the window is estimated.
 */
export const KNOWN_MODELS: Record<
  string,
  Pick<ModelSpec, 'contextWindow' | 'maxOutput' | 'vision' | 'tools'>
> = {
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
export const MODEL_FALLBACK = {
  contextWindow: 32_000,
  maxOutput: 4_096,
  vision: false,
  tools: true,
};

/** Best-effort capabilities for a provider model name. */
export function modelDefaults(model: string) {
  const key = Object.keys(KNOWN_MODELS).find((known) =>
    model.toLowerCase().includes(known),
  );
  return key
    ? { ...KNOWN_MODELS[key], known: true }
    : { ...MODEL_FALLBACK, known: false };
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
