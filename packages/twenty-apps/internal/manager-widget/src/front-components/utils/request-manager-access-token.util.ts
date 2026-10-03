// Side-effect type import only: pulls in twenty-sdk/front-component's
// `declare global { var frontComponentHostCommunicationApi }` ambient
// declaration so `globalThis.frontComponentHostCommunicationApi` below
// type-checks in this file regardless of what any other file imports.
import type {} from 'twenty-sdk/front-component';

// twenty-sdk/front-component only exports the *type* of
// requestAccessTokenRefresh from its public entry point — the function
// itself is a host-injected ambient global (`declare global { var
// frontComponentHostCommunicationApi }`), not a named export. No existing
// front component in this monorepo calls it (the postcard example uses a
// static app-level token instead), so this is the first real usage —
// accessed via `globalThis` rather than a bare identifier to stay correct
// regardless of whether this file's own imports happen to pull the ambient
// declaration into scope.
export async function requestManagerAccessToken(): Promise<string> {
  const refresh = globalThis.frontComponentHostCommunicationApi?.requestAccessTokenRefresh;

  if (!refresh) {
    throw new Error(
      'Twenty host did not provide requestAccessTokenRefresh — this widget cannot authenticate.',
    );
  }

  return refresh();
}
