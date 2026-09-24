import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { throwOnFailedResponse } from '../shared/throw-on-failed-response';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
};

type TelegramGetUpdatesResponse = {
  result: TelegramUpdate[];
};

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
    const chatId = update.message?.chat.id;

    if (chatId === undefined || String(chatId) !== this.founderChatId) {
      if (chatId !== undefined) {
        this.logger.debug(`Ignoring message from non-founder chat ${chatId}`);
      }

      return;
    }

    this.logger.log(`Received message from founder chat: ${update.message?.text ?? ''}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
