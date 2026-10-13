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
 *
 * Speaking the same body shape does not mean speaking the same headers.
 * Ollama wants no credential at all, OpenRouter wants attribution, and
 * Anthropic's compatibility endpoint wants its API version. So a preset
 * also carries how its requests are addressed, and every call is built
 * from that by `requestHeaders` rather than assuming a bearer token.
 */

/** How a provider expects the key to travel. */
export type AuthScheme = 'bearer' | 'none';

/**
 * Which header set a connection has been shown to accept.
 *
 * Some compatibility endpoints reject headers their native API requires,
 * and which they do changes with the path and the deployment. Rather than
 * guess, a probe tries the full set, falls back to the minimal one, and
 * the answer is remembered here so later calls start with what worked.
 */
export type HeaderMode = 'default' | 'minimal';

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
  /**
   * How the key is sent. `none` means the endpoint takes no credential, so
   * no Authorization header is sent even if one is somehow stored.
   */
  auth: AuthScheme;
  /** Headers every request to this provider carries. */
  headers?: Record<string, string>;
  /**
   * Headers sent on the first attempt and dropped if the provider objects
   * to them. Anthropic's `anthropic-version` is the case this exists for:
   * several of its paths reject a request without one, and others reject
   * the header itself.
   */
  negotiableHeaders?: Record<string, string>;
}

/**
 * How this app identifies itself to providers that attribute traffic.
 * OpenRouter shows these on its activity page and in its app rankings, so
 * they are a stable identity rather than the current page's URL.
 */
export const APP_IDENTITY = {
  title: 'ThinnSpace',
  url: 'https://thinnaiq.com',
};

/** The version Anthropic's API has accepted since it was published. */
export const ANTHROPIC_VERSION = '2023-06-01';

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    canListModels: true,
    auth: 'bearer',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    canListModels: true,
    note: 'Uses Anthropic’s OpenAI-compatible endpoint.',
    auth: 'bearer',
    negotiableHeaders: { 'anthropic-version': ANTHROPIC_VERSION },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    canListModels: true,
    note: 'Uses Google’s OpenAI-compatible endpoint.',
    auth: 'bearer',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    canListModels: true,
    note: 'Runs on your machine. Pull a model first with `ollama pull`.',
    auth: 'none',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    canListModels: true,
    note: 'Start the local server from LM Studio’s Developer tab.',
    auth: 'none',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    canListModels: true,
    note: 'One key for many providers.',
    auth: 'bearer',
    headers: {
      'HTTP-Referer': APP_IDENTITY.url,
      'X-Title': APP_IDENTITY.title,
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    canListModels: true,
    auth: 'bearer',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    canListModels: true,
    auth: 'bearer',
  },
  {
    id: 'custom',
    label: 'Anything OpenAI-compatible',
    baseUrl: '',
    needsKey: false,
    canListModels: true,
    note: 'Any server exposing /chat/completions. Paste its base URL.',
    auth: 'bearer',
  },
];

export function provider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((item) => item.id === id);
}

/**
 * Every header a request to a connection needs, built from its preset.
 *
 * This is the single place request shape lives: adding a provider that
 * needs a different credential header or an extra identifier is one entry
 * in PROVIDERS, not another branch at each call site.
 *
 * `bearer` providers only get an Authorization header when a key is
 * actually stored, so a self-hosted endpoint behind no auth works through
 * the `custom` preset without one.
 */
export function requestHeaders(options: {
  providerId: string;
  apiKey?: string | null;
  /** Adds `Content-Type: application/json` for a request with a body. */
  json?: boolean;
  /** Pass 'minimal' to drop headers the endpoint has already rejected. */
  mode?: HeaderMode;
}): Record<string, string> {
  const preset = provider(options.providerId);
  const headers: Record<string, string> = { ...(preset?.headers ?? {}) };
  if ((options.mode ?? 'default') === 'default')
    Object.assign(headers, preset?.negotiableHeaders ?? {});
  const key = options.apiKey?.trim();
  // An unknown provider id is treated as `custom`: bearer if a key exists.
  if (key && (preset?.auth ?? 'bearer') === 'bearer')
    headers.Authorization = `Bearer ${key}`;
  if (options.json) headers['Content-Type'] = 'application/json';
  return headers;
}

/** Whether dropping headers is even an option for this provider. */
export function hasNegotiableHeaders(providerId: string): boolean {
  return Object.keys(provider(providerId)?.negotiableHeaders ?? {}).length > 0;
}

/** Why a connection test failed, so the UI can say what to do about it. */
export type TestFailure =
  | 'unreachable'
  | 'refused'
  | 'missing-model'
  | 'timeout'
  | 'malformed'
  | 'error';

/** The result of asking a connection for one short completion. */
export interface ConnectionTest {
  ok: boolean;
  /** The model that was asked, which may be the connection's first. */
  model: string;
  /** What it said, trimmed, when it said anything. */
  reply?: string;
  /** Wall clock for the whole exchange, including the retry if there was one. */
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
  kind?: TestFailure;
  at: number;
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
  /**
   * Everything the endpoint offered at the last discovery, unfiltered, so
   * the UI can offer "show everything" without probing again.
   */
  allModels: string[];
  /**
   * Enabled models the endpoint no longer offers. They stay enabled —
   * a model pulled from a local server may come back, and discovery is
   * not a reason to silently drop someone's choice.
   */
  missingModels: string[];
  /** Which header set this endpoint accepted; see HeaderMode. */
  headerMode: HeaderMode;
  /** The last completion test, so the UI can show it without re-probing. */
  lastTest: ConnectionTest | null;
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

/**
 * Picker order. Names carry numbers that matter — `qwen2.5:7b` belongs
 * before `qwen2.5:14b`, which a plain string sort gets backwards — and a
 * provider prefix should group rather than decide, so `openai/gpt-4o` and
 * `openai/gpt-4o-mini` stay together.
 */
export function compareModelNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function sortModelNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort(compareModelNames);
}
