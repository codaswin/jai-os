export type AgentIdentity = {
  agentId: string;
  scopes: string[];
};

export type ToolDefinition<TPayload, TResult> = {
  name: string;
  requiredScope: string;
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
  execute: (payload: unknown, twenty: TwentyGraphqlClient) => Promise<unknown>;
};

export const registerTool = <TPayload, TResult>(
  tool: ToolDefinition<TPayload, TResult>,
): RegisteredTool => ({
  name: tool.name,
  requiredScope: tool.requiredScope,
  execute: tool.execute as unknown as RegisteredTool['execute'],
});
