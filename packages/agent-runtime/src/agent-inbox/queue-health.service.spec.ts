import { ConfigService } from '@nestjs/config';

import { TelegramBotService } from '../telegram/telegram-bot.service';
import { AgentInboxService } from './agent-inbox.service';
import { QueueHealthService } from './queue-health.service';

describe('QueueHealthService', () => {
  let service: QueueHealthService;
  let agentInbox: jest.Mocked<Pick<AgentInboxService, 'getQueueAgeMetrics'>>;
  let telegramBot: jest.Mocked<Pick<TelegramBotService, 'sendAlert'>>;

  const THRESHOLD_MS = '1000';

  beforeEach(() => {
    agentInbox = { getQueueAgeMetrics: jest.fn() };
    telegramBot = { sendAlert: jest.fn().mockResolvedValue(undefined) };

    const configService = {
      get: () => THRESHOLD_MS,
    } as unknown as ConfigService;

    service = new QueueHealthService(
      configService,
      agentInbox as unknown as AgentInboxService,
      telegramBot as unknown as TelegramBotService,
    );
  });

  it('does not alert while both ages are under threshold', async () => {
    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: 500,
      oldestFailedAgeMs: null,
    });

    await service.checkQueueHealth();

    expect(telegramBot.sendAlert).not.toHaveBeenCalled();
  });

  it('alerts once when the queue age crosses the threshold', async () => {
    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: 5_000,
      oldestFailedAgeMs: null,
    });

    await service.checkQueueHealth();
    await service.checkQueueHealth();

    expect(telegramBot.sendAlert).toHaveBeenCalledTimes(1);
    expect(telegramBot.sendAlert).toHaveBeenCalledWith(expect.stringContaining('oldest waiting job'));
  });

  it('alerts again after the breach clears and recurs', async () => {
    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: 5_000,
      oldestFailedAgeMs: null,
    });
    await service.checkQueueHealth();

    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: 100,
      oldestFailedAgeMs: null,
    });
    await service.checkQueueHealth();

    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: 5_000,
      oldestFailedAgeMs: null,
    });
    await service.checkQueueHealth();

    expect(telegramBot.sendAlert).toHaveBeenCalledTimes(2);
  });

  it('alerts on failed-job age independently of queue age', async () => {
    agentInbox.getQueueAgeMetrics.mockResolvedValue({
      oldestWaitingAgeMs: null,
      oldestFailedAgeMs: 5_000,
    });

    await service.checkQueueHealth();

    expect(telegramBot.sendAlert).toHaveBeenCalledWith(expect.stringContaining('failed job'));
  });
});
