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
  // A single handler, not a list: exactly one consumer (ApprovalService) ever
  // needs approve/reject button presses, and it registers once at boot.
  private approvalCallbackHandler: ApprovalCallbackHandler | undefined;

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
  }

  async sendAlert(text: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.founderChatId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    await throwOnFailedResponse(response, 'Telegram sendMessage');
  }

  async sendApprovalRequest(text: string, actionId: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    await throwOnFailedResponse(response, 'Telegram sendMessage (approval request)');
  }

  // Exactly one registration is expected, at module init — see the field
  // comment above.
  onApprovalCallback(handler: ApprovalCallbackHandler): void {
    this.approvalCallbackHandler = handler;
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

    if (chatId === undefined || String(chatId) !== this.founderChatId) {
      if (chatId !== undefined) {
        this.logger.debug(`Ignoring message from non-founder chat ${chatId}`);
      }

      return;
    }

    this.logger.log(`Received message from founder chat: ${update.message?.text ?? ''}`);
  }

  private async processCallbackQuery(
    callbackQuery: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
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

    await this.answerCallbackQuery(callbackQuery.id);
  }

  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    await throwOnFailedResponse(response, 'Telegram answerCallbackQuery');
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
