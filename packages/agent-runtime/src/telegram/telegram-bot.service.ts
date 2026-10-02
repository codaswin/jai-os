import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { throwOnFailedResponse } from '../shared/throw-on-failed-response';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
  };
};

type TelegramGetUpdatesResponse = {
  result: TelegramUpdate[];
};

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalCallbackHandler = (actionId: string, decision: ApprovalDecision) => Promise<void>;
// Returns the reply text to send back on the same chat — the handler (the
// Manager agent, ticket #44) owns producing a response, this service only
// owns getting the message to it and the reply back.
export type FounderMessageHandler = (chatId: string, text: string) => Promise<string>;

const POLL_TIMEOUT_SECONDS = 30;
// Longer than the server-side long-poll window above, so a hung connection
// still gets aborted instead of blocking the loop forever.
const POLL_FETCH_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1_000;
const SEND_TIMEOUT_MS = 10_000;
const POLL_ERROR_BACKOFF_MS = 5_000;

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly apiBaseUrl: string;
  private readonly founderChatId: string;
  private readonly shutdownController = new AbortController();
  private offset = 0;
  private polling = false;
  private pollingPromise: Promise<void> = Promise.resolve();
  // Callback-query handling is fire-and-forget from the poll loop's own
  // perspective (see handleUpdate), but a founder's approve/reject tap must
  // never be silently dropped by a shutdown that starts mid-processing —
  // tracked here so onModuleDestroy can wait for every one of them to finish.
  private readonly inFlightCallbacks = new Set<Promise<void>>();
  // Same reasoning as inFlightCallbacks, separate set: a plain message and a
  // callback query are independent flows and shouldn't block each other's
  // shutdown bookkeeping.
  private readonly inFlightMessages = new Set<Promise<void>>();
  // A single handler, not a list: exactly one consumer (ApprovalService) ever
  // needs approve/reject button presses, and it registers once at boot.
  private approvalCallbackHandler: ApprovalCallbackHandler | undefined;
  // Same single-handler reasoning: exactly one consumer (ManagerAgentService,
  // ticket #44) ever needs plain founder messages.
  private founderMessageHandler: FounderMessageHandler | undefined;

  constructor(private readonly configService: ConfigService) {
    const botToken = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');

    this.founderChatId = this.configService.getOrThrow<string>('TELEGRAM_FOUNDER_CHAT_ID');
    this.apiBaseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  onModuleInit(): void {
    this.polling = true;
    this.pollingPromise = this.pollForUpdates();
  }

  // Waits for the poll loop to actually exit before Nest proceeds with
  // shutdown, so its abort-triggered catch block never runs against a
  // partially torn-down module.
  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    this.shutdownController.abort();
    await this.pollingPromise;
    await Promise.all(this.inFlightCallbacks);
    await Promise.all(this.inFlightMessages);
  }

  async sendAlert(text: string): Promise<void> {
    await this.postToTelegram(
      'sendMessage',
      { chat_id: this.founderChatId, text },
      'Telegram sendMessage',
    );
  }

  async sendApprovalRequest(text: string, actionId: string): Promise<void> {
    await this.postToTelegram(
      'sendMessage',
      {
        chat_id: this.founderChatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `approve:${actionId}` },
              { text: 'Reject', callback_data: `reject:${actionId}` },
            ],
          ],
        },
      },
      'Telegram sendMessage (approval request)',
    );
  }

  // Exactly one registration is expected, at module init — see the field
  // comment above.
  onApprovalCallback(handler: ApprovalCallbackHandler): void {
    this.approvalCallbackHandler = handler;
  }

  // Exactly one registration is expected, at module init — see the field
  // comment above.
  onFounderMessage(handler: FounderMessageHandler): void {
    this.founderMessageHandler = handler;
  }

  private async pollForUpdates(): Promise<void> {
    while (this.polling) {
      try {
        const response = await fetch(
          `${this.apiBaseUrl}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT_SECONDS}`,
          {
            signal: AbortSignal.any([
              this.shutdownController.signal,
              AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
            ]),
          },
        );

        await throwOnFailedResponse(response, 'Telegram getUpdates');

        const body = (await response.json()) as TelegramGetUpdatesResponse;

        for (const update of body.result) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.polling) {
          // Aborted by onModuleDestroy — a clean shutdown, not a failure.
          return;
        }

        this.logger.error('Telegram polling error', error instanceof Error ? error.stack : error);
        await this.sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  handleUpdate(update: TelegramUpdate): void {
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      // Fire-and-forget from the poll loop's perspective, like sendAlert
      // callers elsewhere in this app — a callback-handling failure must
      // never stop the poll loop from processing the next update. Tracked in
      // inFlightCallbacks (not just logged on failure) so onModuleDestroy can
      // still wait for it.
      const promise = this.processCallbackQuery(callbackQuery)
        .catch((error) =>
          this.logger.error(
            'Failed to process an approval callback query',
            error instanceof Error ? error.stack : error,
          ),
        )
        .finally(() => this.inFlightCallbacks.delete(promise));

      this.inFlightCallbacks.add(promise);

      return;
    }

    const chatId = update.message?.chat.id;
    const text = update.message?.text;

    if (chatId === undefined || String(chatId) !== this.founderChatId) {
      if (chatId !== undefined) {
        this.logger.debug(`Ignoring message from non-founder chat ${chatId}`);
      }

      return;
    }

    if (!text) {
      return;
    }

    // Logged unconditionally, not only on the no-handler path below — an
    // operator debugging a wrong CRM write or an unexpected reply needs to
    // see what the founder actually typed, and that's otherwise the only
    // record of it (the Manager's own reasoning isn't logged here).
    this.logger.log(`Received message from founder chat: ${text}`);

    if (!this.founderMessageHandler) {
      // No consumer registered (e.g. ManagerAgentModule not loaded) — logged
      // separately so this specific failure mode (vs. a normally-handled
      // message) is distinguishable in the logs.
      this.logger.warn('No founder-message handler is registered — the message above was dropped.');

      return;
    }

    // Fire-and-forget from the poll loop's perspective, same reasoning as
    // processCallbackQuery below — a slow or failing Manager turn must never
    // stall processing the next update. Tracked in inFlightMessages so
    // onModuleDestroy can still wait for it.
    const promise = this.founderMessageHandler(String(chatId), text)
      // Sent to the chatId the handler was actually given, not sendAlert's
      // hardcoded founderChatId — the two are equal today (the guard above
      // only ever invokes the handler for the founder's own chat), but this
      // is the real reply-routing path FounderMessageHandler's own contract
      // promises, not a shortcut that happens to coincide with it.
      .then((reply) =>
        this.postToTelegram(
          'sendMessage',
          { chat_id: String(chatId), text: reply },
          'Telegram sendMessage (founder reply)',
        ),
      )
      .catch((error) =>
        this.logger.error('Failed to process a founder message', error instanceof Error ? error.stack : error),
      )
      .finally(() => this.inFlightMessages.delete(promise));

    this.inFlightMessages.add(promise);
  }

  // Telegram expects every callback_query to be answered — otherwise the
  // tapped button's loading spinner sits there until the client times it out
  // — so this always calls answerCallbackQuery on the way out, including for
  // a non-founder sender or unparseable data, not only on the happy path.
  private async processCallbackQuery(
    callbackQuery: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    try {
      if (String(callbackQuery.from.id) !== this.founderChatId) {
        this.logger.debug(`Ignoring a callback query from non-founder chat ${callbackQuery.from.id}`);

        return;
      }

      const parsed = parseApprovalCallbackData(callbackQuery.data);

      if (!parsed) {
        this.logger.warn(`Ignoring an unrecognized callback query: ${callbackQuery.data ?? ''}`);

        return;
      }

      if (this.approvalCallbackHandler) {
        await this.approvalCallbackHandler(parsed.actionId, parsed.decision);
      }
    } finally {
      await this.answerCallbackQuery(callbackQuery.id);
    }
  }

  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.postToTelegram(
      'answerCallbackQuery',
      { callback_query_id: callbackQueryId },
      'Telegram answerCallbackQuery',
    );
  }

  private async postToTelegram(path: string, body: unknown, context: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    await throwOnFailedResponse(response, context);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function parseApprovalCallbackData(
  data: string | undefined,
): { actionId: string; decision: ApprovalDecision } | null {
  if (!data) {
    return null;
  }

  const [prefix, ...rest] = data.split(':');
  const actionId = rest.join(':');

  if (!actionId) {
    return null;
  }

  if (prefix === 'approve') {
    return { actionId, decision: 'approved' };
  }

  if (prefix === 'reject') {
    return { actionId, decision: 'rejected' };
  }

  return null;
}
