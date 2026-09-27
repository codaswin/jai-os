export type InboxEventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type InboxEventRecord = {
  actionId: string;
  jobName: string;
  payload: unknown;
  status: InboxEventStatus;
  result: unknown;
  error: string | null;
};
