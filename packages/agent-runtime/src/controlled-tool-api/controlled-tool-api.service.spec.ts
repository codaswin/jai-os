import { Test } from '@nestjs/testing';

import { ControlledToolApiService } from './controlled-tool-api.service';
import {
  ActionIdReusedError,
  ApprovalRequiredError,
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

  describe('approval-required tools', () => {
    const noteScopedIdentity: AgentIdentity = {
      agentId: 'approval-execution',
      scopes: ['note:write'],
    };

    it('rejects a direct callTool call to a tool that requires approval', async () => {
      await expect(
        service.callTool(
          noteScopedIdentity,
          'add-proof-note-to-test-contact',
          { title: 'hello' },
          'action-8',
        ),
      ).rejects.toThrow(ApprovalRequiredError);

      expect(twentyRequest).not.toHaveBeenCalled();
    });

    it('rejects callApprovedTool for a tool that does not require approval', async () => {
      await expect(
        service.callApprovedTool(
          readScopedIdentity,
          'lookup-person-by-email',
          { email: 'jane@example.com' },
          'action-9',
        ),
      ).rejects.toThrow('does not require approval');
    });

    it('executes an approval-required tool via callApprovedTool', async () => {
      twentyRequest
        .mockResolvedValueOnce({ people: { edges: [{ node: { id: 'contact-1' } }] } }) // find contact
        .mockResolvedValueOnce({ notes: { edges: [] } }) // find note (none yet)
        .mockResolvedValueOnce({ createNote: { id: 'note-1' } }) // create note
        .mockResolvedValueOnce({ createNoteTarget: { id: 'note-target-1' } }); // link to contact

      const result = await service.callApprovedTool(
        noteScopedIdentity,
        'add-proof-note-to-test-contact',
        { title: 'proof note' },
        'action-10',
      );

      expect(result).toEqual({ noteId: 'note-1', personId: 'contact-1', alreadyExisted: false });
      expect(twentyRequest).toHaveBeenCalledTimes(4);
    });

    it('is idempotent: a second call for the same title returns the existing note without creating a new one', async () => {
      twentyRequest.mockResolvedValueOnce({ people: { edges: [{ node: { id: 'contact-1' } }] } }).mockResolvedValueOnce({
        notes: {
          edges: [
            { node: { id: 'note-1', noteTargets: { edges: [{ node: { targetPersonId: 'contact-1' } }] } } },
          ],
        },
      }); // already exists, linked to this exact contact

      const result = await service.callApprovedTool(
        noteScopedIdentity,
        'add-proof-note-to-test-contact',
        { title: 'proof note' },
        'action-11',
      );

      expect(result).toEqual({ noteId: 'note-1', personId: 'contact-1', alreadyExisted: true });
      expect(twentyRequest).toHaveBeenCalledTimes(2);
    });

    it('does not mistake a same-titled note linked to a different contact for "already done"', async () => {
      twentyRequest
        .mockResolvedValueOnce({ people: { edges: [{ node: { id: 'contact-1' } }] } }) // find contact
        .mockResolvedValueOnce({
          notes: {
            edges: [
              // Same title, but targets some other contact — must not short-circuit.
              { node: { id: 'unrelated-note', noteTargets: { edges: [{ node: { targetPersonId: 'someone-else' } }] } } },
            ],
          },
        })
        .mockResolvedValueOnce({ createNote: { id: 'note-2' } })
        .mockResolvedValueOnce({ createNoteTarget: { id: 'note-target-2' } });

      const result = await service.callApprovedTool(
        noteScopedIdentity,
        'add-proof-note-to-test-contact',
        { title: 'proof note' },
        'action-12',
      );

      expect(result).toEqual({ noteId: 'note-2', personId: 'contact-1', alreadyExisted: false });
      expect(twentyRequest).toHaveBeenCalledTimes(4);
    });
  });
});
