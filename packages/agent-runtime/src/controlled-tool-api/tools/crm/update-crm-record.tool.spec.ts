import { type TwentyGraphqlClient } from '../../types';
import { updateCrmRecordTool } from './update-crm-record.tool';

describe('updateCrmRecordTool', () => {
  describe('out of scope: fails at the schema, not by the model declining', () => {
    it('rejects objectType "task" — task writes are Phase 6 scope', () => {
      const result = updateCrmRecordTool.payloadSchema.safeParse({
        objectType: 'task',
        id: 'task-1',
        data: { title: 'renamed' },
      });

      expect(result.success).toBe(false);
    });

    it('rejects objectType "invoice" — Invoice is never a registered object type', () => {
      const result = updateCrmRecordTool.payloadSchema.safeParse({
        objectType: 'invoice',
        id: 'invoice-1',
        data: {},
      });

      expect(result.success).toBe(false);
    });
  });

  it('rejects setting an Opportunity to stage CUSTOMER at the schema level, enforced in the schema, not the prompt', () => {
    const result = updateCrmRecordTool.payloadSchema.safeParse({
      objectType: 'opportunity',
      id: 'opp-1',
      data: { stage: 'CUSTOMER' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('stage');
    }
  });

  it('accepts updating an Opportunity to a non-terminal stage', () => {
    const result = updateCrmRecordTool.payloadSchema.safeParse({
      objectType: 'opportunity',
      id: 'opp-1',
      data: { stage: 'MEETING' },
    });

    expect(result.success).toBe(true);
  });

  it('updates a Company via the correct mutation', async () => {
    const request = jest.fn().mockResolvedValue({ updateCompany: { id: 'company-1' } });
    const twenty: TwentyGraphqlClient = { request };

    const result = await updateCrmRecordTool.execute(
      { objectType: 'company', id: 'company-1', data: { name: 'New Name' } },
      twenty,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({
      id: 'company-1',
      data: { name: 'New Name', domainName: undefined },
    });
    expect(result).toEqual({ id: 'company-1' });
  });
});
