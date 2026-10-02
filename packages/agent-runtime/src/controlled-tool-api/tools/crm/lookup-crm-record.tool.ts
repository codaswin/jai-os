import { z } from 'zod';

import { type ToolDefinition } from '../../types';
import { CRM_OBJECT_REGISTRY, CRM_OBJECT_TYPES, type CrmRecordSummary } from './crm-object-registry';

export type LookupCrmRecordPayload = {
  objectType: (typeof CRM_OBJECT_TYPES)[number];
  filter: Record<string, unknown>;
};

export type LookupCrmRecordResult = {
  records: CrmRecordSummary[];
};

type LookupQueryResult = Record<string, { edges: { node: Record<string, unknown> }[] }>;

// One generic, read-only lookup across every CRM object type the Manager
// agent (ticket #43) may read, including Task — read access to tasks is in
// scope even though task *writes* are Phase 6. `filter` is passed straight
// through as the GraphQL variable: Twenty's own schema validates its shape
// per object type, so this tool doesn't re-encode five different filter
// input shapes in zod just to reject what Twenty would reject anyway.
export const lookupCrmRecordTool: ToolDefinition<LookupCrmRecordPayload, LookupCrmRecordResult> = {
  name: 'lookup-crm-record',
  requiredScope: 'crm:read',
  payloadSchema: z.object({
    objectType: z.enum(CRM_OBJECT_TYPES),
    filter: z.record(z.string(), z.unknown()),
  }),
  execute: async (payload, twenty) => {
    const config = CRM_OBJECT_REGISTRY[payload.objectType];
    const result = await twenty.request<LookupQueryResult>(config.lookup.query, {
      filter: payload.filter,
    });
    const edges = Object.values(result)[0]?.edges ?? [];

    return { records: edges.map((edge) => config.lookup.mapNode(edge.node)) };
  },
};
