import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { type LlmService } from '../llm/llm.service';
import { LlmServiceChatModel } from './llm-service-chat-model';

// The 'ai' package ships ESM-only output this project's jest config doesn't
// transform (same reason llm.service.spec.ts mocks it) — `tool()` is a thin,
// type-level-only identity helper in the real package, so mocking it as a
// passthrough preserves real behavior for what these tests actually check:
// this file's own mapping from a LangChain tool to a Vercel-shaped tool spec.
jest.mock('ai', () => ({
  tool: jest.fn((spec: unknown) => spec),
}));

describe('LlmServiceChatModel', () => {
  function buildModel(generateWithTools: jest.Mock) {
    const llmService = { generateWithTools } as unknown as LlmService;

    return new LlmServiceChatModel(llmService);
  }

  it('converts system, human, and prior tool-call history into the shape LlmService expects', async () => {
    const generateWithTools = jest.fn().mockResolvedValue({ text: 'done', toolCalls: [] });
    const model = buildModel(generateWithTools);

    const messages = [
      new SystemMessage('You are the Manager.'),
      new HumanMessage('Look up Jane'),
      new AIMessage({
        content: '',
        tool_calls: [{ type: 'tool_call', id: 'call-1', name: 'lookup-crm-record', args: { objectType: 'person' } }],
      }),
      new ToolMessage({ content: '{"records":[]}', tool_call_id: 'call-1', name: 'lookup-crm-record' }),
    ];

    await model.invoke(messages);

    const [sentMessages] = generateWithTools.mock.calls[0];
    expect(sentMessages).toEqual([
      { role: 'system', content: 'You are the Manager.' },
      { role: 'user', content: 'Look up Jane' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup-crm-record', input: { objectType: 'person' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup-crm-record',
            output: { type: 'text', value: '{"records":[]}' },
          },
        ],
      },
    ]);
  });

  it('returns an AIMessage with text and no tool_calls when the model produces a plain answer', async () => {
    const generateWithTools = jest.fn().mockResolvedValue({ text: 'Jane is a lead.', toolCalls: [] });
    const model = buildModel(generateWithTools);

    const result = await model.invoke([new HumanMessage('Who is Jane?')]);

    expect(result.text).toBe('Jane is a lead.');
    expect(result.tool_calls ?? []).toHaveLength(0);
  });

  it('returns an AIMessage with tool_calls translated from the Vercel AI SDK shape', async () => {
    const generateWithTools = jest.fn().mockResolvedValue({
      text: '',
      toolCalls: [{ toolCallId: 'call-9', toolName: 'create-crm-record', input: { objectType: 'person' } }],
    });
    const model = buildModel(generateWithTools);

    const result = await model.invoke([new HumanMessage('Add a person')]);

    expect(result.tool_calls).toEqual([
      { type: 'tool_call', id: 'call-9', name: 'create-crm-record', args: { objectType: 'person' } },
    ]);
  });

  it('passes bound tools through to LlmService.generateWithTools as a Vercel AI SDK tool set', async () => {
    const generateWithTools = jest.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const model = buildModel(generateWithTools);
    const lookupTool = tool(async () => 'result', {
      name: 'lookup-crm-record',
      description: 'Look something up',
      schema: z.object({ objectType: z.string() }),
    });

    const bound = model.bindTools([lookupTool]);
    await bound.invoke([new HumanMessage('hi')]);

    const [, toolSet] = generateWithTools.mock.calls[0];
    expect(Object.keys(toolSet)).toEqual(['lookup-crm-record']);
    expect(toolSet['lookup-crm-record'].description).toBe('Look something up');
  });
});
