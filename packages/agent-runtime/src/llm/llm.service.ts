import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenAI } from '@ai-sdk/openai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';

// Reconfirmed against Fireworks' and OpenAI's live catalogs on 2026-09-24 (ticket #17)
// rather than trusting the spec discussion — check again if either provider deprecates
// its model.
const FIREWORKS_MODEL_ID = 'accounts/fireworks/models/deepseek-v4p1-flash';
const OPENAI_FALLBACK_MODEL_ID = 'gpt-4.1-mini';
const FIREWORKS_TIMEOUT_MS = 15_000;
const OPENAI_TIMEOUT_MS = 15_000;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly fireworks: ReturnType<typeof createFireworks>;
  private readonly openai: ReturnType<typeof createOpenAI>;

  constructor(configService: ConfigService) {
    this.fireworks = createFireworks({
      apiKey: configService.getOrThrow<string>('FIREWORKS_API_KEY'),
    });
    this.openai = createOpenAI({
      apiKey: configService.getOrThrow<string>('OPENAI_API_KEY'),
    });
  }

  async generate(prompt: string): Promise<string> {
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
