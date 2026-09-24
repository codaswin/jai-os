import { Test } from '@nestjs/testing';

import { ControlledToolApiService } from './controlled-tool-api.service';
import {
  ActionIdReusedError,
  InvalidPayloadError,
  PermissionScopeError,
  UnknownToolError,
} from './errors';
import { TwentyGraphqlClientService } from './twenty-graphql-client.service';
import { type AgentIdentity } from './types';

describe('ControlledToolApiService', () => {
  let service: ControlledToolApiService;
  let twentyRequest: jest.Mock;

  const readScopedIdentity: AgentIdentity = {
    agentId: 'test-agent',
    scopes: ['person:read'],
  };

  const unscopedIdentity: AgentIdentity = {
    agentId: 'unscoped-agent',
    scopes: [],
  };

  const personQueryResult = {
    people: {
      edges: [
        {
          node: {
            id: 'person-1',
            name: { firstName: 'Jane', lastName: 'Doe' },
            emails: { primaryEmail: 'jane@example.com' },
          },
        },
      ],
    },
  };

  beforeEach(async () => {
    twentyRequest = jest.fn().mockResolvedValue(personQueryResult);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ControlledToolApiService,
        {
          provide: TwentyGraphqlClientService,
          useValue: { request: twentyRequest },
        },
      ],
    }).compile();

    service = moduleRef.get(ControlledToolApiService);
  });

  it('rejects an unknown tool name', async () => {
    await expect(
      service.callTool(readScopedIdentity, 'not-a-real-tool', {}, 'action-1'),
    ).rejects.toThrow(UnknownToolError);

    expect(twentyRequest).not.toHaveBeenCalled();
  });

  it('rejects a call outside the caller permission scope, even though the tool is whitelisted', async () => {
    await expect(
      service.callTool(
        unscopedIdentity,
        'lookup-person-by-email',
        { email: 'jane@example.com' },
        'action-2',
      ),
    ).rejects.toThrow(PermissionScopeError);

    expect(twentyRequest).not.toHaveBeenCalled();
  });

  it('produces the correct Twenty-side effect on a permitted call', async () => {
    const result = await service.callTool(
      readScopedIdentity,
      'lookup-person-by-email',
      { email: 'jane@example.com' },
      'action-3',
    );

    expect(result).toEqual({
      id: 'person-1',
      firstName: 'Jane',
      lastName: 'Doe',
      primaryEmail: 'jane@example.com',
    });
    expect(twentyRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a payload that fails the tool schema, before calling Twenty', async () => {
    await expect(
      service.callTool(
        readScopedIdentity,
        'lookup-person-by-email',
        { email: 'not-an-email' },
        'action-invalid',
      ),
    ).rejects.toThrow(InvalidPayloadError);

    expect(twentyRequest).not.toHaveBeenCalled();
  });

  it('executes the same action ID once, returning the cached result on repeat', async () => {
    const first = await service.callTool(
      readScopedIdentity,
      'lookup-person-by-email',
      { email: 'jane@example.com' },
      'action-4',
    );
    const second = await service.callTool(
      readScopedIdentity,
      'lookup-person-by-email',
      { email: 'jane@example.com' },
      'action-4',
    );

    expect(second).toEqual(first);
    expect(twentyRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused action ID called with a different payload, rather than returning the stale result', async () => {
    await service.callTool(
      readScopedIdentity,
      'lookup-person-by-email',
      { email: 'jane@example.com' },
      'action-5',
    );

    await expect(
      service.callTool(
        readScopedIdentity,
        'lookup-person-by-email',
        { email: 'someone-else@example.com' },
        'action-5',
      ),
    ).rejects.toThrow(ActionIdReusedError);

    expect(twentyRequest).toHaveBeenCalledTimes(1);
  });

  it('executes a concurrent retry with the same action ID only once', async () => {
    const [first, second] = await Promise.all([
      service.callTool(
        readScopedIdentity,
        'lookup-person-by-email',
        { email: 'jane@example.com' },
        'action-6',
      ),
      service.callTool(
        readScopedIdentity,
        'lookup-person-by-email',
        { email: 'jane@example.com' },
        'action-6',
      ),
    ]);

    expect(second).toEqual(first);
    expect(twentyRequest).toHaveBeenCalledTimes(1);
  });

  it('lets a retry with the same action ID succeed after the first attempt failed', async () => {
    twentyRequest.mockRejectedValueOnce(new Error('transient failure'));

    await expect(
      service.callTool(
        readScopedIdentity,
        'lookup-person-by-email',
        { email: 'jane@example.com' },
        'action-7',
      ),
    ).rejects.toThrow('transient failure');

    const result = await service.callTool(
      readScopedIdentity,
      'lookup-person-by-email',
      { email: 'jane@example.com' },
      'action-7',
    );

    expect(result).toEqual({
      id: 'person-1',
      firstName: 'Jane',
      lastName: 'Doe',
      primaryEmail: 'jane@example.com',
    });
    expect(twentyRequest).toHaveBeenCalledTimes(2);
  });
});
