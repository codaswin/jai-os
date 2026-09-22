import { Injectable } from '@nestjs/common';

import { PermissionScopeError, UnknownToolError } from './errors';
import { TOOL_REGISTRY } from './tool-registry';
import { TwentyGraphqlClientService } from './twenty-graphql-client.service';
import { type AgentIdentity } from './types';

@Injectable()
export class ControlledToolApiService {
  // Interim in-memory duplicate protection: enough to prove the boundary
  // rejects a repeated action ID now. Ticket #7/#11 replace this with a
  // persistent, restart-safe store once the agent database exists.
  private readonly executedActions = new Map<string, unknown>();

  constructor(private readonly twenty: TwentyGraphqlClientService) {}

  async callTool(
    identity: AgentIdentity,
    toolName: string,
    payload: unknown,
    actionId: string,
  ): Promise<unknown> {
    const tool = TOOL_REGISTRY[toolName];

    if (!tool) {
      throw new UnknownToolError(toolName);
    }

    if (!identity.scopes.includes(tool.requiredScope)) {
      throw new PermissionScopeError(
        identity.agentId,
        toolName,
        tool.requiredScope,
      );
    }

    if (this.executedActions.has(actionId)) {
      return this.executedActions.get(actionId);
    }

    const result = await tool.execute(payload, this.twenty);

    this.executedActions.set(actionId, result);

    return result;
  }
}
