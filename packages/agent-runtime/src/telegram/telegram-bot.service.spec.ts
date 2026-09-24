import { ConfigService } from '@nestjs/config';

import { TelegramBotService } from './telegram-bot.service';

describe('TelegramBotService', () => {
  let service: TelegramBotService;
  let fetchMock: jest.Mock;

  const founderChatId = '111222333';

  beforeEach(() => {
    const configService = {
      getOrThrow: (key: string) =>
        key === 'TELEGRAM_BOT_TOKEN' ? 'test-token' : founderChatId,
    } as ConfigService;

    service = new TelegramBotService(configService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('sendAlert', () => {
    it('posts the message to the founder chat', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await service.sendAlert('backup failed');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/sendMessage'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ chat_id: founderChatId, text: 'backup failed' }),
        }),
      );
    });

    it('throws with the HTTP status when the send fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('bot was blocked by the user'),
      });

      await expect(service.sendAlert('backup failed')).rejects.toThrow(
        /401 Unauthorized.*bot was blocked by the user/,
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('waits for the in-flight poll loop to exit before resolving', async () => {
      let resolvePollFetch = () => {};
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePollFetch = () =>
              resolve({ ok: true, json: () => Promise.resolve({ result: [] }) });
          }),
      );

      service.onModuleInit();
      await Promise.resolve();

      let destroyResolved = false;
      const destroyPromise = service.onModuleDestroy().then(() => {
        destroyResolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(destroyResolved).toBe(false);

      resolvePollFetch();
      await destroyPromise;

      expect(destroyResolved).toBe(true);
    });
  });

  describe('handleUpdate', () => {
    it('logs a message from the founder chat', () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      service.handleUpdate({
        update_id: 1,
        message: { chat: { id: Number(founderChatId) }, text: 'status?' },
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status?'));
    });

    it('ignores a message from any other chat', () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      service.handleUpdate({
        update_id: 1,
        message: { chat: { id: 999999999 }, text: 'hello' },
      });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('ignores an update with no message', () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      service.handleUpdate({ update_id: 1 });

      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
