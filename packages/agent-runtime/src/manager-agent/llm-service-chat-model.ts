import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { type CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { type ChatResult } from '@langchain/core/outputs';
import { type StructuredToolInterface } from '@langchain/core/tools';
import { type ModelMessage, type ToolSet, tool as toVercelTool } from 'ai';
import { type ZodType } from 'zod';

import { type LlmService } from '../llm/llm.service';

type LlmServiceChatModelCallOptions = BaseChatModelCallOptions & {
  tools?: StructuredToolInterface[];
};

// Bridges DeepAgents' LangChain-based tool-calling loop to LlmService
// (ticket #43) — DeepAgents expects a LangChain BaseChatModel, LlmService is
// built on the Vercel AI SDK (ticket #17). No existing package bridges a
// Vercel AI SDK model into a LangChain BaseChatModel in the other direction
// from @ai-sdk/langchain (that package does LangChain -> AI SDK UI, not
// this), so this file is a deliberate one-off, not a reinvention of
// something already available. Every call still goes through LlmService's
// own LLM Guard scanning and Fireworks/OpenAI fallback unchanged — this
// class only translates message/tool-call shapes, it has no guardrail or
// provider logic of its own.
export class LlmServiceChatModel extends BaseChatModel<LlmServiceChatModelCallOptions> {
  constructor(private readonly llmService: LlmService) {
    // DeepAgents' graph drives its own multi-turn tool-call loop by calling
    // this model once per turn; token-level streaming adds no value to that
    // loop and LlmService doesn't support it, so it's disabled here rather
    // than left to silently no-op.
    super({ disableStreaming: true });
  }

  _llmType(): string {
    return 'jai-os-llm-service';
  }

  // DeepAgents calls this to attach the tools it was configured with. The
  // standard LangChain pattern: withConfig() returns a RunnableBinding that
  // merges { tools } into call options on every subsequent invoke, which is
  // how _generate below receives them.
  bindTools(tools: BindToolsInput[], kwargs?: Partial<LlmServiceChatModelCallOptions>) {
    const structuredTools = tools.filter(isStructuredToolInterface);

    return this.withConfig({ ...kwargs, tools: structuredTools } as Partial<LlmServiceChatModelCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const modelMessages = messages.map(toModelMessage);
    const tools = toVercelToolSet(options.tools ?? []);

    const result = await this.llmService.generateWithTools(modelMessages, tools);

    const message = new AIMessage({
      content: result.text,
      tool_calls: result.toolCalls.map((call) => ({
        type: 'tool_call' as const,
        id: call.toolCallId,
        name: call.toolName,
        args: asRecord(call.input),
      })),
    });

    return {
      generations: [{ message, text: result.text }],
    };
  }
}

function isStructuredToolInterface(input: BindToolsInput): input is StructuredToolInterface {
  return (
    typeof input === 'object' &&
    input !== null &&
    'name' in input &&
    'schema' in input &&
    typeof (input as { invoke?: unknown }).invoke === 'function'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toModelMessage(message: BaseMessage): ModelMessage {
  const type = message.getType();

  if (type === 'system') {
    return { role: 'system', content: message.text };
  }

  if (type === 'human') {
    return { role: 'user', content: message.text };
  }

  if (type === 'ai') {
    const aiMessage = message as AIMessage;
    const toolCallParts = (aiMessage.tool_calls ?? []).map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.id ?? call.name,
      toolName: call.name,
      input: call.args,
    }));

    if (toolCallParts.length === 0) {
      return { role: 'assistant', content: message.text };
    }

    const textPart = message.text ? [{ type: 'text' as const, text: message.text }] : [];

    return { role: 'assistant', content: [...textPart, ...toolCallParts] };
  }

  if (type === 'tool') {
    const toolCallId = (message as unknown as { tool_call_id: string }).tool_call_id;

    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: message.name ?? 'unknown-tool',
          output: { type: 'text', value: message.text },
        },
      ],
    };
  }

  // Unsupported message type for a tool-calling conversation (e.g. a
  // 'generic' or 'function' message) — surfaced loudly rather than silently
  // dropped, since dropping a turn would make the model reason over an
  // incomplete, unannounced history.
  throw new Error(`LlmServiceChatModel cannot convert a "${type}" message`);
}

function toVercelToolSet(tools: StructuredToolInterface[]): ToolSet {
  const toolSet: ToolSet = {};

  for (const langchainTool of tools) {
    toolSet[langchainTool.name] = toVercelTool({
      description: langchainTool.description,
      // LangChain tool schemas built via `tool()` from zod are the same zod
      // objects the Vercel AI SDK's own `inputSchema` accepts directly — no
      // JSON-schema round-trip needed. The cast below is only bridging two
      // packages' own structural types for the same real zod object; it does
      // not change what's validated at runtime.
      inputSchema: langchainTool.schema as unknown as ZodType,
    });
  }

  return toolSet;
}
