import { ConfigService } from '@nestjs/config';

import { parseApprovalCallbackData, TelegramBotService } from './telegram-bot.service';

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

    it('routes a callback query from the founder to the registered approval handler', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      const handler = jest.fn().mockResolvedValue(undefined);

      service.onApprovalCallback(handler);
      service.handleUpdate({
        update_id: 1,
        callback_query: { id: 'cb-1', data: 'approve:action-1', from: { id: Number(founderChatId) } },
      });

      await flushMicrotasks();

      expect(handler).toHaveBeenCalledWith('action-1', 'approved');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/answerCallbackQuery'),
        expect.objectContaining({ body: JSON.stringify({ callback_query_id: 'cb-1' }) }),
      );
    });

    it('ignores a callback query from any other chat', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);

      service.onApprovalCallback(handler);
      service.handleUpdate({
        update_id: 1,
        callback_query: { id: 'cb-1', data: 'approve:action-1', from: { id: 999999999 } },
      });

      await flushMicrotasks();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('sendApprovalRequest', () => {
    it('posts a message with Approve/Reject inline buttons carrying the action ID', async () => {
      fetchMock.mockResolvedValue({ ok: true });

      await service.sendApprovalRequest('Approve this?', 'action-1');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/sendMessage'),
        expect.objectContaining({
          body: JSON.stringify({
            chat_id: founderChatId,
            text: 'Approve this?',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Approve', callback_data: 'approve:action-1' },
                  { text: 'Reject', callback_data: 'reject:action-1' },
                ],
              ],
            },
          }),
        }),
      );
    });
  });
});

describe('parseApprovalCallbackData', () => {
  it('parses an approve callback', () => {
    expect(parseApprovalCallbackData('approve:action-1')).toEqual({
      actionId: 'action-1',
      decision: 'approved',
    });
  });

  it('parses a reject callback', () => {
    expect(parseApprovalCallbackData('reject:action-1')).toEqual({
      actionId: 'action-1',
      decision: 'rejected',
    });
  });

  it('rejects an unrecognized prefix', () => {
    expect(parseApprovalCallbackData('snooze:action-1')).toBeNull();
  });

  it('rejects undefined data', () => {
    expect(parseApprovalCallbackData(undefined)).toBeNull();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
