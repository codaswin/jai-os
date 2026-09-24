import { throwOnFailedResponse } from './throw-on-failed-response';

describe('throwOnFailedResponse', () => {
  it('does nothing when the response is ok', async () => {
    await expect(
      throwOnFailedResponse({ ok: true } as Response, 'Some request'),
    ).resolves.toBeUndefined();
  });

  it('throws with the status, statusText and body when the response is not ok', async () => {
    const response = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: () => Promise.resolve('upstream unavailable'),
    } as unknown as Response;

    await expect(throwOnFailedResponse(response, 'Some request')).rejects.toThrow(
      'Some request failed: 502 Bad Gateway — upstream unavailable',
    );
  });
});
