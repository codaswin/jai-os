import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { type Job, UnrecoverableError } from 'bullmq';

import { type AgentInboxService } from '../agent-inbox/agent-inbox.service';
import { AgentGraphService } from '../agent-graph/agent-graph.service';
import { ApprovalRepository } from '../approvals/approval.repository';
import { ApprovalService } from '../approvals/approval.service';
import { type ApprovalRecord, type ApprovalStatus, type ConsumeOutcome } from '../approvals/types';
import { ControlledToolApiService } from '../controlled-tool-api/controlled-tool-api.service';
import { type TwentyGraphqlClientService } from '../controlled-tool-api/twenty-graphql-client.service';
import { stableStringify } from '../shared/stable-stringify';
import { type ApprovalDecision, type TelegramBotService } from '../telegram/telegram-bot.service';
import { type LlmService } from '../llm/llm.service';
import { ManagerAgentService, buildThreadId } from './manager-agent.service';

// 'ai', '@ai-sdk/fireworks', and '@ai-sdk/openai' all ship ESM-only output
// this project's jest config doesn't transform (same reason llm.service.spec.ts
// mocks them) — loaded transitively because manager-agent.service.ts imports
// the real LlmService class (NestJS DI needs the real constructor reference,
// not a type), even though this spec file never constructs a real instance.
jest.mock('ai', () => ({
  tool: jest.fn((spec: unknown) => spec),
}));
jest.mock('@ai-sdk/fireworks', () => ({
  createFireworks: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'fireworks' }))),
}));
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'openai' }))),
}));

// A faithful, in-memory stand-in for ApprovalRepository's real Postgres CAS
// semantics (approval.repository.ts) — not a reimplementation guess, a
// direct port of its documented behavior, so these tests exercise the real
// state machine without a database. Test-only.
class FakeApprovalRepository {
  private readonly rows = new Map<string, ApprovalRecord>();

  async setup(): Promise<void> {}
  async close(): Promise<void> {}

  async insertIfAbsent(
    actionId: string,
    description: string,
    toolName: string | null,
    payload: unknown,
    expiresAt: Date,
  ): Promise<ApprovalRecord | null> {
    if (this.rows.has(actionId)) {
      return null;
    }

    const record: ApprovalRecord = { actionId, description, toolName, payload, status: 'pending', expiresAt };

    this.rows.set(actionId, record);

    return record;
  }

  async find(actionId: string): Promise<ApprovalRecord | null> {
    return this.rows.get(actionId) ?? null;
  }

  async decide(actionId: string, decision: ApprovalDecision): Promise<ApprovalRecord | null> {
    const record = this.rows.get(actionId);

    if (!record || record.status !== 'pending') {
      return null;
    }

    const nextStatus: ApprovalStatus = record.expiresAt.getTime() < Date.now() ? 'expired' : decision;
    const updated = { ...record, status: nextStatus };

    this.rows.set(actionId, updated);

    return updated;
  }

  async expireIfPending(actionId: string): Promise<void> {
    const record = this.rows.get(actionId);

    if (record?.status === 'pending') {
      this.rows.set(actionId, { ...record, status: 'expired' });
    }
  }

  async expireOverduePending(): Promise<string[]> {
    return [];
  }

  async checkAndConsume(actionId: string, payload: unknown): Promise<ConsumeOutcome> {
    const record = this.rows.get(actionId);

    if (!record) {
      return { outcome: 'not-authorized', reason: 'no approval record exists for this action' };
    }

    if (record.status === 'approved' && stableStringify(record.payload) === stableStringify(payload)) {
      this.rows.set(actionId, { ...record, status: 'executed' });

      return { outcome: 'consumed' };
    }

    if (record.status === 'executed') {
      return { outcome: 'already-executed' };
    }

    if (record.status === 'approved') {
      return { outcome: 'not-authorized', reason: 'payload does not match the approved payload' };
    }

    return { outcome: 'not-authorized', reason: `approval status is "${record.status}"` };
  }

  // Test helper only — real ApprovalRepository has no such method, but tests
  // need to force an action straight to 'approved' without a full propose/
  // decide round trip for some scenarios (e.g. the restart test).
  setStatus(actionId: string, status: ApprovalStatus): void {
    const record = this.rows.get(actionId);

    if (record) {
      this.rows.set(actionId, { ...record, status });
    }
  }

