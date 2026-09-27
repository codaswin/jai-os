// pg only auto-serializes a plain object/array parameter into a jsonb column;
// a bare top-level string (unlike a number or boolean, which happen to be
// valid JSON text on their own) is sent as raw unquoted text and fails
// jsonb's implicit cast. Stringifying explicitly is correct for every shape,
// not just the ones that happened to work by coincidence. `undefined` stays
// `undefined` (binds as SQL NULL) rather than becoming the string "undefined".
export const toJsonParam = (value: unknown): string | undefined =>
  value === undefined ? undefined : JSON.stringify(value);
