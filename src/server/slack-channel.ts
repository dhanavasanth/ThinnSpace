import { BRAND } from '../shared/brand.js';
import {
  createChannel,
  type ChannelIdentityContext,
  type IncomingMessage,
  type Thread,
} from '@copilotkit/channels';
import type { PlatformConfig } from './platform-config.js';
import {
  SlackEventFactStore,
  slackChannelOf,
  slackFactsOf,
  slackThreadOf,
  type SlackMentionBridge,
} from './flow-triggers.js';

type SlackConfig = Pick<PlatformConfig, 'slackTeam' | 'slackUsers'>;
type Report = (operation: string, errors: string[]) => void;
// Never pass provider messages/stacks to logs or Slack: they can contain credentials.
export function safeFailure(error: unknown): string {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
      ? error.name
      : 'Error';
  const status =
    error !== null && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? `${name} (HTTP ${status})`
    : name;
}
export const reportChannelFailure: Report = (operation, errors) =>
  console.error(`${operation}: ${errors.join('; ')}`);
/**
 * The owner, when this ingress event is the owner speaking in the configured
 * Slack workspace. Also the one place the channel and thread of an inbound
 * mention are visible: Channels builds a turn's message with an empty
 * `ref`, while the identity context carries the adapter's conversation key.
 * Those facts are stashed in `facts` under the event id, which the message
 * does carry, so the mention handler can read them back.
 */
export function slackIdentity(
  context: ChannelIdentityContext,
  config: SlackConfig,
  ownerId: string,
  facts?: SlackEventFactStore,
) {
  if (
    context.provider !== 'slack' ||
    context.tenant.id !== config.slackTeam ||
    context.actor.kind !== 'human' ||
    !config.slackUsers.includes(context.actor.id)
  )
    return null;
  facts?.remember(context.event.id, slackFactsOf(context.conversation.id));
  return { id: ownerId, name: `${BRAND.name} owner` };
}
type Turn = {
  thread: Pick<Thread, 'runAgent' | 'post' | 'subscribe' | 'isSubscribed'>;
  message: IncomingMessage;
};
export function slackHandlers(options: {
  config: SlackConfig;
  ownerId: string;
  paused: () => boolean;
  report?: Report;
  /** Published flows with a Slack Start get the mention first. */
  bridge?: SlackMentionBridge;
  /** Channel and thread facts stashed by `slackIdentity` for this event. */
  facts?: SlackEventFactStore;
}) {
  const report = options.report ?? reportChannelFailure;
  const eligible = ({ message }: Turn) =>
    message.platform === 'slack' &&
    message.user?.id === options.ownerId &&
    message.actor.kind === 'human' &&
    options.config.slackUsers.includes(message.actor.id) &&
    (message.operation?.kind ?? 'created') === 'created';
  async function notice(thread: Turn['thread'], text: string) {
    try {
      await thread.post(text);
    } catch (error) {
      const safe = safeFailure(error);
      report('Slack notice failed', [safe]);
      throw new Error(`Slack notice failed: ${safe}`, {
        // eslint-disable-next-line preserve-caught-error -- Raw provider causes can expose credentials through SDK logging.
        cause: safeFailure(error),
      });
    }
  }
  async function run(thread: Turn['thread']) {
    if (options.paused()) {
      await notice(
        thread,
        `${BRAND.name} is paused. Resume it in the app before asking me to continue.`,
      );
      return;
    }
    try {
      await thread.runAgent();
    } catch (error) {
      const runError = safeFailure(error);
      try {
        await thread.post(
          `I couldn’t complete that request. Please check ${BRAND.name} and send a new message when you’re ready to try again.`,
        );
      } catch (postError) {
        const replyError = safeFailure(postError);
        report('Slack agent run and error reply failed', [
          runError,
          replyError,
        ]);
        throw new AggregateError(
          [
            new Error(`Agent run: ${runError}`),
            new Error(`Error reply: ${replyError}`),
          ],
          'Slack agent run and error reply failed',
          // eslint-disable-next-line preserve-caught-error -- Retain only the safe cause; the SDK may log thrown errors.
          { cause: safeFailure(postError) },
        );
      }
      report('Slack agent run failed; error reply posted', [runError]);
    }
  }
  /**
   * True when a published flow took this mention. The flow then owns the
   * reply, so the Dot does not answer and the thread is not subscribed. A
   * bridge failure falls back to the Dot: a broken trigger must never
   * swallow a mention.
   */
  async function flowTookMention(turn: Turn) {
    if (!options.bridge) return false;
    // The identity callback ran immediately before this handler and stashed
    // the channel and thread; the message's own `ref` carries neither.
    const facts = options.facts?.take(turn.message.eventId) ?? {};
    try {
      return await options.bridge.slackMention({
        channel: facts.channel ?? slackChannelOf(turn.message),
        text: turn.message.text ?? '',
        user: turn.message.actor.id,
        threadTs: facts.threadTs ?? slackThreadOf(turn.message),
        acknowledge: (text) => notice(turn.thread, text),
        // The same thread, later: a Finish that replies in Slack, or a Send
        // message aimed at the thread that started the flow, posts here.
        reply: (text) => notice(turn.thread, text),
      });
    } catch (error) {
      report('Slack flow trigger failed; answering the mention', [
        safeFailure(error),
      ]);
      return false;
    }
  }
  return {
    async mention(turn: Turn) {
      if (!eligible(turn)) return;
      if (options.paused()) {
        await run(turn.thread);
        return;
      }
      if (await flowTookMention(turn)) return;
      try {
        await turn.thread.subscribe();
      } catch (error) {
        report('Slack thread subscription failed; answering mention', [
          safeFailure(error),
        ]);
      }
      await run(turn.thread);
    },
    async message(turn: Turn) {
      if (!eligible(turn)) return;
      let subscribed: boolean;
      try {
        subscribed = await turn.thread.isSubscribed();
      } catch (error) {
        const safe = safeFailure(error);
        report('Slack subscription lookup failed', [safe]);
        throw new Error(`Slack subscription lookup failed: ${safe}`, {
          // eslint-disable-next-line preserve-caught-error -- Raw provider causes can expose credentials through SDK logging.
          cause: safeFailure(error),
        });
      }
      if (subscribed) await run(turn.thread);
    },
  };
}
export function createSlackChannel(options: {
  name: string;
  agent: NonNullable<Parameters<typeof createChannel>[0]['agent']>;
  config: SlackConfig;
  ownerId: string;
  paused: () => boolean;
  bridge?: SlackMentionBridge;
}) {
  const facts = new SlackEventFactStore();
  const channel = createChannel({
    name: options.name,
    agent: options.agent,
    identifyUser: (context) =>
      slackIdentity(context, options.config, options.ownerId, facts),
    store: { concurrency: 'serial' },
  });
  const handlers = slackHandlers({ ...options, facts });
  // Channels dispatches a mention to onMention exclusively, so it is not run twice.
  channel.onMention(handlers.mention);
  channel.onMessage(handlers.message);
  return channel;
}
