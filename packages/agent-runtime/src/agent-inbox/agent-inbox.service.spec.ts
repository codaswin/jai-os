import { Test } from '@nestjs/testing';

import { AGENT_INBOX_QUEUE, AGENT_REDIS_CONNECTION } from './agent-inbox-queue.provider';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentInboxService } from './agent-inbox.service';
import { type InboxEventRecord } from './types';

describe('AgentInboxService', () => {
  let service: AgentInboxService;
  let repository: jest.Mocked<
    Pick<AgentInboxRepository, 'insertIfAbsent' | 'find' | 'findRecoverable' | 'setup'>
  >;
  let queue: { add: jest.Mock; getWaiting: jest.Mock; getFailed: jest.Mock; getJob: jest.Mock };

  const pendingRecord: InboxEventRecord = {
    actionId: 'action-1',
    jobName: 'demo-echo',
    payload: { foo: 'bar' },
    status: 'pending',
    result: null,
    error: null,
  };

  beforeEach(async () => {
    repository = {
      insertIfAbsent: jest.fn(),
      find: jest.fn(),
      findRecoverable: jest.fn().mockResolvedValue([]),
      setup: jest.fn().mockResolvedValue(undefined),
    };
    queue = {
      add: jest.fn(),
      getWaiting: jest.fn().mockResolvedValue([]),
      getFailed: jest.fn().mockResolvedValue([]),
      getJob: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentInboxService,
        { provide: AGENT_REDIS_CONNECTION, useValue: {} },
        { provide: AGENT_INBOX_QUEUE, useValue: queue },
        { provide: AgentInboxRepository, useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(AgentInboxService);
  });

  describe('submit', () => {
    it('commits a new event to the inbox and enqueues it', async () => {
      repository.insertIfAbsent.mockResolvedValue(pendingRecord);

      const result = await service.submit('action-1', 'demo-echo', { foo: 'bar' });

      expect(result).toEqual(pendingRecord);
      expect(queue.add).toHaveBeenCalledWith(
        'demo-echo',
        { foo: 'bar' },
        expect.objectContaining({ jobId: 'action-1' }),
      );
    });

    it('does not enqueue a second job for an action ID already in the inbox', async () => {
      repository.insertIfAbsent.mockResolvedValue(null);
      repository.find.mockResolvedValue({ ...pendingRecord, status: 'completed' });

      const result = await service.submit('action-1', 'demo-echo', { foo: 'bar' });

      expect(result.status).toBe('completed');
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('getQueueAgeMetrics', () => {
    it('reports null ages when nothing is waiting or failed', async () => {
      const metrics = await service.getQueueAgeMetrics();

      expect(metrics).toEqual({ oldestWaitingAgeMs: null, oldestFailedAgeMs: null });
    });

    it('reports the age of the oldest waiting and failed jobs', async () => {
      const now = Date.now();

      queue.getWaiting.mockResolvedValue([{ timestamp: now - 10_000 }, { timestamp: now - 1_000 }]);
      queue.getFailed.mockResolvedValue([{ finishedOn: now - 20_000 }]);

      const metrics = await service.getQueueAgeMetrics();

      expect(metrics.oldestWaitingAgeMs).toBeGreaterThanOrEqual(10_000);
      expect(metrics.oldestFailedAgeMs).toBeGreaterThanOrEqual(20_000);
    });
  });

  describe('recoverPendingEvents', () => {
    it('re-enqueues a pending event that has no matching job in Redis', async () => {
      repository.findRecoverable.mockResolvedValue([pendingRecord]);
      queue.getJob.mockResolvedValue(undefined);

      await service['recoverPendingEvents']();

      expect(queue.add).toHaveBeenCalledWith(
        pendingRecord.jobName,
        pendingRecord.payload,
        expect.objectContaining({ jobId: pendingRecord.actionId }),
      );
    });

    it('leaves a pending event alone when its job is still in Redis', async () => {
      repository.findRecoverable.mockResolvedValue([pendingRecord]);
      queue.getJob.mockResolvedValue({ id: pendingRecord.actionId });

      await service['recoverPendingEvents']();

      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
