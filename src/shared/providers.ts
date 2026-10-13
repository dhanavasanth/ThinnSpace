/**
 * Model providers.
 *
 * Every provider here speaks the OpenAI chat-completions shape, which is
 * what lets one client reach all of them. OpenAI and the OpenAI-compatible
 * hosts do so natively; Anthropic and Google both publish a compatibility
 * endpoint; Ollama and LM Studio serve one locally. So "connect whatever
 * you have" is a base URL, an optional key, and a model name.
 *
 * A provider is a preset, not a restriction: `custom` takes any endpoint,
 * and the presets only exist so the common cases need no typing.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  /** Default endpoint, which the owner can override per connection. */
  baseUrl: string;
  /** Local servers need no credential. */
  needsKey: boolean;
  /** Where to get a key, shown next to the field. */
  keyUrl?: string;
  /** Serves GET /models, so the app can offer what the key can reach. */
  canListModels: boolean;
  /** Shown when the endpoint is a compatibility shim rather than native. */
  note?: string;
  /** Offered when the endpoint cannot be listed. */
  suggested?: string[];
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    canListModels: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    canListModels: true,
    note: 'Uses Anthropic’s OpenAI-compatible endpoint.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    canListModels: true,
    note: 'Uses Google’s OpenAI-compatible endpoint.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    canListModels: true,
    note: 'Runs on your machine. Pull a model first with `ollama pull`.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    canListModels: true,
    note: 'Start the local server from LM Studio’s Developer tab.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    canListModels: true,
    note: 'One key for many providers.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    canListModels: true,
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    canListModels: true,
  },
  {
    id: 'custom',
    label: 'Anything OpenAI-compatible',
    baseUrl: '',
    needsKey: false,
    canListModels: true,
    note: 'Any server exposing /chat/completions. Paste its base URL.',
  },
];

export function provider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((item) => item.id === id);
}

/** A configured endpoint. The key never leaves the server. */
export interface ModelConnection {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  /** Whether a key is stored, never the key itself. */
  hasKey: boolean;
  /** Model names the owner enabled from this connection. */
  models: string[];
  /** Last failure from a reachability check, cleared on success. */
  error: string | null;
  createdAt: number;
}

/** Trailing slashes break path joins against these endpoints. */
export function normalizeBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Providers return far more than anyone wants in a picker, including
 * embedding and audio models that cannot hold a conversation. This keeps
 * the obvious non-chat entries out rather than pretending to know every
 * model, so anything unrecognised is still offered.
 */
const NOT_CHAT =
  /(embed|embedding|whisper|tts|audio|speech|moderation|rerank|image|dall-e|vision-encoder|guard)/i;

export function looksLikeChatModel(id: string) {
  return !NOT_CHAT.test(id);
}
