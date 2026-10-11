import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  FLOW_LIMITS,
  flowStatus,
  summarizeGraph,
  type Flow,
  type FlowGraph,
  type FlowSummary,
  type FlowVersion,
} from '../shared/flows.js';

/** Autosave snapshots are kept at most this often; named versions always. */
const AUTOSAVE_VERSION_INTERVAL = 5 * 60 * 1000;
const MAX_AUTOSAVE_VERSIONS = 50;

type Row = Omit<Flow, 'graph'> & { graph: string };

/** Flows and their version history, stored beside the workspace tables. */
export class FlowStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, graph TEXT NOT NULL, revision INTEGER NOT NULL, publishedVersionId TEXT, publishedRevision INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flow_versions(id TEXT PRIMARY KEY, flowId TEXT NOT NULL, graph TEXT NOT NULL, label TEXT, source TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS flow_versions_flow ON flow_versions(flowId, createdAt);`);
    // Columns added after the first release; existing databases gain them in place.
    for (const [column, definition] of [
      ['publishedVersionId', 'TEXT'],
      ['publishedRevision', 'INTEGER'],
    ]) {
      if (
        !db
          .prepare('PRAGMA table_info(flows)')
          .all()
          .some((field) => field.name === column)
      )
        db.exec(`ALTER TABLE flows ADD COLUMN ${column} ${definition}`);
    }
  }
  /**
   * The columns a `Flow` is made of, named explicitly: the table also holds
   * the webhook token (added by FlowRunStore), and `SELECT *` plus a spread
   * would ride that secret along in every flow response.
   */
  private static COLUMNS =
    'id, name, description, graph, revision, publishedVersionId, publishedRevision, createdAt, updatedAt';
  private hydrate(row: Row): Flow {
    return { ...row, graph: JSON.parse(row.graph) as FlowGraph };
  }
  list(): FlowSummary[] {
    return (
      this.db
        .prepare(
          `SELECT ${FlowStore.COLUMNS} FROM flows ORDER BY updatedAt DESC`,
        )
        .all() as unknown as Row[]
    ).map((row) => {
      const graph = JSON.parse(row.graph) as FlowGraph;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        revision: row.revision,
        status: flowStatus(row),
        updatedAt: row.updatedAt,
        ...summarizeGraph(graph),
      };
    });
  }
  get(id: string): Flow | undefined {
    const row = this.db
      .prepare(`SELECT ${FlowStore.COLUMNS} FROM flows WHERE id=?`)
      .get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }
  create(name: string, description: string, graph: FlowGraph): Flow {
    const now = Date.now();
    const flow: Flow = {
      id: randomUUID(),
      name: name.slice(0, FLOW_LIMITS.name),
      description: description.slice(0, FLOW_LIMITS.description),
      graph,
      revision: 1,
      publishedVersionId: null,
      publishedRevision: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO flows (id, name, description, graph, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        flow.id,
        flow.name,
        flow.description,
        JSON.stringify(graph),
        1,
        now,
        now,
      );
    return flow;
  }
  /**
   * Saves a change. `revision` must match the stored revision so two editors
   * cannot silently overwrite each other; a mismatch throws 'stale'.
   */
  update(
    id: string,
    patch: { name?: string; description?: string; graph?: FlowGraph },
    revision: number,
  ): Flow {
    const current = this.get(id);
    if (!current) throw new Error('Flow not found.');
    if (current.revision !== revision) throw new Error('stale');
    const now = Date.now();
    const next: Flow = {
      ...current,
      name: (patch.name ?? current.name).slice(0, FLOW_LIMITS.name),
      description: (patch.description ?? current.description).slice(
        0,
        FLOW_LIMITS.description,
      ),
      graph: patch.graph ?? current.graph,
      revision: current.revision + 1,
      updatedAt: now,
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE flows SET name=?, description=?, graph=?, revision=?, updatedAt=? WHERE id=?',
        )
        .run(
          next.name,
          next.description,
          JSON.stringify(next.graph),
          next.revision,
          now,
          id,
        );
      if (patch.graph) this.snapshot(id, current.graph, 'autosave', null, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }
  remove(id: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM flow_versions WHERE flowId=?').run(id);
      const changes = this.db
        .prepare('DELETE FROM flows WHERE id=?')
        .run(id).changes;
      this.db.exec('COMMIT');
      return changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  duplicate(id: string): Flow | undefined {
    const current = this.get(id);
    return current
      ? this.create(`${current.name} copy`, current.description, current.graph)
      : undefined;
  }
  versions(flowId: string): FlowVersion[] {
    return this.db
      .prepare(
        'SELECT id, flowId, label, source, createdAt FROM flow_versions WHERE flowId=? ORDER BY createdAt DESC',
      )
      .all(flowId) as unknown as FlowVersion[];
  }
  version(
    flowId: string,
    id: string,
  ): (FlowVersion & { graph: FlowGraph }) | undefined {
    const row = this.db
      .prepare('SELECT * FROM flow_versions WHERE flowId=? AND id=?')
      .get(flowId, id) as (FlowVersion & { graph: string }) | undefined;
    return row
      ? { ...row, graph: JSON.parse(row.graph) as FlowGraph }
      : undefined;
  }
  /** Records the previous graph before an edit; throttled for autosaves. */
  private snapshot(
    flowId: string,
    graph: FlowGraph,
    source: FlowVersion['source'],
    label: string | null,
    now: number,
  ): FlowVersion | undefined {
    if (source === 'autosave') {
      const latest = this.db
        .prepare(
          "SELECT createdAt FROM flow_versions WHERE flowId=? AND source='autosave' ORDER BY createdAt DESC LIMIT 1",
        )
        .get(flowId) as { createdAt: number } | undefined;
      if (latest && now - latest.createdAt < AUTOSAVE_VERSION_INTERVAL)
        return undefined;
    }
    const version: FlowVersion = {
      id: randomUUID(),
      flowId,
      label,
      source,
      createdAt: now,
    };
    this.db
      .prepare(
        'INSERT INTO flow_versions (id, flowId, graph, label, source, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(version.id, flowId, JSON.stringify(graph), label, source, now);
    if (source === 'autosave')
      this.db
        .prepare(
          `DELETE FROM flow_versions WHERE flowId=? AND source='autosave' AND id NOT IN (
             SELECT id FROM flow_versions WHERE flowId=? AND source='autosave' ORDER BY createdAt DESC LIMIT ?)`,
        )
        .run(flowId, flowId, MAX_AUTOSAVE_VERSIONS);
    return version;
  }
  /** Names the current graph as a version the owner can return to. */
  saveVersion(flowId: string, label: string): FlowVersion {
    const current = this.get(flowId);
    if (!current) throw new Error('Flow not found.');
    return this.snapshot(flowId, current.graph, 'named', label, Date.now())!;
  }
  /**
   * Publishes the current graph: a named version becomes the one triggers
   * run. Editing afterwards leaves the published version untouched.
   */
  publish(flowId: string, label: string, revision: number): Flow {
    const current = this.get(flowId);
    if (!current) throw new Error('Flow not found.');
    if (current.revision !== revision) throw new Error('stale');
    const version = this.snapshot(
      flowId,
      current.graph,
      'named',
      label,
      Date.now(),
    )!;
    this.db
      .prepare(
        'UPDATE flows SET publishedVersionId=?, publishedRevision=? WHERE id=?',
      )
      .run(version.id, revision, flowId);
    return this.get(flowId)!;
  }
  /** Returns the flow to draft; registered triggers stop. */
  unpublish(flowId: string): Flow {
    if (!this.get(flowId)) throw new Error('Flow not found.');
    this.db
      .prepare(
        'UPDATE flows SET publishedVersionId=NULL, publishedRevision=NULL WHERE id=?',
      )
      .run(flowId);
    return this.get(flowId)!;
  }
  /** Restores a version as a new revision; the replaced graph is kept. */
  restore(flowId: string, versionId: string, revision: number): Flow {
    const version = this.version(flowId, versionId);
    if (!version) throw new Error('Version not found.');
    const current = this.get(flowId)!;
    if (current.revision !== revision) throw new Error('stale');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.snapshot(flowId, current.graph, 'restore', null, now);
      this.db
        .prepare('UPDATE flows SET graph=?, revision=?, updatedAt=? WHERE id=?')
        .run(JSON.stringify(version.graph), revision + 1, now, flowId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(flowId)!;
  }
}
