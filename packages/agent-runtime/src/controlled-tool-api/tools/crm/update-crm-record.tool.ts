import { z } from 'zod';

import { type ToolDefinition } from '../../types';
import {
  CRM_OBJECT_REGISTRY,
  companyUpdateSchema,
  noteUpdateSchema,
  opportunityUpdateSchema,
  personUpdateSchema,
  type CrmRecordSummary,
} from './crm-object-registry';

// Same reasoning as create-crm-record.tool.ts: built from the real per-type
// schemas so `payload.data` narrows correctly, and 'task'/'invoice' simply
// have no branch — the Controlled Tool API layer rejects them by construction.
// opportunityUpdateSchema's own `stage` field excludes CUSTOMER (see
// crm-object-registry.ts) — deal closure stays a human decision in Twenty's UI.
const payloadSchema = z.discriminatedUnion('objectType', [
  z.object({ objectType: z.literal('person'), id: z.string().min(1), data: personUpdateSchema }),
  z.object({ objectType: z.literal('company'), id: z.string().min(1), data: companyUpdateSchema }),
  z.object({
    objectType: z.literal('opportunity'),
    id: z.string().min(1),
    data: opportunityUpdateSchema,
  }),
  z.object({ objectType: z.literal('note'), id: z.string().min(1), data: noteUpdateSchema }),
]);

export type UpdateCrmRecordPayload = z.infer<typeof payloadSchema>;
export type UpdateCrmRecordResult = CrmRecordSummary;

// Every write-shaped call through this tool requires approval, same as
// create-crm-record.tool.ts — see its own comment for the full reasoning.
//
// No existence check before the mutation, unlike create-crm-record.tool.ts:
// an update sets absolute field values (never a relative delta — there's no
// "increment this field" operation anywhere in this schema), so applying the
// same update twice converges on the same end state. A retry after a
// mid-flight crash re-sends the identical mutation, which is a no-op the
// second time, not a duplicate the way a second create-crm-record call
// would be.
export const updateCrmRecordTool: ToolDefinition<UpdateCrmRecordPayload, UpdateCrmRecordResult> = {
  name: 'update-crm-record',
  requiredScope: 'crm:write',
  requiresApproval: true,
  payloadSchema,
  execute: async (payload, twenty) => {
    const config = CRM_OBJECT_REGISTRY[payload.objectType].update;

    if (!config) {
      throw new Error(`No update configuration registered for "${payload.objectType}"`);
    }

    const variables = config.toMutationData(payload.data);
    const raw = await twenty.request<Record<string, unknown>>(config.mutation, {
      id: payload.id,
      data: variables,
    });

    return config.mapResult(raw);
  },
};
