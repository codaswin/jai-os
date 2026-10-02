import { z } from 'zod';

import { type ToolDefinition, type TwentyGraphqlClient } from '../../types';
import {
  CRM_OBJECT_REGISTRY,
  companyCreateSchema,
  noteCreateSchema,
  opportunityCreateSchema,
  personCreateSchema,
  type CrmRecordSummary,
} from './crm-object-registry';

// Built from the real, per-type exported schemas (not CRM_OBJECT_REGISTRY's
// own type-erased dataSchema) so `payload.data` narrows to the correct shape
// per branch below, instead of collapsing to `unknown`. 'task' has no branch
// here at all — this union is the only way a create call can reach Twenty,
// so a task (or an Invoice, never defined anywhere in the registry) literal
// fails zod validation at this boundary, not by the model declining to try.
const payloadSchema = z.discriminatedUnion('objectType', [
  z.object({ objectType: z.literal('person'), data: personCreateSchema }),
  z.object({ objectType: z.literal('company'), data: companyCreateSchema }),
  z.object({ objectType: z.literal('opportunity'), data: opportunityCreateSchema }),
  z.object({ objectType: z.literal('note'), data: noteCreateSchema }),
]);

export type CreateCrmRecordPayload = z.infer<typeof payloadSchema>;
export type CreateCrmRecordResult = CrmRecordSummary;

const CREATE_NOTE_TARGET_MUTATION = /* GraphQL */ `
  mutation CreateNoteTargetForManagerNote($data: NoteTargetCreateInput!) {
    createNoteTarget(data: $data) {
      id
    }
  }
`;

// Every write-shaped call through this tool requires approval (ticket #42's
// own documented Phase 3 safety choice, broader than 07-security-and-
// permissions.md's baseline) — structurally enforced by
// ControlledToolApiService.callTool, which rejects a direct call to any tool
// registered with requiresApproval: true, exactly as #25 built it.
export const createCrmRecordTool: ToolDefinition<CreateCrmRecordPayload, CreateCrmRecordResult> = {
  name: 'create-crm-record',
  requiredScope: 'crm:write',
  requiresApproval: true,
  payloadSchema,
  execute: async (payload, twenty) => {
    const config = CRM_OBJECT_REGISTRY[payload.objectType].create;

    if (!config) {
      // Unreachable given the schema above, but this keeps the branch total
      // rather than asserting past a config that could in principle be
      // removed from the registry without the schema noticing.
      throw new Error(`No create configuration registered for "${payload.objectType}"`);
    }

    // The real idempotency guard for this write (same reasoning as ticket
    // #25's own proof-action tool): ApprovalRepository's CAS stops a second
    // *authorization*, but a crash between this tool succeeding and
    // checkAndConsume recording it leaves the approval still 'approved', so
    // BullMQ retries the whole job and calls this tool again. Checking for an
    // already-created match first is what makes that retry safe, regardless
    // of which caller or how many times.
    const existing = await findExistingRecord(payload, twenty);

    if (existing) {
      return existing;
    }

    const variables = config.toMutationData(payload.data);
    const raw = await twenty.request<Record<string, unknown>>(config.mutation, {
      data: variables,
    });
    const result = config.mapResult(raw);

    // Notes are the one object type the Manager can usefully attach to
    // another record on creation (a note "about" a person). This is a
    // deliberate one-off, not a generic relation-linking mechanism — no
    // other object type in this registry supports it.
    if (
      payload.objectType === 'note' &&
      typeof payload.data.targetPersonId === 'string' &&
      typeof result.id === 'string'
    ) {
      await twenty.request(CREATE_NOTE_TARGET_MUTATION, {
        data: { noteId: result.id, targetPersonId: payload.data.targetPersonId },
      });
    }

    return result;
  },
};

// Person and Company have a natural unique key (email, name) to check
// before creating; Note's natural key is title, scoped to its target person
// when one is given (the exact fix ticket #25's own code review found
// necessary — a same-titled unrelated note must not look like "already
// done"). Opportunity has no natural unique key at all — a retry after a
// mid-flight crash can create a second Opportunity with the same name; this
// is a known, accepted gap (see crm-object-registry.ts), not an oversight.
async function findExistingRecord(
  payload: CreateCrmRecordPayload,
  twenty: TwentyGraphqlClient,
): Promise<CrmRecordSummary | null> {
  const filter = buildExistenceFilter(payload);

  if (!filter) {
    return null;
  }

  const lookup = CRM_OBJECT_REGISTRY[payload.objectType].lookup;
  const raw = await twenty.request<Record<string, { edges: { node: Record<string, unknown> }[] }>>(
    lookup.query,
    { filter },
  );
  const edges = Object.values(raw)[0]?.edges ?? [];
  const candidates = edges.map((edge) => lookup.mapNode(edge.node));

  if (payload.objectType === 'note' && payload.data.targetPersonId) {
    const targetPersonId = payload.data.targetPersonId;

    return (
      candidates.find((candidate) => {
        const targetPersonIds = candidate.targetPersonIds;

        return Array.isArray(targetPersonIds) && targetPersonIds.includes(targetPersonId);
      }) ?? null
    );
  }

  return candidates[0] ?? null;
}

function buildExistenceFilter(payload: CreateCrmRecordPayload): Record<string, unknown> | null {
  if (payload.objectType === 'person' && payload.data.primaryEmail) {
    return { emails: { primaryEmail: { eq: payload.data.primaryEmail } } };
  }

  if (payload.objectType === 'company') {
    return { name: { eq: payload.data.name } };
  }

  if (payload.objectType === 'note') {
    return { title: { eq: payload.data.title } };
  }

  return null;
}
