import { stableStringify } from './stable-stringify';

describe('stableStringify', () => {
  it('produces the same string regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toEqual(stableStringify({ b: 2, a: 1 }));
  });

  it('produces a different string for a genuinely different value', () => {
    expect(stableStringify({ a: 1, b: 2 })).not.toEqual(stableStringify({ a: 1, b: 3 }));
  });

  it('sorts keys inside nested objects and arrays', () => {
    expect(stableStringify({ outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] })).toEqual(
      stableStringify({ outer: { a: 2, z: 1 }, list: [{ x: 2, y: 1 }] }),
    );
  });
});
