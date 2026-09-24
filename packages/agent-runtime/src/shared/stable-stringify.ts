// Same value, different key insertion order, must produce the same string —
// plain JSON.stringify doesn't guarantee that, which breaks anything using
// the result as a cache/dedup key.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }

    return sorted;
  }

  return value;
}
