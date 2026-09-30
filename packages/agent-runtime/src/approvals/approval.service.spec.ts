import { type Job, UnrecoverableError } from 'bullmq';

import { AgentInboxService } from '../agent-inbox/agent-inbox.service';
import { ControlledToolApiService } from '../controlled-tool-api/controlled-tool-api.service';
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
  let controlledToolApi: jest.Mocked<Pick<ControlledToolApiService, 'callApprovedTool'>>;

  const pendingRecord: ApprovalRecord = {
    actionId: 'action-1',
    description: 'do the thing',
    toolName: null,
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
    controlledToolApi = { callApprovedTool: jest.fn().mockResolvedValue({ noteId: 'note-1' }) };

    service = new ApprovalService(
      repository as unknown as ApprovalRepository,
      telegramBot as unknown as TelegramBotService,
      agentInbox as unknown as AgentInboxService,
      controlledToolApi as unknown as ControlledToolApiService,
    );
  });

  describe('propose', () => {
    it('commits a new approval and sends a Telegram request', async () => {
      repository.insertIfAbsent.mockResolvedValue(pendingRecord);

      const result = await service.propose('action-1', null, 'do the thing', { foo: 'bar' });

      expect(result).toEqual(pendingRecord);
      expect(telegramBot.sendApprovalRequest).toHaveBeenCalledWith(
        expect.stringContaining('do the thing'),
        'action-1',
      );
    });

    it('does not resend a Telegram request for an action already proposed', async () => {
      repository.insertIfAbsent.mockResolvedValue(null);
      repository.find.mockResolvedValue(pendingRecord);

      const result = await service.propose('action-1', null, 'do the thing', { foo: 'bar' });

      expect(result).toEqual(pendingRecord);
      expect(telegramBot.sendApprovalRequest).not.toHaveBeenCalled();
    });

    it('passes the tool name through to the repository for a gated real tool call', async () => {
      repository.insertIfAbsent.mockResolvedValue({ ...pendingRecord, toolName: 'add-proof-note-to-test-contact' });

      await service.propose('action-1', 'add-proof-note-to-test-contact', 'do the thing', { foo: 'bar' });

      expect(repository.insertIfAbsent).toHaveBeenCalledWith(
        'action-1',
        'do the thing',
        'add-proof-note-to-test-contact',
        { foo: 'bar' },
        expect.any(Date),
      );
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

    it('executes once for an approved approval with a matching payload and no tool (generic demo path)', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'approved' });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'consumed' });

      const result = await service['executeApprovalGatedJob'](job());

      expect(result).toEqual({ executed: true, alreadyExecuted: false });
      expect(controlledToolApi.callApprovedTool).not.toHaveBeenCalled();
    });

    it('calls the real tool before checkAndConsume, not after', async () => {
      repository.find.mockResolvedValue({
        ...pendingRecord,
        status: 'approved',
        toolName: 'add-proof-note-to-test-contact',
      });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'consumed' });

      const callOrder: string[] = [];

      controlledToolApi.callApprovedTool.mockImplementation(async () => {
        callOrder.push('tool');

        return { noteId: 'note-1' };
      });
      repository.checkAndConsume.mockImplementation(async () => {
        callOrder.push('checkAndConsume');

        return { outcome: 'consumed' };
      });

      const result = await service['executeApprovalGatedJob'](job());

      expect(callOrder).toEqual(['tool', 'checkAndConsume']);
      expect(controlledToolApi.callApprovedTool).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'approval-execution' }),
        'add-proof-note-to-test-contact',
        { foo: 'bar' },
        'action-1',
      );
      expect(result).toEqual({ executed: true, alreadyExecuted: false, result: { noteId: 'note-1' } });
    });

    it('treats an already-executed approval as a harmless no-op, never calling the tool or checkAndConsume again', async () => {
      repository.find.mockResolvedValue({
        ...pendingRecord,
        status: 'executed',
        toolName: 'add-proof-note-to-test-contact',
      });

      const result = await service['executeApprovalGatedJob'](job());

      expect(result).toEqual({ executed: true, alreadyExecuted: true });
      expect(controlledToolApi.callApprovedTool).not.toHaveBeenCalled();
      expect(repository.checkAndConsume).not.toHaveBeenCalled();
    });

    it('never marks executed without the real work having happened first (the mid-flight-kill guarantee)', async () => {
      // If the process died right here — between the tool call and
      // checkAndConsume — the approval must still read 'approved', not
      // 'executed', so a retry knows to actually try the write again.
      repository.find.mockResolvedValue({
        ...pendingRecord,
        status: 'approved',
        toolName: 'add-proof-note-to-test-contact',
      });
      controlledToolApi.callApprovedTool.mockImplementation(async () => {
        expect(repository.checkAndConsume).not.toHaveBeenCalled();

        return { noteId: 'note-1' };
      });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'consumed' });

      await service['executeApprovalGatedJob'](job());

      expect(controlledToolApi.callApprovedTool).toHaveBeenCalled();
      expect(repository.checkAndConsume).toHaveBeenCalled();
    });

    it('does not throw when checkAndConsume unexpectedly reports not-authorized after the real work already ran', async () => {
      repository.find.mockResolvedValue({
        ...pendingRecord,
        status: 'approved',
        toolName: 'add-proof-note-to-test-contact',
      });
      repository.checkAndConsume.mockResolvedValue({
        outcome: 'not-authorized',
        reason: 'payload does not match the approved payload',
      });

      // Not rejects.toThrow: the tool call already happened and (for a real
      // tool) is safely idempotent — throwing here would make BullMQ retry a
      // call that already succeeded, which is worse than logging.
      const result = await service['executeApprovalGatedJob'](job());

      expect(controlledToolApi.callApprovedTool).toHaveBeenCalled();
      expect(result).toEqual({ executed: true, alreadyExecuted: false, result: { noteId: 'note-1' } });
    });

    it('throws (retryable) when checkAndConsume reports not-authorized for a tool-less approval, since no real work happened to protect a retry', async () => {
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'approved', toolName: null });
      repository.checkAndConsume.mockResolvedValue({
        outcome: 'not-authorized',
        reason: 'approval status is "expired"',
      });

      await expect(service['executeApprovalGatedJob'](job())).rejects.toThrow(
        'could not be recorded as executed',
      );
      expect(controlledToolApi.callApprovedTool).not.toHaveBeenCalled();
    });

    it('reports alreadyExecuted: true when checkAndConsume itself reports already-executed (a genuine concurrent-worker race)', async () => {
      repository.find.mockResolvedValue({
        ...pendingRecord,
        status: 'approved',
        toolName: 'add-proof-note-to-test-contact',
      });
      repository.checkAndConsume.mockResolvedValue({ outcome: 'already-executed' });

      const result = await service['executeApprovalGatedJob'](job());

      expect(result).toEqual({ executed: true, alreadyExecuted: true, result: { noteId: 'note-1' } });
    });
  });
});
