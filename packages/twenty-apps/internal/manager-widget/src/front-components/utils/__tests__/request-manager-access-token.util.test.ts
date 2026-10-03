import { afterEach, describe, expect, it } from 'vitest';

import { requestManagerAccessToken } from '../request-manager-access-token.util';

describe('requestManagerAccessToken', () => {
  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of the ambient host global
    delete globalThis.frontComponentHostCommunicationApi;
  });

  it('returns the token from the host-provided refresh function', async () => {
    globalThis.frontComponentHostCommunicationApi = {
      requestAccessTokenRefresh: async () => 'fresh-token',
    };

    const token = await requestManagerAccessToken();

    expect(token).toBe('fresh-token');
  });

  it('throws a clear error when the host never provided the function', async () => {
    globalThis.frontComponentHostCommunicationApi = {};

    await expect(requestManagerAccessToken()).rejects.toThrow('cannot authenticate');
  });
});
