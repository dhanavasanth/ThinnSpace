import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { Dot } from '../src/shared/types.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  return {
    ws,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    }),
  };
}
const patch = (dot: Dot, avatar: string) => ({
  name: dot.name,
  instructions: dot.instructions,
  researchAllowed: dot.researchAllowed,
  memoryAllowed: dot.memoryAllowed,
  spaceId: dot.spaceId,
  spaceIds: dot.spaceIds,
  avatar,
});
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
// 1x1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

it('uploads an avatar, serves it publicly, and assigns it to a Dot', async () => {
  const { app, ws } = fixture();
  const created = await app.request(
    'http://localhost/api/avatars',
    json({ label: 'Me', image: PNG }),
  );
  expect(created.status).toBe(201);
  const avatar = (await created.json()) as { id: string; label: string };
  expect(avatar.label).toBe('Me');
  const workspace = (await (
    await app.request('http://localhost/api/workspace')
  ).json()) as { avatars: { id: string }[] };
  expect(workspace.avatars.map((item) => item.id)).toEqual([avatar.id]);
  const image = await app.request(`http://localhost/avatars/${avatar.id}.png`);
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(8);
  const dot = ws.dots()[0];
  const updated = await app.request(
    `http://localhost/api/dots/${dot.id}`,
    json(patch(dot, avatar.id), 'PUT'),
  );
  expect(updated.status).toBe(200);
  expect(ws.dot(dot.id)?.avatar).toBe(avatar.id);
  // Removing the image clears it from the Dot that used it.
  const removed = await app.request(
    `http://localhost/api/avatars/${avatar.id}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  expect(removed.status).toBe(200);
  expect(ws.dot(dot.id)?.avatar).toBeNull();
  expect(
    (await app.request(`http://localhost/avatars/${avatar.id}.png`)).status,
  ).toBe(404);
});

it('rejects unknown avatars and non-PNG uploads', async () => {
  const { app, ws } = fixture();
  const dot = ws.dots()[0];
  const bad = await app.request(
    `http://localhost/api/dots/${dot.id}`,
    json(patch(dot, 'not-real'), 'PUT'),
  );
  expect(bad.status).toBe(400);
  const notPng = await app.request(
    'http://localhost/api/avatars',
    json({ label: 'x', image: 'data:image/png;base64,aGVsbG8=' }),
  );
  expect(notPng.status).toBe(400);
  expect(
    (
      await app.request(
        'http://localhost/api/dots/' + dot.id,
        json(patch(dot, 'blue'), 'PUT'),
      )
    ).status,
  ).toBe(200);
});
