import { ConfigService } from '@nestjs/config';

import { TwentyCurrentUserService } from './twenty-current-user.service';

describe('TwentyCurrentUserService', () => {
  let service: TwentyCurrentUserService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const configService = {
      getOrThrow: () => 'http://twenty-server/metadata',
    } as unknown as ConfigService;

    service = new TwentyCurrentUserService(configService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns the current user for a valid token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ data: { currentUser: { id: 'user-1', canAccessFullAdminPanel: true } } }),
    });

    const result = await service.verifyToken('valid-token');

    expect(result).toEqual({ id: 'user-1', canAccessFullAdminPanel: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://twenty-server/metadata',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
      }),
    );
  });

  it('returns null for a 401 (invalid or expired token), without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') });

    const result = await service.verifyToken('expired-token');

    expect(result).toBeNull();
  });

  it('returns null for a 403', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('') });

    const result = await service.verifyToken('revoked-token');

    expect(result).toBeNull();
  });

  it('returns null when Twenty reports a GraphQL-level auth error instead of an HTTP 401', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ errors: [{ message: 'Unauthenticated' }] }),
    });

    const result = await service.verifyToken('bad-token');

    expect(result).toBeNull();
  });

  it('throws for a genuine transport/server failure, not just an auth failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('boom'),
    });

    await expect(service.verifyToken('any-token')).rejects.toThrow('500');
  });

  it('identifies a Member (non-Admin) user correctly', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ data: { currentUser: { id: 'member-1', canAccessFullAdminPanel: false } } }),
    });

    const result = await service.verifyToken('member-token');

    expect(result).toEqual({ id: 'member-1', canAccessFullAdminPanel: false });
  });
});
