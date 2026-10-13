import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  hasNegotiableHeaders,
  looksLikeChatModel,
  normalizeBaseUrl,
  provider,
  requestHeaders,
  sortModelNames,
  type ConnectionTest,
  type HeaderMode,
  type ModelConnection,
  type TestFailure,
} from '../shared/providers.js';
import { modelDefaults, type ModelSpec } from '../shared/models.js';

type Row = {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  models: string;
  error: string | null;
  createdAt: number;
  allModels: string | null;
  missingModels: string | null;
  headerMode: string | null;
  lastTest: string | null;
  tokenField: string | null;
};

/**
 * Which field a provider accepts the output cap in. OpenAI's newer models
 * reject `max_tokens`; plenty of other endpoints have never heard of
 * `max_completion_tokens`. A connection test learns which, and the real
 * chat path has to send the same one or the test proves nothing.
 */
export type TokenField = 'max_tokens' | 'max_completion_tokens';

/** How long a probe waits before giving up on an endpoint. */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * How long a completion test waits. A local model that has to load from
 * disk and warm its KV cache can take tens of seconds to its first token,
 * and reporting that as a failure would be wrong.
 */
const TEST_TIMEOUT_MS = 60_000;

/** The shortest prompt that still proves a round trip end to end. */
const TEST_PROMPT = 'Reply with the single word: ready';

/**
 * Caps on what an endpoint may send back.
 *
 * The request side is bounded by the app's body limit and the timeouts
 * above bound elapsed time, but neither bounds bytes: a fast local or LAN
 * endpoint can deliver tens of megabytes inside the probe timeout, and
 * `response.json()` would hold all of it. So provider bodies are read
 * through a counting reader instead.
 */
const MODELS_BODY_LIMIT = 1_000_000;
const ERROR_BODY_LIMIT = 64_000;

/** The most names one discovery stores, so a catalog cannot bloat the row. */
const MAX_DISCOVERED = 2_000;

/**
 * Removes a connection's own credential from text a provider or the
 * transport produced. Dev proxies and upstream-error passthroughs echo the
 * request they received, headers included, and that text is persisted on
 * the connection and returned by GET /model-connections — the one response
 * that must never carry the key.
 */
function scrub(text: string, key: string | null | undefined): string {
  const secret = key?.trim();
  if (!secret) return text;
  return text.split(secret).join('[key redacted]');
}

/**
 * A request URL under a connection's base. Joined through `URL` rather
 * than concatenated so a base carrying a query string cannot swallow the
 * appended path; `add` rejects those, so the fallback only covers rows
 * stored before that check existed.
 */
function endpointUrl(baseUrl: string, path: string): string {
  try {
    return new URL(path, `${baseUrl}/`).toString();
  } catch {
    return `${baseUrl}/${path}`;
  }
}

/** A body past the caps above, which is refused rather than buffered. */
class BodyTooLargeError extends Error {}

/**
 * The body as text, reading at most `limit` bytes. `strict` refuses an
 * oversized body outright; otherwise whatever fits is kept, which is all
 * an error message needs.
 */
async function readCapped(
  response: Response,
  limit: number,
  strict: boolean,
): Promise<string> {
  const tooLarge = () =>
    new BodyTooLargeError(
      'That endpoint sent more data than this app will read.',
    );
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    if (strict) throw tooLarge();
    await response.body?.cancel().catch(() => undefined);
    return '';
  }
  const body = response.body;
  if (!body) return (await response.text().catch(() => '')).slice(0, limit);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > limit) {
        if (strict) throw tooLarge();
        chunks.push(value);
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  return truncated ? text.slice(0, limit) : text;
}

/**
 * Every request to a connection is built under its address, so it is
 * checked once here rather than failing confusingly later. A non-HTTP
 * scheme is rejected on purpose rather than by luck at the network layer,
 * and a query string or fragment would be swallowed by the appended path.
 */
export function assertBaseUrl(baseUrl: string) {
  const bad = 'Enter an http or https address, like https://host/v1.';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(bad);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(bad);
  if (url.search || url.hash)
    throw new Error('Enter an http or https address with no query string.');
}

