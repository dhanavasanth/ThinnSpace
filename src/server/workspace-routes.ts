import { setupInputSchema } from './setup-telemetry.js';
import { isBuiltinAvatar } from '../shared/avatars.js';
import { MAX_AVATAR_BYTES } from './avatar-store.js';
import { flowRoutes } from './flow-routes.js';
import { flowRunRoutes } from './flow-run-routes.js';
import { pageRoutes } from './page-routes.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import {
  learningContainerIdSchema,
  validateLearningSettings,
} from '../shared/learning.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    learningContainerId: learningContainerIdSchema.optional(),
    skillDeliveryEnabled: z.boolean().optional(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
    avatar: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.route('/', flowRunRoutes(platform));
  app.route('/', flowRoutes(platform));
  app.post('/setup-telemetry', async (c) => {
    const parsed = setupInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: 'Invalid setup event.' }, 400);
    const event = parsed.data;
    if (
      event.kind === 'step_viewed' &&
      event.step !== 'settings' &&
      event.step !==
        (platform.setup().missing.length ? 'setup_required' : 'ready')
    )
      return c.json({ error: 'Setup step does not match server state.' }, 400);
    platform.setupTelemetry.capture(event);
    return c.json({ ok: true });
  });
  app.get('/workspace', (c) =>
    c.json({
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      avatars: platform.workspace.avatars.list(),
      flows: platform.workspace.flows.list(),
      conversations: platform.workspace.conversations(),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  const validAvatar = (id: string | null | undefined) =>
    id == null || isBuiltinAvatar(id) || platform.workspace.avatars.has(id);
  app.get('/avatars', (c) => c.json(platform.workspace.avatars.list()));
  app.post('/avatars', async (c) => {
    const data = z
      .object({
        label: z.string().trim().min(1).max(40),
        image: z
          .string()
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
          .max(Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 64),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Provide a label and a PNG image up to 700 KB.' },
        400,
      );
    try {
      const png = Buffer.from(data.data.image.split(',')[1], 'base64');
      return c.json(
        platform.workspace.avatars.create(data.data.label, png),
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Invalid avatar.' },
        400,
      );
    }
  });
  app.delete('/avatars/:id', (c) =>
    platform.workspace.avatars.remove(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Avatar not found.' }, 404),
  );
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    if (!validAvatar(data.data.avatar))
      return c.json({ error: 'Unknown avatar.' }, 400);
    try {
      validateLearningSettings(
        data.data.learningContainerId ?? null,
        data.data.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
        data.data.learningContainerId,
        data.data.skillDeliveryEnabled,
        data.data.avatar ?? null,
      ),
      201,
    );
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    if (!validAvatar(data.data.avatar))
      return c.json({ error: 'Unknown avatar.' }, 400);
    try {
      validateLearningSettings(
        data.data.learningContainerId === undefined
          ? (current.learningContainerId ?? null)
          : data.data.learningContainerId,
        data.data.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.get('/conversations/:id/capture', (c) =>
    c.json(platform.workspace.capture(c.req.param('id'))),
  );
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', (c) =>
    c.json(voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.all('/copilotkit/*', (c) => platform.handle(c.req.raw));
  app.onError((error, c) => {
    const text = error.message;
    if (text.startsWith('Space access must include'))
      return c.json({ error: text }, 400);
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio|Intelligence could not)/.test(
        text,
      );
    // A conversation, call or Dot the caller named that does not exist is a missing resource, not a
    // server fault.
    if (
      /^(Dot not found|Call not found|Conversation does not belong)/.test(text)
    )
      return c.json({ error: text }, 404);
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
