import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';

import { LlmService } from './llm.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@ai-sdk/fireworks', () => ({
  createFireworks: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'fireworks' }))),
}));

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn((modelId: string) => ({ modelId, provider: 'openai' }))),
}));

describe('LlmService', () => {
  let service: LlmService;
  const generateTextMock = generateText as jest.Mock;

  beforeEach(() => {
    generateTextMock.mockReset();

    const configService = {
      getOrThrow: (key: string) =>
        key === 'FIREWORKS_API_KEY' ? 'test-fireworks-key' : 'test-openai-key',
    } as ConfigService;

    service = new LlmService(configService);
  });

  it('returns the Fireworks result when Fireworks succeeds', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'from fireworks' });

    const result = await service.generate('hello');

    expect(result).toBe('from fireworks');
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('falls over to OpenAI when Fireworks errors, without a caller-visible failure', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Fireworks timed out'))
      .mockResolvedValueOnce({ text: 'from openai' });

    const result = await service.generate('hello');

    expect(result).toBe('from openai');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('propagates the error when both providers fail', async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error('Fireworks timed out'))
      .mockRejectedValueOnce(new Error('OpenAI also down'));

    await expect(service.generate('hello')).rejects.toThrow('OpenAI also down');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});
