import { type TwentyGraphqlClient } from '../../types';
import { createCrmRecordTool } from './create-crm-record.tool';

const NO_MATCH = { people: { edges: [] } };

describe('createCrmRecordTool', () => {
  describe('out of scope: fails at the schema, not by the model declining', () => {
    it('rejects objectType "task" — task creation is Phase 6 scope', () => {
      const result = createCrmRecordTool.payloadSchema.safeParse({
        objectType: 'task',
        data: { title: 'do the thing' },
      });

      expect(result.success).toBe(false);
    });

    it('rejects objectType "invoice" — Invoice is never a registered object type', () => {
      const result = createCrmRecordTool.payloadSchema.safeParse({
        objectType: 'invoice',
        data: { amount: 100 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects an unregistered tool-level object type entirely', () => {
      const result = createCrmRecordTool.payloadSchema.safeParse({
        objectType: 'something-made-up',
        data: {},
      });

      expect(result.success).toBe(false);
    });
  });

  it('rejects creating an Opportunity with stage CUSTOMER at the schema level', () => {
    const result = createCrmRecordTool.payloadSchema.safeParse({
      objectType: 'opportunity',
      data: { name: 'Big deal', stage: 'CUSTOMER' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts creating an Opportunity with a non-terminal stage', () => {
    const result = createCrmRecordTool.payloadSchema.safeParse({
      objectType: 'opportunity',
      data: { name: 'Big deal', stage: 'PROPOSAL' },
    });

    expect(result.success).toBe(true);
  });

  it('creates a Person via the correct mutation when no existing match is found', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(NO_MATCH)
      .mockResolvedValueOnce({ createPerson: { id: 'person-1' } });
    const twenty: TwentyGraphqlClient = { request };

    const result = await createCrmRecordTool.execute(
      { objectType: 'person', data: { firstName: 'Jane', lastName: 'Doe', primaryEmail: 'jane@example.com' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toEqual({
      data: {
        name: { firstName: 'Jane', lastName: 'Doe' },
        emails: { primaryEmail: 'jane@example.com', additionalEmails: [] },
        companyId: undefined,
      },
    });
    expect(result).toEqual({ id: 'person-1' });
  });

  it('is idempotent: returns the existing Person instead of creating a duplicate when one already matches the email', async () => {
    const request = jest.fn().mockResolvedValue({
      people: { edges: [{ node: { id: 'person-1', name: {}, emails: {}, companyId: null } }] },
    });
    const twenty: TwentyGraphqlClient = { request };

    const result = await createCrmRecordTool.execute(
      { objectType: 'person', data: { firstName: 'Jane', lastName: 'Doe', primaryEmail: 'jane@example.com' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 'person-1' });
  });

  it('does not check for an existing Person when no email is given — there is no natural key to match on', async () => {
    const request = jest.fn().mockResolvedValue({ createPerson: { id: 'person-1' } });
    const twenty: TwentyGraphqlClient = { request };

    await createCrmRecordTool.execute(
      { objectType: 'person', data: { firstName: 'Jane', lastName: 'Doe' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('always creates an Opportunity without an existence check — it has no natural unique key', async () => {
    const request = jest.fn().mockResolvedValue({ createOpportunity: { id: 'opp-1' } });
    const twenty: TwentyGraphqlClient = { request };

    await createCrmRecordTool.execute({ objectType: 'opportunity', data: { name: 'Big deal' } }, twenty);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('links a newly created Note to a target person via a follow-up createNoteTarget call', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ notes: { edges: [] } })
      .mockResolvedValueOnce({ createNote: { id: 'note-1' } })
      .mockResolvedValueOnce({ createNoteTarget: { id: 'note-target-1' } });
    const twenty: TwentyGraphqlClient = { request };

    const result = await createCrmRecordTool.execute(
      { objectType: 'note', data: { title: 'Follow up', targetPersonId: 'person-1' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][1]).toEqual({ data: { noteId: 'note-1', targetPersonId: 'person-1' } });
    expect(result).toEqual({ id: 'note-1' });
  });

  it('is idempotent: returns the existing Note instead of creating a duplicate when one already matches title and target', async () => {
    const request = jest.fn().mockResolvedValue({
      notes: {
        edges: [
          {
            node: {
              id: 'note-1',
              title: 'Follow up',
              noteTargets: { edges: [{ node: { targetPersonId: 'person-1' } }] },
            },
          },
        ],
      },
    });
    const twenty: TwentyGraphqlClient = { request };

    const result = await createCrmRecordTool.execute(
      { objectType: 'note', data: { title: 'Follow up', targetPersonId: 'person-1' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 'note-1' });
  });

  it('does not mistake a same-titled note linked to a different person for "already done"', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        notes: {
          edges: [
            {
              node: {
                id: 'unrelated-note',
                title: 'Follow up',
                noteTargets: { edges: [{ node: { targetPersonId: 'someone-else' } }] },
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ createNote: { id: 'note-2' } })
      .mockResolvedValueOnce({ createNoteTarget: { id: 'note-target-2' } });
    const twenty: TwentyGraphqlClient = { request };

    const result = await createCrmRecordTool.execute(
      { objectType: 'note', data: { title: 'Follow up', targetPersonId: 'person-1' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ id: 'note-2' });
  });

  it('does not attempt to link a Note when no target person is given', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ notes: { edges: [] } })
      .mockResolvedValueOnce({ createNote: { id: 'note-1' } });
    const twenty: TwentyGraphqlClient = { request };

    await createCrmRecordTool.execute({ objectType: 'note', data: { title: 'Standalone note' } }, twenty);

    expect(request).toHaveBeenCalledTimes(2);
  });
});
