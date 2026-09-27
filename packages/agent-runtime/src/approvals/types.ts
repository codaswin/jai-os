export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';

export type ApprovalRecord = {
  actionId: string;
  description: string;
  payload: unknown;
  status: ApprovalStatus;
  expiresAt: Date;
};

export type ConsumeOutcome =
  | { outcome: 'consumed' }
  | { outcome: 'already-executed' }
  | { outcome: 'not-authorized'; reason: string };
