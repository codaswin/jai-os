import { z } from 'zod';

import { type ToolDefinition } from '../types';

export type AddProofNoteToTestContactPayload = {
  title: string;
};

export type AddProofNoteToTestContactResult = {
  noteId: string;
  personId: string;
  alreadyExisted: boolean;
};

// Fixed, not caller-supplied: "one designated test contact" per ticket #25,
// not an arbitrary target an approval could be tricked into pointing
// elsewhere. Created on first use if it doesn't exist yet — no manual setup
// step, matching every other boot-time demo in this package.
const DESIGNATED_CONTACT_EMAIL = 'agent-proof-action-target@jai-os.internal';

const FIND_PERSON_QUERY = /* GraphQL */ `
  query FindDesignatedTestContact($email: String!) {
    people(filter: { emails: { primaryEmail: { eq: $email } } }, first: 1) {
      edges {
        node {
          id
        }
      }
    }
  }
`;

const CREATE_PERSON_MUTATION = /* GraphQL */ `
  mutation CreateDesignatedTestContact($data: PersonCreateInput!) {
    createPerson(data: $data) {
      id
    }
  }
`;

const FIND_NOTE_QUERY = /* GraphQL */ `
  query FindNoteByTitle($title: String!) {
    notes(filter: { title: { eq: $title } }, first: 10) {
      edges {
        node {
          id
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
`;

const CREATE_NOTE_MUTATION = /* GraphQL */ `
  mutation CreateProofNote($data: NoteCreateInput!) {
    createNote(data: $data) {
      id
    }
  }
`;

const CREATE_NOTE_TARGET_MUTATION = /* GraphQL */ `
  mutation CreateProofNoteTarget($data: NoteTargetCreateInput!) {
    createNoteTarget(data: $data) {
      id
    }
  }
`;

type PeopleQueryResult = { people: { edges: { node: { id: string } }[] } };
type NotesQueryResult = {
  notes: {
    edges: {
      node: { id: string; noteTargets: { edges: { node: { targetPersonId: string | null } }[] } };
    }[];
  };
};
type CreatePersonResult = { createPerson: { id: string } };
type CreateNoteResult = { createNote: { id: string } };

export const addProofNoteToTestContactTool: ToolDefinition<
  AddProofNoteToTestContactPayload,
  AddProofNoteToTestContactResult
> = {
  name: 'add-proof-note-to-test-contact',
  requiredScope: 'note:write',
  // Hardcoded here, not left to a caller's payload — ticket #25's explicit
  // acceptance criterion. Enforced structurally, not just by convention: see
  // ControlledToolApiService.callToolImpl, which rejects a direct call to
  // any tool registered with requiresApproval: true.
  requiresApproval: true,
  payloadSchema: z.object({ title: z.string().min(1) }),
  execute: async (payload, twenty) => {
    const personId = await findOrCreateDesignatedContact(twenty);

    // The real idempotency guard for this write specifically (ticket #25's
    // "calling the same action ID twice produces the effect once"):
    // ApprovalRepository.checkAndConsume already stops a second execution
    // from being *authorized*, but this check makes the write itself safe
    // even if something upstream ever called execute() twice regardless —
    // a title collision means "already done," not "do it again." Matched on
    // title AND a noteTarget pointing at this exact contact, not title alone
    // — Note titles aren't unique workspace-wide, so an unrelated same-titled
    // note would otherwise be mistaken for "already done" and silently skip
    // ever creating the real note/NoteTarget for the designated contact.
    const existing = await twenty.request<NotesQueryResult>(FIND_NOTE_QUERY, {
      title: payload.title,
    });
    const existingNote = existing.notes.edges.find((edge) =>
      edge.node.noteTargets.edges.some((target) => target.node.targetPersonId === personId),
    )?.node;

    if (existingNote) {
      return { noteId: existingNote.id, personId, alreadyExisted: true };
    }

    const created = await twenty.request<CreateNoteResult>(CREATE_NOTE_MUTATION, {
      data: {
        title: payload.title,
        bodyV2: { markdown: 'Synthetic proof action (ticket #25) — harmless.', blocknote: null },
      },
    });

    await twenty.request(CREATE_NOTE_TARGET_MUTATION, {
      data: { noteId: created.createNote.id, targetPersonId: personId },
    });

    return { noteId: created.createNote.id, personId, alreadyExisted: false };
  },
};

async function findOrCreateDesignatedContact(
  twenty: Parameters<typeof addProofNoteToTestContactTool.execute>[1],
): Promise<string> {
  const found = await twenty.request<PeopleQueryResult>(FIND_PERSON_QUERY, {
    email: DESIGNATED_CONTACT_EMAIL,
  });
  const existingPerson = found.people.edges[0]?.node;

  if (existingPerson) {
    return existingPerson.id;
  }

  const created = await twenty.request<CreatePersonResult>(CREATE_PERSON_MUTATION, {
    data: {
      name: { firstName: 'Agent', lastName: 'Proof Action Target' },
      emails: { primaryEmail: DESIGNATED_CONTACT_EMAIL, additionalEmails: [] },
    },
  });

  return created.createPerson.id;
}
