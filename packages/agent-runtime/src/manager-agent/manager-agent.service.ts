import { randomUUID } from 'node:crypto';

import { createDeepAgent, type DeepAgent } from 'deepagents';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AgentGraphService } from '../agent-graph/agent-graph.service';
import { ApprovalService } from '../approvals/approval.service';
import { ControlledToolApiService } from '../controlled-tool-api/controlled-tool-api.service';
import { createCrmRecordTool } from '../controlled-tool-api/tools/crm/create-crm-record.tool';
import { lookupCrmRecordTool } from '../controlled-tool-api/tools/crm/lookup-crm-record.tool';
import { updateCrmRecordTool } from '../controlled-tool-api/tools/crm/update-crm-record.tool';
import { type AgentIdentity } from '../controlled-tool-api/types';
import { LlmService } from '../llm/llm.service';
import { LlmServiceChatModel } from './llm-service-chat-model';

// Ticket #42's own documented scope boundary: broad enough for every
// whitelisted CRM tool this ticket registers, but notably missing any
// task:write or invoice:* scope — those simply aren't grantable here, which
// is what makes task assignment (Phase 6) and Invoice access structurally
// unreachable from this identity, not just unregistered by convention.
const MANAGER_IDENTITY: AgentIdentity = {
  agentId: 'manager-agent',
  scopes: ['crm:read', 'crm:write'],
};

// The shared channel interface ticket #43 owes #44 (Telegram) and #45
// (widget): each channel conversation gets its own isolated LangGraph
// thread, and both tickets call the same handleMessage() rather than each
// inventing their own thread_id scheme or talking to the graph directly.
export type ManagerChannel = 'telegram' | 'widget';

export type ManagerMessageInput = {
  channel: ManagerChannel;
  // The channel's own conversation identifier — a Telegram chat ID, or a
  // widget session ID. Opaque to this service; only used for thread isolation.
  conversationKey: string;
  text: string;
};

export type ManagerMessageResult = {
  reply: string;
};

const MANAGER_SYSTEM_PROMPT = `You are the Manager agent for a CRM, speaking only with the founder (the one admin user who can reach you).

You can look up, create, and update People, Companies, Opportunities, and Notes, and look up (but never create or assign) Tasks. You have no access to Invoices at all — do not claim you can create, update, or look one up.

Every create or update you propose requires the founder's explicit approval before anything happens — when you call create-crm-record or update-crm-record, nothing is written yet; it only becomes real once the founder approves. Tell the founder plainly that you've proposed the action and it's awaiting their decision, never imply it already happened.

Never attempt to set an Opportunity's stage to CUSTOMER (this workspace's Closed/Won stage) — marking a deal won is a human decision made directly in Twenty, not something you do on the founder's behalf even if asked. If asked, explain that deal closure has to happen in Twenty itself.

Never attempt to create or assign a Task — task assignment is not something you can do yet. If asked, say so plainly rather than attempting a lookup-crm-record workaround.`;

// Ticket #43 — the Manager agent's own DeepAgents graph. Deliberately does
// NOT use DeepAgents' own interruptOn/human-in-the-loop feature: every
// write-shaped tool here instead proposes through ApprovalService, the exact
// same approval pipeline #22/#25 already built and proved end to end,
// including surviving a mid-flight restart. Reusing it here means every
// approval guarantee (reject -> no effect, no double-execution, expiry,
// payload binding, restart safety) holds for the Manager for free, rather
// than re-deriving them against DeepAgents' own, different HITL mechanism.
@Injectable()
export class ManagerAgentService implements OnModuleInit {
  private readonly logger = new Logger(ManagerAgentService.name);
  private agent: DeepAgent | undefined;
  private initPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly llmService: LlmService,
    private readonly controlledToolApi: ControlledToolApiService,
    private readonly approvalService: ApprovalService,
    private readonly agentGraph: AgentGraphService,
  ) {}

  onModuleInit(): void {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const checkpointer = await this.agentGraph.getCheckpointer();

      this.agent = createDeepAgent({
        name: 'manager-agent',
        model: new LlmServiceChatModel(this.llmService),
        systemPrompt: MANAGER_SYSTEM_PROMPT,
        checkpointer,
        tools: [this.buildLookupTool(), this.buildCreateTool(), this.buildUpdateTool()],
      });
    } catch (error) {
      // Logged here (not only surfaced via handleMessage's own rejection)
      // so a boot-time failure is visible immediately, not just on whatever
      // request happens to be first to call handleMessage.
      this.logger.error(
        'Manager agent failed to initialize',
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  async handleMessage(input: ManagerMessageInput): Promise<ManagerMessageResult> {
    await this.initPromise;

    if (!this.agent) {
      throw new Error('Manager agent failed to initialize');
    }

    const threadId = buildThreadId(input.channel, input.conversationKey);
    const result = await this.agent.invoke(
      { messages: [new HumanMessage(input.text)] },
      { configurable: { thread_id: threadId } },
    );
    const lastMessage = result.messages[result.messages.length - 1];

    return { reply: lastMessage?.text ?? '' };
  }

  private buildLookupTool() {
    return tool(
      async (input: unknown) => {
        const actionId = buildActionId('lookup-crm-record');
        const result = await this.controlledToolApi.callTool(
          MANAGER_IDENTITY,
          lookupCrmRecordTool.name,
          input,
          actionId,
        );

        return JSON.stringify(result);
      },
      {
        name: lookupCrmRecordTool.name,
        description:
          'Look up People, Companies, Opportunities, Notes, or Tasks in the CRM by a filter. Read-only, no approval needed.',
        schema: lookupCrmRecordTool.payloadSchema,
      },
    );
  }

  private buildCreateTool() {
    return tool(
      async (input: unknown) => {
        const actionId = buildActionId('create-crm-record');

        await this.approvalService.propose(
          actionId,
          createCrmRecordTool.name,
          `Create a CRM record: ${JSON.stringify(input)}`,
          input,
        );

        return `Proposed for approval (action ${actionId}). Nothing has been created — awaiting the founder's decision.`;
      },
      {
        name: createCrmRecordTool.name,
        description:
          'Propose creating a Person, Company, Opportunity, or Note. Always requires the founder\'s approval before anything is created — this call only proposes it.',
        schema: createCrmRecordTool.payloadSchema,
      },
    );
  }

  private buildUpdateTool() {
    return tool(
      async (input: unknown) => {
        const actionId = buildActionId('update-crm-record');

        await this.approvalService.propose(
          actionId,
          updateCrmRecordTool.name,
          `Update a CRM record: ${JSON.stringify(input)}`,
          input,
        );

        return `Proposed for approval (action ${actionId}). Nothing has been changed — awaiting the founder's decision.`;
      },
      {
        name: updateCrmRecordTool.name,
        description:
          'Propose updating a Person, Company, Opportunity, or Note. Always requires the founder\'s approval before anything changes — this call only proposes it. Opportunity stage can never be set to CUSTOMER through this tool.',
        schema: updateCrmRecordTool.payloadSchema,
      },
    );
  }
}

export function buildThreadId(channel: ManagerChannel, conversationKey: string): string {
  return `manager:${channel}:${conversationKey}`;
}

// A fresh id per tool invocation: approval/action-id uniqueness only needs
// to hold within one proposed action, and a random id avoids this ticket
// having to reach into LangGraph's run-scoped IDs (which aren't threaded
// through to a tool's own call signature here) just to build one.
function buildActionId(toolName: string): string {
  return `manager:${toolName}:${randomUUID()}`;
}
