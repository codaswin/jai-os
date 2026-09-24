export class LlmGuardUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `LLM Guard scanner unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'LlmGuardUnavailableError';
  }
}

export type GuardDetectionCategory = 'prompt-injection' | 'pii-or-toxicity';
export type GuardStage = 'input' | 'output';

export class GuardDetectionError extends Error {
  constructor(
    public readonly category: GuardDetectionCategory,
    public readonly stage: GuardStage,
    public readonly scanners: Record<string, number>,
  ) {
    super(`LLM Guard blocked the ${stage} (${category}): ${JSON.stringify(scanners)}`);
    this.name = 'GuardDetectionError';
  }
}
