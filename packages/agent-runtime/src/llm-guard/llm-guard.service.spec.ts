import { ConfigService } from '@nestjs/config';

import { LlmGuardUnavailableError } from './errors';
import { LlmGuardService } from './llm-guard.service';

describe('LlmGuardService', () => {
  let service: LlmGuardService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const configService = {
      getOrThrow: (key: string) =>
        key === 'LLM_GUARD_API_URL' ? 'http://llm-guard:8000' : 'test-token',
    } as ConfigService;

    service = new LlmGuardService(configService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('scans a prompt, suppressing the given scanners', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_valid: true, scanners: { PromptInjection: 0.1 } }),
    });

    const result = await service.scanPrompt('hello', ['Anonymize', 'Toxicity']);

    expect(result).toEqual({ isValid: true, scanners: { PromptInjection: 0.1 } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm-guard:8000/scan/prompt',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'hello',
          scanners_suppress: ['Anonymize', 'Toxicity'],
        }),
      }),
    );
  });

  it('scans an output against its prompt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_valid: false, scanners: { Sensitive: 0.9 } }),
    });

    const result = await service.scanOutput('hello', 'my SSN is 123-45-6789');

    expect(result).toEqual({ isValid: false, scanners: { Sensitive: 0.9 } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm-guard:8000/scan/output',
      expect.objectContaining({
        body: JSON.stringify({
          prompt: 'hello',
          output: 'my SSN is 123-45-6789',
          scanners_suppress: [],
        }),
      }),
    );
  });

  it('fails closed with LlmGuardUnavailableError when the request errors', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(service.scanPrompt('hello')).rejects.toThrow(LlmGuardUnavailableError);
  });

  it('fails closed with LlmGuardUnavailableError on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('scanner overloaded'),
    });

    await expect(service.scanPrompt('hello')).rejects.toThrow(LlmGuardUnavailableError);
  });
});
