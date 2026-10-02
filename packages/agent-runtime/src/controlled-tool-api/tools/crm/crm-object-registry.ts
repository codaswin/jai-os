import { z, type ZodType } from 'zod';

// The five CRM object types the Manager agent (ticket #43) may touch. 'task'
// is deliberately lookup-only (task creation/assignment is Phase 6 scope);
// Invoice is deliberately absent — adding it to this union is the only way
// an Invoice tool could ever exist, so its absence here is what "no Invoice
// tools" actually means, not a convention a tool author has to remember.
export const CRM_OBJECT_TYPES = ['person', 'company', 'opportunity', 'note', 'task'] as const;
export type CrmObjectType = (typeof CRM_OBJECT_TYPES)[number];

export const CRM_WRITABLE_OBJECT_TYPES = ['person', 'company', 'opportunity', 'note'] as const;
export type CrmWritableObjectType = (typeof CRM_WRITABLE_OBJECT_TYPES)[number];

// Twenty's own stage options for this workspace (confirmed live via GraphQL
// introspection of OpportunityStageEnum, 2026-10-02) — CUSTOMER is the
// Closed/Won terminal stage per 04-data-model.md ("a client once a human
// marks that Opportunity Closed/Won"). Deliberately excluded from both
// schemas below: deal closure is a human decision made in Twenty's own UI,
// never something the Manager's own tool schema can express, let alone the
// model talk its way around.
const NON_TERMINAL_OPPORTUNITY_STAGES = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL'] as const;

export type CrmRecordSummary = Record<string, unknown>;

export type CrmLookupConfig = {
  // Twenty's plural query field name (people/companies/opportunities/notes/tasks).
  query: string;
  mapNode: (node: Record<string, unknown>) => CrmRecordSummary;
};

export type CrmWriteConfig<TData> = {
  mutation: string;
  dataSchema: ZodType<TData>;
  // Twenty's mutation `data` input shape differs from the flat schema above
  // (composite fields like `name: { firstName, lastName }`) — this maps one
  // to the other, kept next to the schema it corresponds to.
  toMutationData: (data: TData) => Record<string, unknown>;
  mapResult: (raw: Record<string, unknown>) => CrmRecordSummary;
};

export type CrmObjectConfig = {
  lookup: CrmLookupConfig;
  // Absent for 'task': lookup-only by design (Phase 6 owns task writes).
  create?: CrmWriteConfig<unknown>;
  update?: CrmWriteConfig<unknown>;
};

// Exported individually, not only via the type-erased CRM_OBJECT_REGISTRY
// below: a tool's discriminated-union payload schema needs the real,
// per-type inferred shape to narrow `data` correctly on `objectType`, which
// the registry's own Record<CrmObjectType, CrmObjectConfig> type can't
// preserve (every entry has to share one erased shape for the dispatch table
// to type-check at all — the same tradeoff RegisteredTool makes in ../../types).
export const personCreateSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  primaryEmail: z.string().email().optional(),
  companyId: z.string().optional(),
});
type PersonCreateData = z.infer<typeof personCreateSchema>;

export const personUpdateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  primaryEmail: z.string().email().optional(),
  companyId: z.string().optional(),
});
type PersonUpdateData = z.infer<typeof personUpdateSchema>;

export const companyCreateSchema = z.object({
  name: z.string().min(1),
  domainUrl: z.string().url().optional(),
});
type CompanyCreateData = z.infer<typeof companyCreateSchema>;

export const companyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  domainUrl: z.string().url().optional(),
});
type CompanyUpdateData = z.infer<typeof companyUpdateSchema>;

export const opportunityCreateSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().optional(),
  pointOfContactId: z.string().optional(),
  amountMicros: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).optional(),
  closeDate: z.string().optional(),
  stage: z.enum(NON_TERMINAL_OPPORTUNITY_STAGES).optional(),
});
type OpportunityCreateData = z.infer<typeof opportunityCreateSchema>;

export const opportunityUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  companyId: z.string().optional(),
  pointOfContactId: z.string().optional(),
  amountMicros: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).optional(),
  closeDate: z.string().optional(),
  stage: z.enum(NON_TERMINAL_OPPORTUNITY_STAGES).optional(),
});
type OpportunityUpdateData = z.infer<typeof opportunityUpdateSchema>;

