import { AgentGraphService } from '../agent-graph/agent-graph.service';
import { ApprovalService } from '../approvals/approval.service';
import { PROOF_ACTION_TOOL_NAME, ProofActionService } from './proof-action.service';

describe('ProofActionService', () => {
  let service: ProofActionService;
  let agentGraph: jest.Mocked<Pick<AgentGraphService, 'checkpointProofAction'>>;
  let approvals: jest.Mocked<Pick<ApprovalService, 'propose'>>;

  beforeEach(() => {
    agentGraph = { checkpointProofAction: jest.fn().mockResolvedValue(undefined) };
    approvals = {
      propose: jest.fn().mockResolvedValue({
        actionId: 'action-1',
        description: 'x',
        toolName: PROOF_ACTION_TOOL_NAME,
        payload: { title: 'a note' },
        status: 'pending',
        expiresAt: new Date(),
      }),
    };

    service = new ProofActionService(
      agentGraph as unknown as AgentGraphService,
      approvals as unknown as ApprovalService,
    );
  });

  describe('propose', () => {
    it('checkpoints the LangGraph state before creating the approval', async () => {
      const callOrder: string[] = [];

      agentGraph.checkpointProofAction.mockImplementation(async () => {
        callOrder.push('checkpoint');
      });
      approvals.propose.mockImplementation(async () => {
        callOrder.push('propose');

        return {
          actionId: 'action-1',
          description: 'x',
          toolName: PROOF_ACTION_TOOL_NAME,
          payload: { title: 'a note' },
          status: 'pending',
          expiresAt: new Date(),
        };
      });

      await service.propose('action-1', 'a note');

      expect(callOrder).toEqual(['checkpoint', 'propose']);
    });

    it('proposes through ApprovalService with the whitelisted tool name and the note title as payload', async () => {
      await service.propose('action-1', 'a note');

      expect(approvals.propose).toHaveBeenCalledWith(
        'action-1',
        PROOF_ACTION_TOOL_NAME,
        expect.stringContaining('a note'),
        { title: 'a note' },
      );
    });
  });
});
