export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`No tool registered under the name "${toolName}"`);
    this.name = 'UnknownToolError';
  }
}

export class ActionIdReusedError extends Error {
  constructor(actionId: string, previousToolName: string, toolName: string) {
    super(
      `Action ID "${actionId}" was already used for tool "${previousToolName}", not "${toolName}"`,
    );
    this.name = 'ActionIdReusedError';
  }
}

export class PermissionScopeError extends Error {
  constructor(agentId: string, toolName: string, requiredScope: string) {
    super(
      `Agent "${agentId}" is not permitted to call "${toolName}" (requires scope "${requiredScope}")`,
    );
    this.name = 'PermissionScopeError';
  }
}
