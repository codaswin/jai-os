import { type TwentyGraphqlClient } from '../../types';
import { lookupCrmRecordTool } from './lookup-crm-record.tool';

describe('lookupCrmRecordTool', () => {
  it('rejects an object type outside the whitelisted enum at the schema level', () => {
    const result = lookupCrmRecordTool.payloadSchema.safeParse({
      objectType: 'invoice',
      filter: {},
    });

    expect(result.success).toBe(false);
  });

  it('accepts every whitelisted object type, including task (read-only)', () => {
    for (const objectType of ['person', 'company', 'opportunity', 'note', 'task']) {
      const result = lookupCrmRecordTool.payloadSchema.safeParse({ objectType, filter: {} });

      expect(result.success).toBe(true);
    }
  });

  it('dispatches to the correct query for the given object type and maps the result', async () => {
    const request = jest.fn().mockResolvedValue({
      people: { edges: [{ node: { id: 'p1', name: { firstName: 'A', lastName: 'B' }, emails: { primaryEmail: 'a@b.com' }, companyId: null } }] },
    });
    const twenty: TwentyGraphqlClient = { request };

    const result = await lookupCrmRecordTool.execute(
      { objectType: 'person', filter: { emails: { primaryEmail: { eq: 'a@b.com' } } } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ filter: { emails: { primaryEmail: { eq: 'a@b.com' } } } });
    expect(result.records).toEqual([
      { id: 'p1', firstName: 'A', lastName: 'B', primaryEmail: 'a@b.com', companyId: null },
    ]);
  });

  it('returns an empty list when nothing matches', async () => {
    const request = jest.fn().mockResolvedValue({ tasks: { edges: [] } });
    const twenty: TwentyGraphqlClient = { request };

    const result = await lookupCrmRecordTool.execute({ objectType: 'task', filter: {} }, twenty);

    expect(result.records).toEqual([]);
  });
});
