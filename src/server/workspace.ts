import { ComputerStore } from './computer-store.js';
import { ConnectionStore } from './connection-store.js';
import { AvatarStore } from './avatar-store.js';
import { FlowStore } from './flow-store.js';
import { ModelStore, type TokenField } from './model-store.js';
import { FlowRunStore } from './flow-run-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLearningSettings } from '../shared/learning.js';
import { modelDefaults } from '../shared/models.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  readonly avatars: AvatarStore;
  readonly flows: FlowStore;
  readonly models: ModelStore;
  readonly runs: FlowRunStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'avatar', 'TEXT'],
      // A ModelStore spec id: the Dot's default, and a per-conversation
      // override of it. Nullable so existing rows keep following the
      // environment configuration until someone picks something.
      ['dots', 'model', 'TEXT'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      ['thread_bindings', 'model', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(this.db);
    this.avatars = new AvatarStore(this.db);
    this.flows = new FlowStore(this.db);
    this.models = new ModelStore(this.db);
    this.runs = new FlowRunStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    avatar: string | null = null,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      avatar,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          avatar,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
      avatar?: string | null;
      model?: string | null;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const avatar =
      patch.avatar === undefined ? (current.avatar ?? null) : patch.avatar;
    const model =
      patch.model === undefined ? (current.model ?? null) : patch.model;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, avatar=?, model=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          avatar,
          model,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  /**
   * Points one conversation at a model, or clears the override with null so
   * the conversation follows its Dot again. The value is a ModelStore spec
   * id; whether it still resolves is checked at answer time, not here, so a
   * connection removed later degrades instead of breaking the thread.
   */
  setConversationModel(id: string, model: string | null): Conversation {
    this.requireThread(id);
    this.db
      .prepare('UPDATE thread_bindings SET model=? WHERE id=? AND ownerId=?')
      .run(model, id, this.ownerId);
    return this.requireThread(id);
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}

/** Which rung of the precedence ladder supplied the model. */
export type ModelSource =
  /** This conversation's own override. */
  | 'conversation'
  /** The Dot's default. */
  | 'dot'
  /** The first enabled model across the owner's connections. */
  | 'enabled'
  /** The legacy OPENAI_MODEL / OPENAI_API_KEY environment configuration. */
  | 'environment';

/** Everything needed to call a model, plus why this one was chosen. */
export interface ResolvedModel {
  /** The name the provider expects in the request body. */
  model: string;
  baseUrl: string;
  /** Absent for local servers, which need no credential. */
  apiKey?: string;
  /**
   * Provider attribution headers the connection wants on every request.
   * The legacy environment rung declares none.
   */
  headers?: Record<string, string>;
  source: ModelSource;
  /** The spec id that won; the environment rung has none. */
  specId?: string;
  /**
   * The output-cap field this endpoint accepted when it was tested, so a
   * real turn sends the request shape that was proved rather than a
   * different one. The legacy environment rung keeps what it always sent.
   */
  tokenField: TokenField;
  /** Largest reply worth asking this model for. */
  maxOutput: number;
  /**
   * Whether this model can call tools at all. A model that cannot must not
   * be handed tool definitions: it either ignores them or rejects the
   * request, and either way a flow silently never calls anything.
   */
  tools: boolean;
  /** Whether it can read images. */
  vision: boolean;
}

/**
 * The one place that decides which model answers.
 *
 * Precedence, highest first:
 *   1. the conversation's own override,
 *   2. the Dot's default,
 *   3. the first enabled model across the owner's connections,
 *   4. the legacy OPENAI_MODEL / OPENAI_API_KEY environment configuration.
 *
 * A spec id that no longer resolves — its connection was deleted, or the
 * model was unticked — falls through to the next rung rather than failing,
 * so deleting a connection degrades a Dot instead of breaking it. Returns
 * undefined only when no rung can supply a model; callers treat that as
 * "setup required" rather than calling a nonexistent endpoint.
 *
 * `source` is reported so the UI and the logs can say which rung won.
 */
export function resolveModel(
  workspace: WorkspaceStore,
  config: { model?: string; apiKey?: string; baseUrl?: string },
  dotId: string,
  threadId?: string,
): ResolvedModel | undefined {
  const fromSpec = (
    specId: string | null | undefined,
    source: ModelSource,
  ): ResolvedModel | undefined => {
    if (!specId) return undefined;
    const hit = workspace.models.resolve(specId);
    return hit ? { ...hit, source, specId } : undefined;
  };
  const conversation = threadId
    ? workspace.conversations().find((thread) => thread.id === threadId)
    : undefined;
  const override = fromSpec(conversation?.model, 'conversation');
  if (override) return override;
  const preferred = fromSpec(workspace.dot(dotId)?.model, 'dot');
  if (preferred) return preferred;
  /*
   * This rung is what most Dots use, so it prefers a model that can
   * actually answer: one its endpoint still offers, on a connection whose
   * last probe did not fail. Taking position 0 regardless would route
   * every Dot without an explicit default to an older broken connection
   * that happens to predate the working one. Position 0 stays the last
   * resort, because an unproved connection is better than none.
   */
  const specs = workspace.models.specs();
  const connections = workspace.models.list();
  const healthy = specs.find(
    (spec) =>
      !spec.missing &&
      !connections.find((item) => item.id === spec.id.split(':')[0])?.error,
  );
  const first = fromSpec(healthy?.id ?? specs[0]?.id, 'enabled');
  if (first) return first;
  // The legacy rung needs both halves, which is what setup status has
  // always required of it.
  if (config.model && config.apiKey) {
    const caps = modelDefaults(config.model);
    return {
      model: config.model,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      apiKey: config.apiKey,
      source: 'environment',
      // This rung has no test to learn from, so it keeps the field it has
      // always sent rather than changing behaviour for existing setups.
      tokenField: 'max_completion_tokens',
      maxOutput: caps.maxOutput,
      tools: caps.tools,
      vision: caps.vision,
    };
  }
  return undefined;
}
