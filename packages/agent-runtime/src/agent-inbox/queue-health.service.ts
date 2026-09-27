import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TelegramBotService } from '../telegram/telegram-bot.service';
import { AgentInboxService } from './agent-inbox.service';

const CHECK_INTERVAL_MS = 60_000;
const DEFAULT_QUEUE_AGE_ALERT_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_FAILED_JOB_AGE_ALERT_THRESHOLD_MS = 5 * 60_000;

// Extends #16's Telegram bot with infra alerting for the agent queue,
// rather than leaving that as a silent gap for the infra-alerts ticket to
// depend on. Debounced per condition: one alert per breach, not one per
// check interval, so a sustained backlog doesn't spam the founder's chat.
@Injectable()
export class QueueHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueHealthService.name);
  private readonly queueAgeThresholdMs: number;
  private readonly failedJobAgeThresholdMs: number;
  private intervalHandle: NodeJS.Timeout | undefined;
  private queueAgeAlertActive = false;
  private failedJobAgeAlertActive = false;

  constructor(
    configService: ConfigService,
    private readonly agentInbox: AgentInboxService,
    private readonly telegramBot: TelegramBotService,
  ) {
    this.queueAgeThresholdMs = Number(
      configService.get<string>('QUEUE_AGE_ALERT_THRESHOLD_MS') ??
        DEFAULT_QUEUE_AGE_ALERT_THRESHOLD_MS,
    );
    this.failedJobAgeThresholdMs = Number(
      configService.get<string>('FAILED_JOB_AGE_ALERT_THRESHOLD_MS') ??
        DEFAULT_FAILED_JOB_AGE_ALERT_THRESHOLD_MS,
    );
  }

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      this.checkQueueHealth().catch((error) =>
        this.logger.error('Queue health check failed', error instanceof Error ? error.stack : error),
      );
    }, CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.intervalHandle);
  }

  async checkQueueHealth(): Promise<void> {
    const { oldestWaitingAgeMs, oldestFailedAgeMs } = await this.agentInbox.getQueueAgeMetrics();

    await this.checkThreshold(
      'queueAgeAlertActive',
      oldestWaitingAgeMs,
      this.queueAgeThresholdMs,
      (ageMs) =>
        `Agent queue alert: the oldest waiting job has been queued for ${Math.round(ageMs / 60_000)} minutes.`,
    );

    await this.checkThreshold(
      'failedJobAgeAlertActive',
      oldestFailedAgeMs,
      this.failedJobAgeThresholdMs,
      (ageMs) =>
        `Agent queue alert: the oldest failed job has been unresolved for ${Math.round(ageMs / 60_000)} minutes.`,
    );
  }

  private async checkThreshold(
    flag: 'queueAgeAlertActive' | 'failedJobAgeAlertActive',
    ageMs: number | null,
    thresholdMs: number,
    message: (ageMs: number) => string,
  ): Promise<void> {
    const breached = ageMs !== null && ageMs >= thresholdMs;

    if (breached && !this[flag]) {
      this[flag] = true;

      try {
        await this.telegramBot.sendAlert(message(ageMs));
      } catch (error) {
        this.logger.error(
          'Failed to send Telegram alert for a queue health breach',
          error instanceof Error ? error.stack : error,
        );
      }
    } else if (!breached) {
      this[flag] = false;
    }
  }
}
