export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`No tool registered under the name "${toolName}"`);
    this.name = 'UnknownToolError';
  }
}

export class InvalidPayloadError extends Error {
  constructor(toolName: string, issues: string) {
    super(`Payload for tool "${toolName}" failed validation: ${issues}`);
    this.name = 'InvalidPayloadError';
  }
}

export class ActionIdReusedError extends Error {
  constructor(actionId: string, reason: 'a different tool' | 'a different payload') {
    super(`Action ID "${actionId}" was already used with ${reason}`);
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
