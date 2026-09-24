import { type ZodType } from 'zod';

export type AgentIdentity = {
  agentId: string;
  scopes: string[];
};

export type ToolDefinition<TPayload, TResult> = {
  name: string;
  requiredScope: string;
  // Validated at the Controlled Tool API boundary before execute() ever
  // sees the payload — the boundary is the enforcement point, not each tool.
  payloadSchema: ZodType<TPayload>;
  execute: (payload: TPayload, twenty: TwentyGraphqlClient) => Promise<TResult>;
};

export type TwentyGraphqlClient = {
  request: <TResult>(
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<TResult>;
};

// What the whitelist registry stores: tool authors write a fully typed
// ToolDefinition<TPayload, TResult>, but a runtime dispatch keyed by string
// tool name can't preserve each tool's distinct payload/result types, so the
// registry itself is erased to unknown. registerTool() below is the one
// place that performs this erasure.
export type RegisteredTool = {
  name: string;
  requiredScope: string;
  payloadSchema: ZodType<unknown>;
  execute: (payload: unknown, twenty: TwentyGraphqlClient) => Promise<unknown>;
};

export const registerTool = <TPayload, TResult>(
  tool: ToolDefinition<TPayload, TResult>,
): RegisteredTool => ({
  name: tool.name,
  requiredScope: tool.requiredScope,
  payloadSchema: tool.payloadSchema as unknown as RegisteredTool['payloadSchema'],
  execute: tool.execute as unknown as RegisteredTool['execute'],
});
