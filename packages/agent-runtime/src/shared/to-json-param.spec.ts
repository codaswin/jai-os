import { toJsonParam } from './to-json-param';

describe('toJsonParam', () => {
  it('stringifies an object', () => {
    expect(toJsonParam({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('stringifies a bare string, quoting it as valid JSON', () => {
    expect(toJsonParam('hello')).toBe('"hello"');
  });

  it('stringifies a bare number and boolean', () => {
    expect(toJsonParam(42)).toBe('42');
    expect(toJsonParam(true)).toBe('true');
  });

  it('passes undefined through as undefined, not the string "undefined"', () => {
    expect(toJsonParam(undefined)).toBeUndefined();
  });

  it('stringifies null as the JSON null literal', () => {
    expect(toJsonParam(null)).toBe('null');
  });
});
