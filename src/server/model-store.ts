import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  looksLikeChatModel,
  normalizeBaseUrl,
  provider,
  type ModelConnection,
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
};

/** How long a probe waits before giving up on an endpoint. */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Endpoints the owner has connected, and which of their models are
 * enabled. Keys are stored beside the MCP connection tokens and are never
 * returned to the client, only whether one is present.
 */
export class ModelStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS model_connections(id TEXT PRIMARY KEY, providerId TEXT NOT NULL, label TEXT NOT NULL, baseUrl TEXT NOT NULL, apiKey TEXT, models TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL)`,
    );
  }
  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM model_connections ORDER BY createdAt')
      .all() as unknown as Row[];
  }
  private view(row: Row): ModelConnection {
    return {
      id: row.id,
      providerId: row.providerId,
      label: row.label,
      baseUrl: row.baseUrl,
      hasKey: !!row.apiKey,
      models: JSON.parse(row.models) as string[],
      error: row.error,
      createdAt: row.createdAt,
    };
  }
  list(): ModelConnection[] {
    return this.rows().map((row) => this.view(row));
  }
  get(id: string): ModelConnection | undefined {
    const row = this.rows().find((item) => item.id === id);
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
    if (preset.needsKey && !input.apiKey?.trim())
      throw new Error(`${preset.label} needs an API key.`);
    const row: Row = {
      id: randomUUID(),
      providerId: input.providerId,
      label: input.label.trim() || preset.label,
      baseUrl,
      apiKey: input.apiKey?.trim() || null,
      models: '[]',
      error: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO model_connections VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        row.id,
        row.providerId,
        row.label,
        row.baseUrl,
        row.apiKey,
        row.models,
        null,
        row.createdAt,
      );
    return this.view(row);
  }
  setModels(id: string, models: string[]) {
    this.db
      .prepare('UPDATE model_connections SET models=?, error=NULL WHERE id=?')
      .run(JSON.stringify([...new Set(models)]), id);
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
   * Asks an endpoint what it can serve. Providers differ in what they
   * return, so anything that is obviously not a chat model is filtered and
   * everything else is offered rather than guessed at.
   */
  async discover(id: string): Promise<string[]> {
    const row = this.rows().find((item) => item.id === id);
    if (!row) throw new Error('Connection not found.');
    try {
      const response = await fetch(`${row.baseUrl}/models`, {
        headers: row.apiKey ? { Authorization: `Bearer ${row.apiKey}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'That key was refused.'
            : `The endpoint answered ${response.status}.`,
        );
      const body = (await response.json()) as {
        data?: { id?: unknown }[];
        models?: { name?: unknown; id?: unknown }[];
      };
      // OpenAI-shaped responses use `data`; a few local servers use `models`.
      const names = (body.data ?? body.models ?? [])
        .map((entry) => entry.id ?? (entry as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')
        .filter(looksLikeChatModel)
        .sort();
      this.setError(id, null);
      return [...new Set(names)];
    } catch (error) {
      // `fetch failed` is what Node reports for a refused connection or an
      // unresolvable host, which tells the owner nothing useful.
      const raw = error instanceof Error ? error.message : '';
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The endpoint did not respond in time. Is it running?'
          : /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(raw)
            ? `Could not reach ${row.baseUrl}. Check the address, and that the server is running.`
            : raw || 'Could not reach the endpoint.';
      this.setError(id, message);
      throw new Error(message);
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
        } satisfies ModelSpec;
      });
    });
  }

  /** Resolves a picker id back to what the agent needs to call it. */
  resolve(
    specId: string,
  ): { model: string; baseUrl: string; apiKey?: string } | undefined {
    const [connectionId, ...rest] = specId.split(':');
    const model = rest.join(':');
    const row = this.rows().find((item) => item.id === connectionId);
    if (!row || !(JSON.parse(row.models) as string[]).includes(model))
      return undefined;
    return {
      model,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey ?? undefined,
    };
  }
}
