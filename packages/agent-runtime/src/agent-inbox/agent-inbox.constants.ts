// Shared between agent-inbox.service.ts and agent-inbox-worker.service.ts —
// kept in its own file, not exported from either, since those two now import
// each other (AgentInboxService injects AgentInboxWorkerService to sequence
// shutdown) and a value both needed would make that circular.
export const DEMO_JOB_NAME = 'demo-echo';
