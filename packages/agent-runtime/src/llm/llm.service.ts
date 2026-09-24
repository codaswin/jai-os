import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenAI } from '@ai-sdk/openai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';

import { GuardDetectionError } from '../llm-guard/errors';
import { LlmGuardService } from '../llm-guard/llm-guard.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

// Reconfirmed against Fireworks' and OpenAI's live catalogs on 2026-09-24 (ticket #17)
// rather than trusting the spec discussion — check again if either provider deprecates
// its model.
const FIREWORKS_MODEL_ID = 'accounts/fireworks/models/deepseek-v4p1-flash';
const OPENAI_FALLBACK_MODEL_ID = 'gpt-4.1-mini';
const FIREWORKS_TIMEOUT_MS = 15_000;
const OPENAI_TIMEOUT_MS = 15_000;

// The input scan runs twice, each time suppressing the scanners for the OTHER
// category, so a positive can be attributed to exactly one: LLM Guard's response
// only carries an aggregate is_valid plus a risk score per scanner, not a
// pass/fail flag per scanner — this is the only way to tell "which one fired"
// well enough to alert on injection specifically without alerting on PII/toxicity.
const SUPPRESS_TO_ISOLATE_INJECTION = ['Anonymize', 'Toxicity'];
const SUPPRESS_TO_ISOLATE_PII_AND_TOXICITY = ['PromptInjection'];

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly fireworks: ReturnType<typeof createFireworks>;
  private readonly openai: ReturnType<typeof createOpenAI>;

  constructor(
    configService: ConfigService,
    private readonly llmGuard: LlmGuardService,
    private readonly telegramBot: TelegramBotService,
  ) {
    this.fireworks = createFireworks({
      apiKey: configService.getOrThrow<string>('FIREWORKS_API_KEY'),
    });
    this.openai = createOpenAI({
      apiKey: configService.getOrThrow<string>('OPENAI_API_KEY'),
    });
  }

  async generate(prompt: string): Promise<string> {
    await this.guardInput(prompt);

    const text = await this.generateFromProvider(prompt);

    await this.guardOutput(prompt, text);

    return text;
  }

  private async guardInput(prompt: string): Promise<void> {
    const [injection, piiAndToxicity] = await Promise.all([
      this.llmGuard.scanPrompt(prompt, SUPPRESS_TO_ISOLATE_INJECTION),
      this.llmGuard.scanPrompt(prompt, SUPPRESS_TO_ISOLATE_PII_AND_TOXICITY),
    ]);

    if (!injection.isValid) {
      this.logger.warn(
        `LLM Guard blocked a prompt for injection: ${JSON.stringify(injection.scanners)}`,
      );

      // The alert is best-effort — a Telegram failure must not replace the
      // GuardDetectionError a caller expects and pattern-matches on below.
      try {
        await this.telegramBot.sendAlert(
          `LLM Guard blocked a prompt injection attempt. Scores: ${JSON.stringify(injection.scanners)}`,
        );
      } catch (alertError) {
        this.logger.error(
          'Failed to send Telegram alert for a blocked prompt injection attempt',
          alertError instanceof Error ? alertError.stack : alertError,
        );
      }

      throw new GuardDetectionError('prompt-injection', 'input', injection.scanners);
    }

    if (!piiAndToxicity.isValid) {
      this.logger.warn(
        `LLM Guard blocked a prompt for PII/toxicity: ${JSON.stringify(piiAndToxicity.scanners)}`,
      );

      throw new GuardDetectionError('pii-or-toxicity', 'input', piiAndToxicity.scanners);
    }
  }

  private async guardOutput(prompt: string, output: string): Promise<void> {
    const result = await this.llmGuard.scanOutput(prompt, output);

    if (!result.isValid) {
      this.logger.warn(
        `LLM Guard blocked a response for PII/toxicity: ${JSON.stringify(result.scanners)}`,
      );

      throw new GuardDetectionError('pii-or-toxicity', 'output', result.scanners);
    }
  }

  private async generateFromProvider(prompt: string): Promise<string> {
    try {
      const { text } = await generateText({
        model: this.fireworks(FIREWORKS_MODEL_ID),
        prompt,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(FIREWORKS_TIMEOUT_MS),
      });

      return text;
    } catch (error) {
      this.logger.warn(
        `Fireworks generate() failed, falling over to OpenAI: ${error instanceof Error ? error.message : String(error)}`,
      );

      const { text } = await generateText({
        model: this.openai(OPENAI_FALLBACK_MODEL_ID),
        prompt,
        abortSignal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });

      return text;
    }
  }
}
