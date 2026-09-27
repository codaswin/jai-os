import { type Job, UnrecoverableError } from 'bullmq';

import { registerJobHandler } from './job-handler-registry';
import { isFinalAttempt, processDemoJob, runJob } from './agent-inbox-worker.service';
import { DEMO_JOB_NAME } from './agent-inbox.constants';

describe('processDemoJob', () => {
  it('throws on the first attempt', () => {
    expect(() => processDemoJob(0)).toThrow('Simulated transient failure');
  });

  it('succeeds on a retry', () => {
    expect(processDemoJob(1)).toEqual({ echoed: true });
  });
});

describe('runJob', () => {
  it('dispatches a demo-echo job to processDemoJob', async () => {
    const job = { name: DEMO_JOB_NAME, attemptsMade: 2 } as Job;

    await expect(runJob(job)).resolves.toEqual({ echoed: true });
  });

  it('dispatches to a handler registered by another module', async () => {
    const handler = jest.fn().mockResolvedValue({ custom: true });

    registerJobHandler('a-registered-job', handler);

    const job = { name: 'a-registered-job', attemptsMade: 0 } as Job;

    await expect(runJob(job)).resolves.toEqual({ custom: true });
    expect(handler).toHaveBeenCalledWith(job);
  });

  it('rejects a job name with no registered handler', async () => {
    const job = { name: 'not-a-real-job', attemptsMade: 0 } as Job;

    await expect(runJob(job)).rejects.toThrow('No handler registered for job "not-a-real-job"');
  });
});

describe('isFinalAttempt', () => {
  it('is not final while attempts remain', () => {
    const job = { attemptsMade: 1, opts: { attempts: 5 } } as Job;

    expect(isFinalAttempt(job, new Error('transient'))).toBe(false);
  });

  it('is final once this attempt exhausts the configured attempts', () => {
    const job = { attemptsMade: 4, opts: { attempts: 5 } } as Job;

    expect(isFinalAttempt(job, new Error('transient'))).toBe(true);
  });

  it('treats a missing attempts option as a single allowed attempt', () => {
    const job = { attemptsMade: 0, opts: {} } as Job;

    expect(isFinalAttempt(job, new Error('transient'))).toBe(true);
  });

  it('is always final for an UnrecoverableError, regardless of attempts remaining', () => {
    const job = { attemptsMade: 0, opts: { attempts: 5 } } as Job;

    expect(isFinalAttempt(job, new UnrecoverableError('fatal'))).toBe(true);
  });
});
