import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AgentGraphService } from '../agent-graph/agent-graph.service';
import { ApprovalService } from '../approvals/approval.service';

// Must match the name add-proof-note-to-test-contact.tool.ts registers
// itself under in TOOL_REGISTRY.
export const PROOF_ACTION_TOOL_NAME = 'add-proof-note-to-test-contact';

const DEMO_ACTION_ID = 'proof-action-demo';

// Ticket #25's own orchestrator — deliberately separate from ApprovalService
// (which stays generic, unaware of LangGraph) and from AgentGraphService
// (whose own demo this doesn't extend). This is the one place that wires
// the durable inbox, LangGraph checkpoint, approval gate and the real
// Controlled Tool API write together for a single synthetic action, proving
// #15/#20/#21/#22 are actually connected, not just individually correct.
@Injectable()
export class ProofActionService implements OnModuleInit {
  private readonly logger = new Logger(ProofActionService.name);

  constructor(
    private readonly agentGraph: AgentGraphService,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit(): void {
    void this.runDemo();
  }

  // Checkpoints a LangGraph "propose" state under thread_id = actionId, then
  // creates the approval record and sends the Telegram request. Deliberately
  // not auto-approved here, unlike #21/#22's own boot demos — proving a
  // fresh boot never silently executes the harmless write without a real
  // approval is itself part of what this ticket exists to demonstrate.
  async propose(actionId: string, title: string): Promise<void> {
    const payload = { title };

    await this.agentGraph.checkpointProofAction(actionId, payload);
    await this.approvals.propose(
      actionId,
      PROOF_ACTION_TOOL_NAME,
      `Synthetic proof action: add a note ("${title}") to the designated test contact`,
      payload,
    );
  }

  private async runDemo(): Promise<void> {
    try {
      await this.propose(DEMO_ACTION_ID, `Synthetic proof action demo (${DEMO_ACTION_ID})`);
      this.logger.log(
        'Proof action proposed (or already existed from a prior boot) — awaiting approval, never auto-executed',
      );
    } catch (error) {
      this.logger.error(
        'Proof action proposal failed',
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
