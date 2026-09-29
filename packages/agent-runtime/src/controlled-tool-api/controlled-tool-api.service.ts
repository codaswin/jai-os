import { traceTool } from '@arizeai/openinference-core';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { stableStringify } from '../shared/stable-stringify';
import {
  ActionIdReusedError,
  ApprovalRequiredError,
  InvalidPayloadError,
  PermissionScopeError,
  UnknownToolError,
} from './errors';
import { TOOL_REGISTRY } from './tool-registry';
import { TwentyGraphqlClientService } from './twenty-graphql-client.service';
import { type AgentIdentity, type RegisteredTool } from './types';

type TrackedAction = {
  toolName: string;
  payloadKey: string;
  resultPromise: Promise<unknown>;
};

// Interim in-memory duplicate protection: enough to prove the boundary
// rejects a repeated action ID now, including a concurrent retry racing
// the first call. Ticket #7/#11 replace this with a persistent,
// restart-safe store once the agent database exists.
const MAX_TRACKED_ACTIONS = 10_000;

// Exercises the real path (this service -> Twenty's GraphQL API) once at
// boot so there's always a real trace to find in Phoenix, the same role
// AgentGraphService.runDemo plays for the persistence layer.
const DEMO_IDENTITY: AgentIdentity = {
  agentId: 'controlled-tool-api-demo',
  scopes: ['person:read'],
};
const DEMO_ACTION_ID = 'controlled-tool-api-demo';

@Injectable()
export class ControlledToolApiService implements OnModuleInit {
  private readonly logger = new Logger(ControlledToolApiService.name);
  private readonly trackedActions = new Map<string, TrackedAction>();
  readonly callTool: (
    identity: AgentIdentity,
    toolName: string,
    payload: unknown,
    actionId: string,
  ) => Promise<unknown>;

  // A separate entry point, not a flag on callTool: callTool rejects an
  // approval-required tool outright (see callToolImpl), so the only way to
  // actually run one is through here — and this is only ever called from
  // ApprovalService.executeApprovalGatedJob, after ApprovalRepository's
  // checkAndConsume CAS has already atomically authorized exactly one
  // execution. See ticket #25's ADR.
  readonly callApprovedTool: (
    identity: AgentIdentity,
    toolName: string,
    payload: unknown,
    actionId: string,
  ) => Promise<unknown>;

  constructor(private readonly twenty: TwentyGraphqlClientService) {
    this.callTool = traceTool(this.callToolImpl.bind(this), { name: 'callTool' });
    this.callApprovedTool = traceTool(this.callApprovedToolImpl.bind(this), {
      name: 'callApprovedTool',
    });
  }

  onModuleInit(): void {
    void this.runDemo();
  }

  private async runDemo(): Promise<void> {
    try {
      const result = await this.callTool(
        DEMO_IDENTITY,
        'lookup-person-by-email',
        { email: 'demo-trace@jai-os.internal' },
        DEMO_ACTION_ID,
      );

      this.logger.log(`Controlled Tool API demo call succeeded: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(
        'Controlled Tool API demo call failed',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  private async callToolImpl(
    identity: AgentIdentity,
    toolName: string,
    payload: unknown,
    actionId: string,
  ): Promise<unknown> {
    const tool = TOOL_REGISTRY[toolName];

    if (!tool) {
      throw new UnknownToolError(toolName);
    }

    if (tool.requiresApproval) {
      throw new ApprovalRequiredError(toolName);
    }

    return this.executeTool(tool, identity, payload, actionId);
  }

  private async callApprovedToolImpl(
    identity: AgentIdentity,
    toolName: string,
    payload: unknown,
    actionId: string,
  ): Promise<unknown> {
    const tool = TOOL_REGISTRY[toolName];

    if (!tool) {
      throw new UnknownToolError(toolName);
    }

    if (!tool.requiresApproval) {
      throw new Error(
        `Tool "${toolName}" does not require approval — call callTool directly instead`,
      );
    }

    return this.executeTool(tool, identity, payload, actionId);
  }

  private async executeTool(
    tool: RegisteredTool,
    identity: AgentIdentity,
    payload: unknown,
    actionId: string,
  ): Promise<unknown> {
    if (!identity.scopes.includes(tool.requiredScope)) {
      throw new PermissionScopeError(identity.agentId, tool.name, tool.requiredScope);
    }

    const parsedPayload = tool.payloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      throw new InvalidPayloadError(tool.name, parsedPayload.error.message);
    }

    const payloadKey = stableStringify(parsedPayload.data);
    const existing = this.trackedActions.get(actionId);

    if (existing) {
      if (existing.toolName !== tool.name) {
        throw new ActionIdReusedError(actionId, 'a different tool');
      }

      if (existing.payloadKey !== payloadKey) {
        throw new ActionIdReusedError(actionId, 'a different payload');
      }

      return existing.resultPromise;
    }

    // Reserve the slot synchronously, before awaiting anything, so a
    // concurrent call with the same actionId finds this entry instead of
    // racing past the same "not present yet" check and double-executing.
    const resultPromise = tool.execute(parsedPayload.data, this.twenty);

    this.trackFor(actionId, { toolName: tool.name, payloadKey, resultPromise });

    // A failed call didn't actually complete the action, so a genuine
    // retry with the same actionId should get to try again rather than
    // replaying the same rejection forever.
    resultPromise.catch(() => this.trackedActions.delete(actionId));

    return resultPromise;
  }

  private trackFor(actionId: string, action: TrackedAction): void {
    if (this.trackedActions.size >= MAX_TRACKED_ACTIONS) {
      const oldestActionId = this.trackedActions.keys().next().value;

      if (oldestActionId !== undefined) {
        this.trackedActions.delete(oldestActionId);
      }
    }

    this.trackedActions.set(actionId, action);
  }
}
