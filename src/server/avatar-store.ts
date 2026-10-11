import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AvatarRecord } from '../shared/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Uploads are resized to 512px client-side; this bounds a hostile client. */
export const MAX_AVATAR_BYTES = 700_000;

/** Owner-uploaded avatar images, stored as PNG bytes beside the workspace. */
export class AvatarStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS avatars(id TEXT PRIMARY KEY, label TEXT NOT NULL, png BLOB NOT NULL, createdAt INTEGER NOT NULL)',
    );
  }
  list(): AvatarRecord[] {
    return this.db
      .prepare('SELECT id, label, createdAt FROM avatars ORDER BY createdAt')
      .all() as unknown as AvatarRecord[];
  }
  has(id: string) {
    return !!this.db.prepare('SELECT 1 FROM avatars WHERE id=?').get(id);
  }
  image(id: string): Buffer | undefined {
    const row = this.db
      .prepare('SELECT png FROM avatars WHERE id=?')
      .get(id) as { png: Uint8Array } | undefined;
    return row ? Buffer.from(row.png) : undefined;
  }
  create(label: string, png: Buffer): AvatarRecord {
    if (png.length > MAX_AVATAR_BYTES)
      throw new Error('Avatar image is too large.');
    if (!png.subarray(0, 8).equals(PNG_MAGIC))
      throw new Error('Avatar must be a PNG image.');
    const record: AvatarRecord = {
      id: randomUUID(),
      label,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO avatars VALUES (?, ?, ?, ?)')
      .run(record.id, label, png, record.createdAt);
    return record;
  }
  /** Removes the image and clears it from any Dot that used it. */
  remove(id: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE dots SET avatar=NULL WHERE avatar=?').run(id);
      const changes = this.db
        .prepare('DELETE FROM avatars WHERE id=?')
        .run(id).changes;
      this.db.exec('COMMIT');
      return changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