export const noteCreateSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().optional(),
  targetPersonId: z.string().optional(),
});
type NoteCreateData = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  markdown: z.string().optional(),
});
type NoteUpdateData = z.infer<typeof noteUpdateSchema>;

function currencyInput(amountMicros?: number, currencyCode?: string) {
  if (amountMicros === undefined) {
    return undefined;
  }

  return { amountMicros, currencyCode: currencyCode ?? 'USD' };
}

export const CRM_OBJECT_REGISTRY: Record<CrmObjectType, CrmObjectConfig> = {
  person: {
    lookup: {
      query: /* GraphQL */ `
        query LookupPeople($filter: PersonFilterInput!) {
          people(filter: $filter, first: 20) {
            edges {
              node {
                id
                name {
                  firstName
                  lastName
                }
                emails {
                  primaryEmail
                }
                companyId
              }
            }
          }
        }
      `,
      mapNode: (node) => ({
        id: node.id,
        firstName: (node.name as { firstName: string })?.firstName,
        lastName: (node.name as { lastName: string })?.lastName,
        primaryEmail: (node.emails as { primaryEmail: string })?.primaryEmail,
        companyId: node.companyId,
      }),
    },
    create: {
      mutation: /* GraphQL */ `
        mutation CreatePerson($data: PersonCreateInput!) {
          createPerson(data: $data) {
            id
          }
        }
      `,
      dataSchema: personCreateSchema,
      toMutationData: (data: PersonCreateData) => ({
        name: { firstName: data.firstName, lastName: data.lastName },
        emails: data.primaryEmail
          ? { primaryEmail: data.primaryEmail, additionalEmails: [] }
          : undefined,
        companyId: data.companyId,
      }),
      mapResult: (raw) => ({ id: (raw.createPerson as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
    update: {
      mutation: /* GraphQL */ `
        mutation UpdatePerson($id: ID!, $data: PersonUpdateInput!) {
          updatePerson(id: $id, data: $data) {
            id
          }
        }
      `,
      dataSchema: personUpdateSchema,
      toMutationData: (data: PersonUpdateData) => ({
        name:
          data.firstName || data.lastName
            ? { firstName: data.firstName, lastName: data.lastName }
            : undefined,
        emails: data.primaryEmail
          ? { primaryEmail: data.primaryEmail, additionalEmails: [] }
          : undefined,
        companyId: data.companyId,
      }),
      mapResult: (raw) => ({ id: (raw.updatePerson as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
  },
  company: {
    lookup: {
      query: /* GraphQL */ `
        query LookupCompanies($filter: CompanyFilterInput!) {
          companies(filter: $filter, first: 20) {
            edges {
              node {
                id
                name
                domainName {
                  primaryLinkUrl
                }
              }
            }
          }
        }
      `,
      mapNode: (node) => ({
        id: node.id,
        name: node.name,
        domainUrl: (node.domainName as { primaryLinkUrl: string } | null)?.primaryLinkUrl,
      }),
    },
    create: {
      mutation: /* GraphQL */ `
        mutation CreateCompany($data: CompanyCreateInput!) {
          createCompany(data: $data) {
            id
          }
        }
      `,
      dataSchema: companyCreateSchema,
      toMutationData: (data: CompanyCreateData) => ({
        name: data.name,
        domainName: data.domainUrl
          ? { primaryLinkUrl: data.domainUrl, primaryLinkLabel: '', secondaryLinks: [] }
          : undefined,
      }),
      mapResult: (raw) => ({ id: (raw.createCompany as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
    update: {
      mutation: /* GraphQL */ `
        mutation UpdateCompany($id: ID!, $data: CompanyUpdateInput!) {
          updateCompany(id: $id, data: $data) {
            id
          }
        }
      `,
      dataSchema: companyUpdateSchema,
      toMutationData: (data: CompanyUpdateData) => ({
        name: data.name,
        domainName: data.domainUrl
          ? { primaryLinkUrl: data.domainUrl, primaryLinkLabel: '', secondaryLinks: [] }
          : undefined,
      }),
      mapResult: (raw) => ({ id: (raw.updateCompany as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
  },
  opportunity: {
    lookup: {
      query: /* GraphQL */ `
        query LookupOpportunities($filter: OpportunityFilterInput!) {
          opportunities(filter: $filter, first: 20) {
            edges {
              node {
                id
                name
                stage
                amount {
                  amountMicros
                  currencyCode
                }
                companyId
                pointOfContactId
              }
            }
          }
        }
      `,
      mapNode: (node) => ({
        id: node.id,
        name: node.name,
        stage: node.stage,
        amountMicros: (node.amount as { amountMicros: number } | null)?.amountMicros,
        currencyCode: (node.amount as { currencyCode: string } | null)?.currencyCode,
        companyId: node.companyId,
        pointOfContactId: node.pointOfContactId,
      }),
    },
    create: {
      mutation: /* GraphQL */ `
        mutation CreateOpportunity($data: OpportunityCreateInput!) {
          createOpportunity(data: $data) {
            id
          }
        }
      `,
      dataSchema: opportunityCreateSchema,
      toMutationData: (data: OpportunityCreateData) => ({
        name: data.name,
        companyId: data.companyId,
        pointOfContactId: data.pointOfContactId,
        amount: currencyInput(data.amountMicros, data.currencyCode),
        closeDate: data.closeDate,
        stage: data.stage,
      }),
      mapResult: (raw) => ({ id: (raw.createOpportunity as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
    update: {
      mutation: /* GraphQL */ `
        mutation UpdateOpportunity($id: ID!, $data: OpportunityUpdateInput!) {
          updateOpportunity(id: $id, data: $data) {
            id
          }
        }
      `,
      dataSchema: opportunityUpdateSchema,
      toMutationData: (data: OpportunityUpdateData) => ({
        name: data.name,
        companyId: data.companyId,
        pointOfContactId: data.pointOfContactId,
        amount: currencyInput(data.amountMicros, data.currencyCode),
        closeDate: data.closeDate,
        stage: data.stage,
      }),
      mapResult: (raw) => ({ id: (raw.updateOpportunity as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
  },
  note: {
    lookup: {
      query: /* GraphQL */ `
        query LookupNotes($filter: NoteFilterInput!) {
          notes(filter: $filter, first: 20) {
            edges {
              node {
                id
                title
                noteTargets {
                  edges {
                    node {
                      targetPersonId
                    }
                  }
                }
              }
            }
          }
        }
      `,
      mapNode: (node) => ({
        id: node.id,
        title: node.title,
        targetPersonIds: (
          (node.noteTargets as { edges: { node: { targetPersonId: string | null } }[] } | undefined)
            ?.edges ?? []
        )
          .map((edge) => edge.node.targetPersonId)
          .filter((id): id is string => id !== null),
      }),
    },
    create: {
      mutation: /* GraphQL */ `
        mutation CreateNote($data: NoteCreateInput!) {
          createNote(data: $data) {
            id
          }
        }
      `,
      dataSchema: noteCreateSchema,
      toMutationData: (data: NoteCreateData) => ({
        title: data.title,
        bodyV2: { markdown: data.markdown ?? null, blocknote: null },
      }),
      mapResult: (raw) => ({ id: (raw.createNote as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
    update: {
      mutation: /* GraphQL */ `
        mutation UpdateNote($id: ID!, $data: NoteUpdateInput!) {
          updateNote(id: $id, data: $data) {
            id
          }
        }
      `,
      dataSchema: noteUpdateSchema,
      toMutationData: (data: NoteUpdateData) => ({
        title: data.title,
        bodyV2: data.markdown !== undefined ? { markdown: data.markdown, blocknote: null } : undefined,
      }),
      mapResult: (raw) => ({ id: (raw.updateNote as { id: string }).id }),
    } as CrmWriteConfig<unknown>,
  },
  task: {
    lookup: {
      query: /* GraphQL */ `
        query LookupTasks($filter: TaskFilterInput!) {
          tasks(filter: $filter, first: 20) {
            edges {
              node {
                id
                title
                status
                dueAt
              }
            }
          }
        }
      `,
      mapNode: (node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        dueAt: node.dueAt,
      }),
    },
    // No create/update: task writes are Phase 6 (task assignment) scope.
  },
};
