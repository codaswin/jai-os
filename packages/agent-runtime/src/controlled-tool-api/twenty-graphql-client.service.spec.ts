import { ConfigService } from '@nestjs/config';

import { TwentyGraphqlClientService } from './twenty-graphql-client.service';

describe('TwentyGraphqlClientService', () => {
  let service: TwentyGraphqlClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const configService = {
      getOrThrow: (key: string) =>
        key === 'TWENTY_API_URL' ? 'https://twenty.internal/graphql' : 'test-api-key',
    } as ConfigService;

    service = new TwentyGraphqlClientService(configService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('throws with the HTTP status when the response is not ok, without attempting to parse it as GraphQL', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('invalid API key'),
    });

    await expect(service.request('query { people { edges { node { id } } } }')).rejects.toThrow(
      /401 Unauthorized.*invalid API key/,
    );
  });

  it('throws a clear error when the response has neither data nor errors', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await expect(service.request('query { people { edges { node { id } } } }')).rejects.toThrow(
      'Twenty GraphQL response had neither data nor errors',
    );
  });

  it('returns data on a successful response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { ok: true } }),
    });

    await expect(
      service.request('query { people { edges { node { id } } } }'),
    ).resolves.toEqual({ ok: true });
  });
});