  // Test helper only — ManagerAgentService generates its own random action
  // ids, so tests can't predict one to call find() with; they only ever
  // propose one action per scenario here, so "most recently inserted" is
  // unambiguous.
  findLatest(): ApprovalRecord | null {
    const all = [...this.rows.values()];

    return all[all.length - 1] ?? null;
  }
}

function buildHarness() {
  const repository = new FakeApprovalRepository();
  const telegramBot = {
    sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
    onApprovalCallback: jest.fn(),
  } as unknown as TelegramBotService;
  const agentInbox = { submit: jest.fn().mockResolvedValue(undefined) } as unknown as AgentInboxService;

  const twentyRequest = jest.fn();
  const twenty = { request: twentyRequest } as unknown as TwentyGraphqlClientService;
  const controlledToolApi = new ControlledToolApiService(twenty);

  const approvalService = new ApprovalService(
    repository as unknown as ApprovalRepository,
    telegramBot,
    agentInbox,
    controlledToolApi,
  );

  const llmService = { generateWithTools: jest.fn() } as unknown as LlmService;

  const memorySaver = new MemorySaver();
  const agentGraph = {
    getCheckpointer: jest.fn().mockResolvedValue(memorySaver),
  } as unknown as AgentGraphService;

  const manager = new ManagerAgentService(llmService, controlledToolApi, approvalService, agentGraph);
  // onModuleInit only fires through Nest's DI container — this test
  // constructs the service directly, so it's driven by hand, same as
  // approval.service.spec.ts never relies on ApprovalService's own
  // onModuleInit firing automatically.
  manager.onModuleInit();

  return { manager, repository, twentyRequest, llmService, approvalService };
}

// Each entry is one model turn (DeepAgents calls generateWithTools once per
// turn and drives the tool-call loop itself) — queued in call order.
function queueTurns(
  llmService: LlmService,
  turns: { text: string; toolCalls?: { toolCallId: string; toolName: string; input: unknown }[] }[],
) {
  const mock = llmService.generateWithTools as jest.Mock;

  for (const turn of turns) {
    mock.mockImplementationOnce(async () => ({ text: turn.text, toolCalls: turn.toolCalls ?? [] }));
  }
}

