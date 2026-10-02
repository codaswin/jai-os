import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenAI } from '@ai-sdk/openai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ModelMessage, type ToolSet, generateText } from 'ai';

import { GuardDetectionError } from '../llm-guard/errors';
import { LlmGuardService } from '../llm-guard/llm-guard.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

export type LlmToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type GenerateWithToolsResult = {
  text: string;
  toolCalls: LlmToolCall[];
};

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

  // For a tool-calling agent (ticket #43's Manager): one non-looping model
  // call per turn — the caller (a DeepAgents/LangGraph graph) drives the
  // multi-turn tool-call loop itself, feeding results back as new messages.
  // Still goes through the same guard/fallback wiring as generate() above:
  // only the newest message in the conversation is scanned as input (not the
  // whole accumulated history on every turn, which would re-scan already
  // -cleared content and waste guard calls), and any resulting text is
  // scanned as output exactly like generate() does.
  async generateWithTools(messages: ModelMessage[], tools: ToolSet): Promise<GenerateWithToolsResult> {
    const latestText = extractText(messages[messages.length - 1]);

    if (latestText) {
      await this.guardInput(latestText);
    }

    const result = await this.generateWithToolsFromProvider(messages, tools);

    if (result.text) {
      await this.guardOutput(latestText, result.text);
    }

    return result;
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
    return this.withFireworksFallback(
      async () => {
        const { text } = await generateText({
          model: this.fireworks(FIREWORKS_MODEL_ID),
          prompt,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(FIREWORKS_TIMEOUT_MS),
        });

        return text;
      },
      async () => {
        const { text } = await generateText({
          model: this.openai(OPENAI_FALLBACK_MODEL_ID),
          prompt,
          abortSignal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        });

        return text;
      },
    );
  }

  private async generateWithToolsFromProvider(
    messages: ModelMessage[],
    tools: ToolSet,
  ): Promise<GenerateWithToolsResult> {
    return this.withFireworksFallback(
      async () => {
        const result = await generateText({
          model: this.fireworks(FIREWORKS_MODEL_ID),
          messages,
          tools,
          // DeepAgents builds its own system message as the first entry in
          // `messages` (ticket #43's LlmServiceChatModel passes it through
          // unchanged) — the AI SDK rejects that by default, wanting system
          // content passed via a separate `instructions` option instead.
          // Allowing it here keeps the message array DeepAgents actually
          // produces instead of this service having to split it apart.
          allowSystemInMessages: true,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(FIREWORKS_TIMEOUT_MS),
        });

        return toGenerateWithToolsResult(result);
      },
      async () => {
        const result = await generateText({
          model: this.openai(OPENAI_FALLBACK_MODEL_ID),
          messages,
          tools,
          allowSystemInMessages: true,
          abortSignal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        });

        return toGenerateWithToolsResult(result);
      },
    );
  }

  private async withFireworksFallback<TResult>(
    callFireworks: () => Promise<TResult>,
    callOpenAI: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await callFireworks();
    } catch (error) {
      this.logger.warn(
        `Fireworks generate() failed, falling over to OpenAI: ${error instanceof Error ? error.message : String(error)}`,
      );

      return await callOpenAI();
    }
  }
}

function extractText(message: ModelMessage | undefined): string {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    // A tool-result part is included too, not just text: it's real CRM data
    // flowing back from Twenty through a tool call, which can carry
    // attacker-planted content (a note body, say) just as easily as typed
    // user input — skipping the scan whenever the newest message happens to
    // be a tool result would leave exactly the turn LLM Guard's injection
    // scanner exists for unscanned.
    return message.content
      .map((part) => {
        if (part.type === 'text') {
          return part.text;
        }

        if (part.type === 'tool-result') {
          return extractToolResultText(part.output);
        }

        return '';
      })
      .join('');
  }

  return '';
}

function extractToolResultText(output: { type: string; value?: unknown }): string {
  if (output.type === 'text' && typeof output.value === 'string') {
    return output.value;
  }

  // Any other output shape (json, error, execution-denied, etc.) still needs
  // to reach the guard scan — stringified is enough for a text-based scanner
  // to inspect, and output.value may not even exist on every variant.
  try {
    return JSON.stringify(output.value ?? output);
  } catch {
    return String(output.value ?? output);
  }
}

function toGenerateWithToolsResult(result: {
  text: string;
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
}): GenerateWithToolsResult {
  return {
    text: result.text,
    toolCalls: result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    })),
  };
}
