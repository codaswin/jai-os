import { type Job } from 'bullmq';

import { processDemoJob, runJob } from './agent-inbox-worker.service';
import { DEMO_JOB_NAME } from './agent-inbox.service';

describe('processDemoJob', () => {
  it('throws on the first attempt', () => {
    expect(() => processDemoJob(0)).toThrow('Simulated transient failure');
  });

  it('succeeds on a retry', () => {
    expect(processDemoJob(1)).toEqual({ echoed: true });
  });
});

describe('runJob', () => {
  it('dispatches a demo-echo job to processDemoJob', () => {
    const job = { name: DEMO_JOB_NAME, attemptsMade: 2 } as Job;

    expect(runJob(job)).toEqual({ echoed: true });
  });

  it('rejects a job name with no registered handler', () => {
    const job = { name: 'not-a-real-job', attemptsMade: 0 } as Job;

    expect(() => runJob(job)).toThrow('No handler registered for job "not-a-real-job"');
  });
});