/** A connection test that failed, carrying why so the UI can act on it. */
export class ConnectionTestError extends Error {
  constructor(
    message: string,
    readonly kind: TestFailure,
  ) {
    super(message);
    this.name = 'ConnectionTestError';
  }
}

export interface DiscoveryResult {
  /**
   * What to offer in the picker: the chat-capable models the endpoint
   * serves, plus anything the owner had already enabled.
   */
  models: string[];
  /** Everything the endpoint listed, unfiltered, for "show everything". */
  all: string[];
  /** Enabled models the endpoint no longer offers. */
  missing: string[];
}

const parseTest = (value: string | null): ConnectionTest | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as ConnectionTest;
  } catch {
    return null;
  }
};

const parseList = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

/**
 * Endpoints the owner has connected, and which of their models are
 * enabled. Keys are stored beside the MCP connection tokens and are never
 * returned to the client, only whether one is present.
 *
 * Requests are built from the provider preset rather than assumed, so a
 * provider needing attribution headers or an API version gets them; see
 * `requestHeaders` in shared/providers.
 */
export class ModelStore {
  constructor(
    private db: DatabaseSync,
    /** Injected in tests so the pure logic can be exercised offline. */
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS model_connections(id TEXT PRIMARY KEY, providerId TEXT NOT NULL, label TEXT NOT NULL, baseUrl TEXT NOT NULL, apiKey TEXT, models TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL)`,
    );
    // Added after the table shipped, so existing workspaces get them here.
    const columns = db
      .prepare('PRAGMA table_info(model_connections)')
      .all() as unknown as { name: string }[];
    for (const [column, definition] of [
      ['allModels', 'TEXT'],
      ['missingModels', 'TEXT'],
      ['headerMode', 'TEXT'],
      ['lastTest', 'TEXT'],
      ['tokenField', 'TEXT'],
    ])
      if (!columns.some((field) => field.name === column))
        db.exec(
          `ALTER TABLE model_connections ADD COLUMN ${column} ${definition}`,
        );
  }
  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM model_connections ORDER BY createdAt')
      .all() as unknown as Row[];
  }
  private row(id: string): Row | undefined {
    return this.rows().find((item) => item.id === id);
  }
  private view(row: Row): ModelConnection {
    return {
      id: row.id,
      providerId: row.providerId,
      label: row.label,
      baseUrl: row.baseUrl,
      hasKey: !!row.apiKey,
      models: parseList(row.models),
      allModels: parseList(row.allModels),
      missingModels: parseList(row.missingModels),
      headerMode: row.headerMode === 'minimal' ? 'minimal' : 'default',
      lastTest: parseTest(row.lastTest),
      error: row.error,
      createdAt: row.createdAt,
    };
  }
  list(): ModelConnection[] {
    return this.rows().map((row) => this.view(row));
  }
  get(id: string): ModelConnection | undefined {
    const row = this.row(id);
    return row ? this.view(row) : undefined;
  }
  add(input: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiKey?: string;
  }): ModelConnection {
    const preset = provider(input.providerId);
    if (!preset) throw new Error('Unknown provider.');
    const baseUrl = normalizeBaseUrl(input.baseUrl || preset.baseUrl);
    if (!baseUrl) throw new Error('This provider needs a base URL.');
    assertBaseUrl(baseUrl);
    if (preset.needsKey && !input.apiKey?.trim())
      throw new Error(`${preset.label} needs an API key.`);
    const row: Row = {
      id: randomUUID(),
      providerId: input.providerId,
      label: input.label.trim() || preset.label,
      baseUrl,
      // A preset that takes no credential ignores one that was typed
      // anyway, so a stray key cannot end up on a local endpoint.
      apiKey: preset.auth === 'none' ? null : input.apiKey?.trim() || null,
      models: '[]',
      error: null,
      createdAt: Date.now(),
      // Null, not empty: nothing has asked this endpoint what it serves
      // yet, which is not the same as it serving nothing.
      allModels: null,
      missingModels: '[]',
      headerMode: 'default',
      lastTest: null,
      tokenField: null,
    };
    this.db
      .prepare(
        'INSERT INTO model_connections (id, providerId, label, baseUrl, apiKey, models, error, createdAt, allModels, missingModels, headerMode, lastTest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.providerId,
        row.label,
        row.baseUrl,
        row.apiKey,
        row.models,
        null,
        row.createdAt,
        row.allModels,
        row.missingModels,
        row.headerMode,
        null,
      );
    return this.view(row);
  }
  setModels(id: string, models: string[]) {
    const row = this.row(id);
    if (!row) return undefined;
    const enabled = sortModelNames(models);
    // Only a probe knows what an endpoint offers, and only a probe can
    // disprove a failure — so ticking a model neither clears `error` nor
    // invents a missing list before discovery has ever run.
    const all = row.allModels == null ? null : parseList(row.allModels);
    this.db
      .prepare(
        'UPDATE model_connections SET models=?, missingModels=? WHERE id=?',
      )
      .run(
        JSON.stringify(enabled),
        JSON.stringify(all ? missingAmong(enabled, all) : []),
        id,
      );
    return this.get(id);
  }
  setError(id: string, error: string | null) {
    this.db
      .prepare('UPDATE model_connections SET error=? WHERE id=?')
      .run(error, id);
  }
  remove(id: string) {
    return (
      this.db.prepare('DELETE FROM model_connections WHERE id=?').run(id)
        .changes > 0
    );
  }

  /**
   * Asks an endpoint what it can serve.
   *
   * Providers differ in what they return, so anything that is obviously
   * not a chat model is filtered out of the offer and everything else is
   * offered rather than guessed at. The unfiltered list is kept too: the
   * filter is a heuristic, and the owner should be able to overrule it.
   *
   * Discovery never removes a model the owner enabled. A local server with
   * a model not currently loaded, or a gateway that reshuffles its catalog,
   * would otherwise silently un-pick someone's choice; such models stay in
   * the list and come back flagged as missing instead.
   */
  async discoverDetailed(id: string): Promise<DiscoveryResult> {
    const row = this.row(id);
    if (!row) throw new Error('Connection not found.');
    const enabled = parseList(row.models);
    try {
      const response = await this.fetchImpl(
        endpointUrl(row.baseUrl, 'models'),
        {
          headers: requestHeaders({
            providerId: row.providerId,
            apiKey: row.apiKey,
            mode: this.view(row).headerMode,
          }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'That key was refused.'
            : `The endpoint answered ${response.status}.`,
        );
      const text = await readCapped(response, MODELS_BODY_LIMIT, true);
      let body: { data?: unknown; models?: unknown };
      try {
        body = JSON.parse(text) as { data?: unknown; models?: unknown };
      } catch {
        throw new Error('That endpoint did not return a model list.');
      }
      // OpenAI-shaped responses use `data`; a few local servers use
      // `models`, and a minimal shim may list bare strings rather than
      // objects — which would otherwise read as an empty catalog.
      const entries = Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : [];
      const listed = sortModelNames(
        entries
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : ((entry as { id?: unknown; name?: unknown } | null)?.id ??
                (entry as { name?: unknown } | null)?.name),
          )
          .filter((name): name is string => typeof name === 'string'),
      );
      // A parsed list is evidence even when it is empty: an endpoint that
      // has had every model removed really is offering none of them, and
      // that is exactly when the "Not offered" flags matter most.
      const missing = missingAmong(enabled, listed);
      // One endpoint's catalog must not be able to bloat the row.
      const offered = listed.slice(0, MAX_DISCOVERED);
      const chat = offered.filter(looksLikeChatModel);
      const result: DiscoveryResult = {
        models: sortModelNames([...chat, ...missing]),
        all: offered,
        missing,
      };
      this.db
        .prepare(
          'UPDATE model_connections SET allModels=?, missingModels=?, error=NULL WHERE id=?',
        )
        .run(JSON.stringify(offered), JSON.stringify(missing), id);
      return result;
    } catch (error) {
      const message = reachMessage(error, row.baseUrl, row.apiKey);
      this.setError(id, message);
      throw new Error(message, { cause: error });
    }
  }

  /** The names to offer in the picker. See `discoverDetailed`. */
  async discover(id: string): Promise<string[]> {
    return (await this.discoverDetailed(id)).models;
  }

  /**
   * Sends one real completion and reports what came back.
   *
   * This is the only way to know a connection works: listing models proves
   * the key can read a catalog, not that it can generate, and in this app
   * the chat path runs through Intelligence, so a connection cannot be
   * exercised by chatting either. The failure is classified — unreachable
   * host, refused key, absent model, timeout, nonsense reply — because
   * "it didn't work" is not something anyone can act on.
   *
   * The outcome is recorded on the connection so the UI can show it
   * without probing again.
   */
  async test(id: string, model?: string): Promise<ConnectionTest> {
    const row = this.row(id);
    if (!row) throw new Error('Connection not found.');
    const enabled = parseList(row.models);
    const target = model?.trim() || enabled[0];
    if (!target)
      throw new ConnectionTestError(
        'Enable a model on this connection first, then test it.',
        'missing-model',
      );
    const startedAt = Date.now();
    const current = this.view(row).headerMode;
    const learned = tokenFieldOf(row);
    /*
     * Anthropic's compatibility endpoint rejects some requests for want of
     * an API version and others for sending one; newer OpenAI models
     * refuse `max_tokens` outright. Both answer 400, so a single retry that
     * changed the headers and the token field together could not say which
     * one fixed it — and the header mode is persisted and every later real
     * request is built from it. So each rung varies one knob, and only a
     * rung that varied the mode alone is allowed to teach it. The mode
     * rung goes both ways, so a connection that once dropped its headers
     * can learn that it needs them again.
     */
    const ladder: {
      mode: HeaderMode;
      tokenField: TokenField;
      provesMode: boolean;
    }[] = [{ mode: current, tokenField: learned, provesMode: false }];
    if (hasNegotiableHeaders(row.providerId))
      ladder.push({
        mode: current === 'default' ? 'minimal' : 'default',
        tokenField: learned,
        provesMode: true,
      });
    ladder.push({
      mode: ladder[ladder.length - 1].mode,
      tokenField:
        learned === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens',
      provesMode: false,
    });
    let step = 0;
    let attempt = await this.complete(
      row,
      target,
      ladder[0].mode,
      ladder[0].tokenField,
    );
    while (!attempt.ok && attempt.retryable && step + 1 < ladder.length) {
      step += 1;
      attempt = await this.complete(
        row,
        target,
        ladder[step].mode,
        ladder[step].tokenField,
      );
    }
    const latencyMs = Date.now() - startedAt;
    if (!attempt.ok) {
      const result: ConnectionTest = {
        ok: false,
        model: target,
        latencyMs,
        error: attempt.message,
        kind: attempt.kind,
        at: Date.now(),
      };
      this.recordTest(id, result, null, null);
      throw new ConnectionTestError(attempt.message, attempt.kind);
    }
    const result: ConnectionTest = {
      ok: true,
      model: target,
      reply: attempt.reply,
      latencyMs,
      usage: attempt.usage,
      at: Date.now(),
    };
    this.recordTest(
      id,
      result,
      ladder[step].provesMode ? attempt.mode : null,
      ladder[step].tokenField,
    );
    return result;
  }

  private recordTest(
    id: string,
    result: ConnectionTest,
    mode: HeaderMode | null,
    tokenField: TokenField | null,
  ) {
    /*
     * `error` is the connection's own banner: the composer turns it into an
     * "Offline" badge on every model of that connection. So only a verdict
     * about the endpoint belongs there. A model that is gone, a reply that
     * made no sense, or one model's 500 is about the model that was asked,
     * and stays visible through `lastTest` instead of branding its
     * known-good siblings. `undefined` means "leave whatever is there".
     */
    const connectionError = result.ok
      ? null
      : result.kind === 'unreachable' ||
          result.kind === 'refused' ||
          result.kind === 'timeout'
        ? (result.error ?? null)
        : undefined;
    this.db
      .prepare(
        'UPDATE model_connections SET lastTest=?, error=CASE WHEN ?=1 THEN ? ELSE error END, headerMode=COALESCE(?, headerMode), tokenField=COALESCE(?, tokenField) WHERE id=?',
      )
      .run(
        JSON.stringify(result),
        connectionError === undefined ? 0 : 1,
        connectionError ?? null,
        mode,
        tokenField,
        id,
      );
  }

  /** One attempt at a minimal completion. Never throws. */
  private async complete(
    row: Row,
    model: string,
    mode: HeaderMode,
    tokenField: 'max_tokens' | 'max_completion_tokens',
  ): Promise<
    | {
        ok: true;
        mode: HeaderMode;
        reply: string;
        usage?: ConnectionTest['usage'];
      }
    | { ok: false; kind: TestFailure; message: string; retryable: boolean }
  > {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: TEST_PROMPT }],
      [tokenField]: 32,
      stream: false,
    };
    // Dropped on the retry: the models that reject `max_tokens` reject a
    // non-default temperature too.
    if (tokenField === 'max_tokens') body.temperature = 0;
    try {
      const response = await this.fetchImpl(
        endpointUrl(row.baseUrl, 'chat/completions'),
        {
          method: 'POST',
          headers: requestHeaders({
            providerId: row.providerId,
            apiKey: row.apiKey,
            json: true,
            mode,
          }),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        const detail = scrub(await errorDetail(response), row.apiKey);
        const kind = classify(response.status, detail, model);
        return {
          ok: false,
          kind,
          message: failureMessage(kind, {
            status: response.status,
            detail,
            model,
            baseUrl: row.baseUrl,
            label: row.label,
          }),
          // Only the shapes a different request could fix are worth a
          // retry; which request to try next is the ladder's business.
          retryable: response.status === 400 || response.status === 422,
        };
      }
      const payload = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      } | null;
      const reply = replyText(payload?.choices?.[0]?.message?.content);
      if (!reply)
        return {
          ok: false,
          kind: 'malformed',
          message: `${row.label} answered, but without a message. The endpoint may not be an OpenAI-compatible /chat/completions path.`,
          retryable: false,
        };
      return {
        ok: true,
        mode,
        reply,
        usage: payload?.usage
          ? {
              promptTokens: payload.usage.prompt_tokens,
              completionTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const raw = scrub(
        error instanceof Error ? error.message : '',
        row.apiKey,
      );
      const timedOut =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (timedOut)
        return {
          ok: false,
          kind: 'timeout',
          message: `${model} did not answer within ${TEST_TIMEOUT_MS / 1000}s. A local model loading for the first time can be slower than that — try again once it is warm.`,
          retryable: false,
        };
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network/i.test(raw))
        return {
          ok: false,
          kind: 'unreachable',
          message: `Could not reach ${row.baseUrl}. Check the address, and that the server is running.`,
          retryable: false,
        };
      return {
        ok: false,
        kind: 'error',
        message: raw || 'The request failed.',
        retryable: false,
      };
    }
  }

  /** Every enabled model across every connection, for the picker. */
  specs(): ModelSpec[] {
    return this.rows().flatMap((row) => {
      const connection = this.view(row);
      return connection.models.map((model) => {
        const caps = modelDefaults(model);
        return {
          id: `${row.id}:${model}`,
          model,
          label: model,
          provider: connection.label,
          contextWindow: caps.contextWindow,
          maxOutput: caps.maxOutput,
          vision: caps.vision,
          tools: caps.tools,
          baseUrl: row.baseUrl,
          known: caps.known,
          missing: connection.missingModels.includes(model),
        } satisfies ModelSpec;
      });
    });
  }

  /** Resolves a picker id back to what the agent needs to call it. */
  resolve(specId: string):
    | {
        model: string;
        baseUrl: string;
        apiKey?: string;
        providerId: string;
        headers: Record<string, string>;
        /** The output-cap field this endpoint has been shown to accept. */
        tokenField: TokenField;
        /** Largest reply worth asking this model for. */
        maxOutput: number;
        /** False when this model cannot call tools, so none are offered. */
        tools: boolean;
        /** False when it cannot read images. */
        vision: boolean;
      }
    | undefined {
    const [connectionId, ...rest] = specId.split(':');
    const model = rest.join(':');
    const row = this.row(connectionId);
    if (!row || !parseList(row.models).includes(model)) return undefined;
    const caps = modelDefaults(model);
    return {
      model,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey ?? undefined,
      providerId: row.providerId,
      // What the test learned, so a real turn sends the request shape that
      // was proved rather than a different one.
      tokenField: tokenFieldOf(row),
      maxOutput: caps.maxOutput,
      tools: caps.tools,
      vision: caps.vision,
      // Built here so a caller only has to pass these along: the provider's
      // attribution and version headers travel with every real request,
      // not just the probes.
      headers: requestHeaders({
        providerId: row.providerId,
        apiKey: row.apiKey,
        json: true,
        mode: this.view(row).headerMode,
      }),
    };
  }
}

/**
 * Enabled models an endpoint no longer offers. Callers pass a list they
 * actually observed: "nothing was listed" is a real answer, and the
 * caller that has never asked passes nothing at all instead.
 */
function missingAmong(enabled: string[], offered: string[]): string[] {
  return enabled.filter((model) => !offered.includes(model));
}

/** The output-cap field this connection last succeeded with. */
function tokenFieldOf(row: Pick<Row, 'tokenField'>): TokenField {
  return row.tokenField === 'max_completion_tokens'
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/** A reply may arrive as a string or as content parts. */
function replyText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('')
      .trim();
  return '';
}

/** The message inside an error response, whatever shape it arrived in. */
async function errorDetail(response: Response): Promise<string> {
  const text = await readCapped(response, ERROR_BODY_LIMIT, false).catch(
    () => '',
  );
  if (!text) return '';
  try {
    const body = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      detail?: unknown;
    };
    const candidate =
      typeof body.error === 'string'
        ? body.error
        : typeof body.error?.message === 'string'
          ? body.error.message
          : typeof body.message === 'string'
            ? body.message
            : typeof body.detail === 'string'
              ? body.detail
              : '';
    return candidate.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * What a failing status means. A provider that cannot find the model says
 * so in several ways — 404 on the path, or a 400 naming the model — so the
 * body is read as well as the status.
 */
export function classify(
  status: number,
  detail: string,
  model: string,
): TestFailure {
  if (status === 401 || status === 403) return 'refused';
  const absent =
    /not found|does not exist|no such model|unknown model|is not a valid model|not available/i;
  const namesModel = /model/i.test(detail) || detail.includes(model);
  // A 404 is as often a wrong path as a wrong model: an OpenAI-compatible
  // base URL saved without its /v1 answers 404 too — Ollama with the bare
  // body `404 page not found` — and sending that owner off to re-run
  // discovery cannot help them. So the body has to support the verdict.
  if (status === 404)
    return absent.test(detail) && namesModel ? 'missing-model' : 'error';
  if ((status === 400 || status === 422) && absent.test(detail) && namesModel)
    return 'missing-model';
  return 'error';
}

function failureMessage(
  kind: TestFailure,
  context: {
    status: number;
    detail: string;
    model: string;
    baseUrl: string;
    label: string;
  },
): string {
  const tail = context.detail ? ` ${context.detail}` : '';
  if (kind === 'refused')
    return `${context.label} refused that key (${context.status}).${tail}`;
  if (kind === 'missing-model')
    return `${context.label} has no model called ${context.model}. Re-run discovery and pick one it lists.${tail}`;
  if (context.status === 404)
    return `${context.label} answered 404 at ${context.baseUrl}/chat/completions. Check the address — most OpenAI-compatible servers need the /v1 suffix.${tail}`;
  return `${context.label} answered ${context.status}.${tail}`;
}

/**
 * `fetch failed` is what Node reports for a refused connection or an
 * unresolvable host, which tells the owner nothing useful.
 */
function reachMessage(
  error: unknown,
  baseUrl: string,
  apiKey?: string | null,
): string {
  const raw = scrub(error instanceof Error ? error.message : '', apiKey);
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
    return 'The endpoint did not respond in time. Is it running?';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network/i.test(raw))
    return `Could not reach ${baseUrl}. Check the address, and that the server is running.`;
  return raw || 'Could not reach the endpoint.';
}
