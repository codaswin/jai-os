export async function throwOnFailedResponse(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => '');

  throw new Error(
    `${label} failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`,
  );
}
