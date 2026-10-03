import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { throwOnFailedResponse } from '../shared/throw-on-failed-response';

export type TwentyCurrentUser = {
  id: string;
  canAccessFullAdminPanel: boolean;
};

const CURRENT_USER_QUERY = /* GraphQL */ `
  query CurrentUserForWidgetAuth {
    currentUser {
      id
      canAccessFullAdminPanel
    }
  }
`;

// Verifies a forwarded Twenty Application Access Token by using it exactly
// the way any other bearer token is used against Twenty's own GraphQL API —
// not a separate "introspect this token" endpoint. Twenty's JwtAuthStrategy
// already accepts an Application Access Token the same way it accepts a
// regular session token or API key, so a currentUser query either succeeds
// (token valid, identity established) or fails (invalid/expired/revoked)
// exactly the way an unauthenticated request would.
//
// currentUser is served only on Twenty's metadata GraphQL schema
// (UserResolver is @MetadataResolver-scoped), not the core /graphql schema
// agent-runtime's CRM tools use — confirmed live, querying it against
// TWENTY_API_URL returns "Cannot query field \"currentUser\"".
@Injectable()
export class TwentyCurrentUserService {
  constructor(private readonly configService: ConfigService) {}

  // Returns null for an invalid/expired/revoked token — the caller's job to
  // turn that into a 401, not this service's. Only throws for a genuine
  // transport/server failure talking to Twenty itself, which the caller
  // should surface as a 500, never silently let the request through.
  async verifyToken(token: string): Promise<TwentyCurrentUser | null> {
    const apiUrl = this.configService.getOrThrow<string>('TWENTY_METADATA_API_URL');

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: CURRENT_USER_QUERY }),
    });

    if (response.status === 401 || response.status === 403) {
      // Drain the body even though we don't need it — an unread response
      // body can keep undici from returning the socket to the keep-alive
      // pool, and this branch is the common case under normal traffic.
      await response.text().catch(() => undefined);

      return null;
    }

    await throwOnFailedResponse(response, 'Twenty current-user check');

    const body = (await response.json()) as {
      data?: { currentUser: TwentyCurrentUser | null };
      errors?: { message: string }[];
    };

    if (body.errors?.length || !body.data?.currentUser) {
      // Some auth failures surface as a 200 with a GraphQL-level error
      // rather than an HTTP 401 — still "invalid token", not a server fault.
      return null;
    }

    return body.data.currentUser;
  }
}
