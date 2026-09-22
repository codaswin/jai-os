import { lookupPersonByEmailTool } from './tools/lookup-person-by-email.tool';
import { registerTool, type RegisteredTool } from './types';

// The whitelist: only tools listed here are reachable through the Controlled
// Tool API. Nothing outside this map exists as far as a calling agent is
// concerned.
export const TOOL_REGISTRY: Record<string, RegisteredTool> = {
  [lookupPersonByEmailTool.name]: registerTool(lookupPersonByEmailTool),
};
