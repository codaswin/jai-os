import { type Job, UnrecoverableError } from 'bullmq';

import { AgentInboxService } from '../agent-inbox/agent-inbox.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';
import { type ApprovalRecord } from './types';

describe('ApprovalService', () => {
  let service: ApprovalService;
  let repository: jest.Mocked<
    Pick<ApprovalRepository, 'insertIfAbsent' | 'find' | 'decide' | 'expireIfPending' | 'checkAndConsume'>
  >;
  let telegramBot: jest.Mocked<Pick<TelegramBotService, 'sendApprovalRequest' | 'onApprovalCallback'>>;
  let agentInbox: jest.Mocked<Pick<AgentInboxService, 'submit'>>;

  const pendingRecord: ApprovalRecord = {
    actionId: 'action-1',
    description: 'do the thing',
    payload: { foo: 'bar' },
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    repository = {
      insertIfAbsent: jest.fn(),
      find: jest.fn(),
      decide: jest.fn(),
      expireIfPending: jest.fn().mockResolvedValue(undefined),
      checkAndConsume: jest.fn(),
    };
    telegramBot = {
      sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
      onApprovalCallback: jest.fn(),
    };
    agentInbox = { submit: jest.fn().mockResolvedValue(undefined) };

    service = new ApprovalService(
      repository as unknown as ApprovalRepository,
      telegramBot as unknown as TelegramBotService,
      agentInbox as unknown as AgentInboxService,
    );
  });

  describe('propose', () => {
    it('commits a new approval and sends a Telegram request', async () => {
      repository.insertIfAbsent.mockResolvedValue(pendingRecord);

      const result = await service.propose('action-1', 'do the thing', { foo: 'bar' });

      expect(result).toEqual(pendingRecord);
      expect(telegramBot.sendApprovalRequest).toHaveBeenCalledWith(
        expect.stringContaining('do the thing'),
        'action-1',
      );
    });

    it('does not resend a Telegram request for an action already proposed', async () => {
      repository.insertIfAbsent.mockResolvedValue(null);
      repository.find.mockResolvedValue(pendingRecord);

      const result = await service.propose('action-1', 'do the thing', { foo: 'bar' });

      expect(result).toEqual(pendingRecord);
      expect(telegramBot.sendApprovalRequest).not.toHaveBeenCalled();
    });
  });

  describe('decide', () => {
    it('submits the payload to the agent inbox once approved', async () => {
      repository.decide.mockResolvedValue({ ...pendingRecord, status: 'approved' });

      await service.decide('action-1', 'approved');

      expect(agentInbox.submit).toHaveBeenCalledWith(
        'action-1',
        'approval-gated-action',
        pendingRecord.payload,
      );
    });

    it('never submits to the agent inbox on rejection', async () => {
      repository.decide.mockResolvedValue({ ...pendingRecord, status: 'rejected' });

      await service.decide('action-1', 'rejected');

      expect(agentInbox.submit).not.toHaveBeenCalled();
    });

    it('does nothing when the approval was not pending (already decided)', async () => {
      repository.decide.mockResolvedValue(null);

      await service.decide('action-1', 'approved');

      expect(agentInbox.submit).not.toHaveBeenCalled();
    });

    it('does not submit when a late decision was recorded as expired instead', async () => {
      repository.decide.mockResolvedValue({ ...pendingRecord, status: 'expired' });

      await service.decide('action-1', 'approved');

      expect(agentInbox.submit).not.toHaveBeenCalled();
    });
  });

  describe('executeApprovalGatedJob', () => {
    const job = (overrides: Partial<Job> = {}): Job =>
      ({ id: 'action-1', data: { foo: 'bar' }, ...overrides }) as Job;

    it('retries (a plain Error) while still pending and not yet expired', async () => {
      repository.find.mockResolvedValue(pendingRecord);

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(
        'still awaiting a decision',
      );
      expect(repository.checkAndConsume).not.toHaveBeenCalled();
    });

    it('expires and permanently fails (UnrecoverableError) once the TTL has passed', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, expiresAt: new Date(Date.now() - 1) });

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(UnrecoverableError);
      expect(repository.expireIfPending).toHaveBeenCalledWith('action-1');
    });

    it('permanently fails for a rejected approval, never executing', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'rejected' });

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(UnrecoverableError);
      expect(repository.checkAndConsume).not.toHaveBeenCalled();
    });

    it('permanently fails for an already-expired approval, never executing', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'expired' });

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(UnrecoverableError);
      expect(repository.checkAndConsume).not.toHaveBeenCalled();
    });

    it('executes once for an approved approval with a matching payload', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'approved' });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'consumed' });

      const result = await service['executeApprovalGatedJob'](job());

      expect(result).toEqual({ executed: true, alreadyExecuted: false });
    });

    it('treats an already-executed approval as a harmless no-op, not a failure', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'approved' });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'already-executed' });

      const result = await service['executeApprovalGatedJob'](job());

      expect(result).toEqual({ executed: true, alreadyExecuted: true });
    });

    it('permanently fails when the payload does not match what was approved', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'approved' });
      repository.checkAndConsume.mockResolvedValue({
        outcome: 'not-authorized',
        reason: 'payload does not match the approved payload',
      });

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(UnrecoverableError);
    });
  });
});
