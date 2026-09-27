import { type Job, type JobsOptions } from 'bullmq';

export type JobHandler = (job: Job) => Promise<unknown>;

type Registration = {
  handler: JobHandler;
  jobOptions?: Partial<JobsOptions>;
};

// Populated by other modules at their own construction time (see
// ApprovalService), the same way controlled-tool-api's TOOL_REGISTRY is
// populated by tool files — a plain shared registry, not a Nest provider, so
// AgentInboxWorkerService can dispatch to a handler (and use its preferred
// job options, both at submit time and at recovery time) without ever
// needing to import the module that owns it.
const registry = new Map<string, Registration>();

export function registerJobHandler(
  jobName: string,
  handler: JobHandler,
  jobOptions?: Partial<JobsOptions>,
): void {
  registry.set(jobName, { handler, jobOptions });
}

export function getJobHandler(jobName: string): JobHandler | undefined {
  return registry.get(jobName)?.handler;
}

export function getJobOptions(jobName: string): Partial<JobsOptions> | undefined {
  return registry.get(jobName)?.jobOptions;
}
