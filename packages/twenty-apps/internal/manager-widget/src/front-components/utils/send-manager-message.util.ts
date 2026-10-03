const WIDGET_MESSAGE_ENDPOINT = '/agent-api/widget/message';

// Same-origin through Caddy's own reverse-proxy route (see ops/Caddyfile) —
// no CORS configuration needed, and no base URL to hardcode or configure per
// environment.
export async function sendManagerMessage(accessToken: string, text: string): Promise<string> {
  const response = await fetch(WIDGET_MESSAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Your session could not be verified. Try refreshing the page.');
    }

    if (response.status === 403) {
      throw new Error('Only an Admin can talk to the Manager agent.');
    }

    const body = await response.text().catch(() => '');

    throw new Error(`Manager agent request failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  const data = (await response.json()) as { reply?: unknown };

  if (typeof data.reply !== 'string') {
    throw new Error('Manager agent returned an unexpected response.');
  }

  return data.reply;
}