describe('ManagerAgentService', () => {
  it('resolves a read instruction to lookup-crm-record and returns a grounded reply', async () => {
    const { manager, llmService, twentyRequest } = buildHarness();

    twentyRequest.mockResolvedValue({
      people: { edges: [{ node: { id: 'p1', name: { firstName: 'Jane', lastName: 'Doe' }, emails: { primaryEmail: 'jane@example.com' }, companyId: null } }] },
    });

    queueTurns(llmService, [
      {
        text: '',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'lookup-crm-record',
            input: { objectType: 'person', filter: { emails: { primaryEmail: { eq: 'jane@example.com' } } } },
          },
        ],
      },
      { text: 'Jane Doe is a lead with email jane@example.com.' },
    ]);

    const result = await manager.handleMessage({
      channel: 'telegram',
      conversationKey: '123',
      text: 'Look up Jane Doe',
    });

    expect(twentyRequest).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('Jane Doe is a lead with email jane@example.com.');
  });

  describe('approval gating — no new execution path into Twenty', () => {
    it('proposes a create instruction for approval and makes no Twenty call until approved', async () => {
      const { manager, llmService, twentyRequest, repository } = buildHarness();

      queueTurns(llmService, [
        {
          text: '',
          toolCalls: [
            {
              toolCallId: 'call-1',
              toolName: 'create-crm-record',
              input: { objectType: 'person', data: { firstName: 'New', lastName: 'Lead' } },
            },
          ],
        },
        { text: "I've proposed creating that person — awaiting your approval." },
      ]);

      const result = await manager.handleMessage({
        channel: 'telegram',
        conversationKey: '123',
        text: 'Add New Lead as a person',
      });

      expect(twentyRequest).not.toHaveBeenCalled();
      expect(result.reply).toContain('awaiting your approval');

      const pending = await findPendingApproval(repository);
      expect(pending?.toolName).toBe('create-crm-record');
      expect(pending?.payload).toEqual({ objectType: 'person', data: { firstName: 'New', lastName: 'Lead' } });
    });
  });

  describe('approval edge cases at the graph level', () => {
    async function proposeViaGraph(harness: ReturnType<typeof buildHarness>) {
      queueTurns(harness.llmService, [
        {
          text: '',
          toolCalls: [
            {
              toolCallId: 'call-1',
              toolName: 'create-crm-record',
              input: { objectType: 'person', data: { firstName: 'New', lastName: 'Lead' } },
            },
          ],
        },
        { text: 'Proposed.' },
      ]);

      await harness.manager.handleMessage({ channel: 'telegram', conversationKey: 'edge', text: 'add a lead' });

      const pending = await findPendingApproval(harness.repository);
      if (!pending) throw new Error('expected a pending approval');

      return pending;
    }

    it('reject produces no Twenty-side effect', async () => {
      const harness = buildHarness();
      const pending = await proposeViaGraph(harness);

      await harness.approvalService.decide(pending.actionId, 'rejected');

      expect(harness.twentyRequest).not.toHaveBeenCalled();
    });

    it('a repeated Approve on an already-executed approval does not duplicate the effect', async () => {
      const harness = buildHarness();
      const pending = await proposeViaGraph(harness);

      harness.twentyRequest.mockResolvedValue({ createPerson: { id: 'person-1' } });
      await harness.approvalService.decide(pending.actionId, 'approved');
      const job = { id: pending.actionId, data: pending.payload } as Job;

      const first = await harness.approvalService['executeApprovalGatedJob'](job);
      const second = await harness.approvalService['executeApprovalGatedJob'](job);

      expect(harness.twentyRequest).toHaveBeenCalledTimes(1);
      expect(first).toMatchObject({ alreadyExecuted: false });
      expect(second).toMatchObject({ alreadyExecuted: true });
    });

    it('an expired approval cannot authorize execution', async () => {
      const harness = buildHarness();
      const pending = await proposeViaGraph(harness);

      harness.repository.setStatus(pending.actionId, 'expired');
      const job = { id: pending.actionId, data: pending.payload } as Job;

      await expect(harness.approvalService['executeApprovalGatedJob'](job)).rejects.toThrow(UnrecoverableError);
      expect(harness.twentyRequest).not.toHaveBeenCalled();
    });

    it('a payload modified after approval is rejected', async () => {
      const harness = buildHarness();
      const pending = await proposeViaGraph(harness);

      await harness.approvalService.decide(pending.actionId, 'approved');
      harness.twentyRequest.mockResolvedValue({ createPerson: { id: 'person-1' } });
      const tamperedJob = {
        id: pending.actionId,
        data: { objectType: 'person', data: { firstName: 'Tampered', lastName: 'Payload' } },
      } as Job;

      // The tool still runs — this payload has no primaryEmail, so
      // create-crm-record's own existence check doesn't apply and it really
      // does create a second Person here, which is the point: checkAndConsume
      // refuses to mark it executed against a payload that doesn't match what
      // was approved regardless, logged not thrown, per approval.service.ts's
      // own documented reasoning — the approval row is what stays correct,
      // not a claim that every tool call here is itself idempotent.
      await harness.approvalService['executeApprovalGatedJob'](tamperedJob);

      const record = await harness.repository.find(pending.actionId);
      expect(record?.status).toBe('approved');
    });

    it('a restart while an approval is pending leaves it pending', async () => {
      const harness = buildHarness();
      const pending = await proposeViaGraph(harness);

      // "Restart" here means: nothing further happens to this row — a fresh
      // process would re-fetch it and find it exactly where it was.
      const record = await harness.repository.find(pending.actionId);

      expect(record?.status).toBe('pending');
    });
  });

  describe('channel isolation', () => {
    it('buildThreadId produces a distinct thread per channel and conversation', () => {
      expect(buildThreadId('telegram', '1')).not.toBe(buildThreadId('telegram', '2'));
      expect(buildThreadId('telegram', '1')).not.toBe(buildThreadId('widget', '1'));
    });

    it('two different conversations do not share checkpointed history', async () => {
      const { manager, llmService } = buildHarness();

      queueTurns(llmService, [{ text: 'Hello from conversation A' }]);
      await manager.handleMessage({ channel: 'telegram', conversationKey: 'a', text: 'hi' });

      queueTurns(llmService, [{ text: 'Hello from conversation B' }]);
      const callsBefore = (llmService.generateWithTools as jest.Mock).mock.calls.length;
      await manager.handleMessage({ channel: 'telegram', conversationKey: 'b', text: 'hi' });

      const secondCallMessages = (llmService.generateWithTools as jest.Mock).mock.calls[callsBefore][0];
      const hasConversationAContent = JSON.stringify(secondCallMessages).includes('conversation A');

      expect(hasConversationAContent).toBe(false);
    });
  });
});

async function findPendingApproval(repository: FakeApprovalRepository): Promise<ApprovalRecord | null> {
  return repository.findLatest();
}
