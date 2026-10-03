import { describe, expect, it, vi } from 'vitest';

import { sendManagerMessage } from '../send-manager-message.util';

describe('sendManagerMessage', () => {
  it('posts the text with a bearer token and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ reply: 'Jane Doe is a lead.' }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const reply = await sendManagerMessage('token-123', 'Who is Jane Doe?');

    expect(fetchMock).toHaveBeenCalledWith(
      '/agent-api/widget/message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
        body: JSON.stringify({ text: 'Who is Jane Doe?' }),
      }),
    );
    expect(reply).toBe('Jane Doe is a lead.');

    vi.unstubAllGlobals();
  });

  it('throws a clear message on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') }));

    await expect(sendManagerMessage('bad-token', 'hi')).rejects.toThrow('session could not be verified');

    vi.unstubAllGlobals();
  });

  it('throws a clear message on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('') }));

    await expect(sendManagerMessage('member-token', 'hi')).rejects.toThrow('Only an Admin');

    vi.unstubAllGlobals();
  });

  it('throws when the response has no reply field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ unexpected: true }) }),
    );

    await expect(sendManagerMessage('token-123', 'hi')).rejects.toThrow('unexpected response');

    vi.unstubAllGlobals();
  });
});
