export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';

export type ApprovalRecord = {
  actionId: string;
  description: string;
  // Set only for an approval gating a real Controlled Tool API call (ticket
  // #25); null for a generic approval like #22's own boot demo, which has
  // no real tool behind it — executeApprovalGatedJob branches on this.
  toolName: string | null;
  payload: unknown;
  status: ApprovalStatus;
  expiresAt: Date;
};

export type ConsumeOutcome =
  | { outcome: 'consumed' }
  | { outcome: 'already-executed' }
  | { outcome: 'not-authorized'; reason: string };
