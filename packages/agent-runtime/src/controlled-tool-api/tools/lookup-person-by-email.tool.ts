import { z } from 'zod';

import { type ToolDefinition } from '../types';

export type LookupPersonByEmailPayload = {
  email: string;
};

export type LookupPersonByEmailResult = {
  id: string;
  firstName: string;
  lastName: string;
  primaryEmail: string;
} | null;

const QUERY = /* GraphQL */ `
  query LookupPersonByEmail($email: String!) {
    people(filter: { emails: { primaryEmail: { eq: $email } } }, first: 1) {
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
        }
      }
    }
  }
`;

type LookupPersonByEmailQueryResult = {
  people: {
    edges: {
      node: {
        id: string;
        name: { firstName: string; lastName: string };
        emails: { primaryEmail: string };
      };
    }[];
  };
};

export const lookupPersonByEmailTool: ToolDefinition<
  LookupPersonByEmailPayload,
  LookupPersonByEmailResult
> = {
  name: 'lookup-person-by-email',
  requiredScope: 'person:read',
  payloadSchema: z.object({ email: z.string().email() }),
  execute: async (payload, twenty) => {
    const result = await twenty.request<LookupPersonByEmailQueryResult>(
      QUERY,
      { email: payload.email },
    );

    const node = result.people.edges[0]?.node;

    if (!node) {
      return null;
    }

    return {
      id: node.id,
      firstName: node.name.firstName,
      lastName: node.name.lastName,
      primaryEmail: node.emails.primaryEmail,
    };
  },
};
