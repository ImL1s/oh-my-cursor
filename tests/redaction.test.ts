import { describe, expect, it } from 'vitest';
import { redact, redactText } from '../src/runtime/redaction.js';

describe('bounded redaction', () => {
  it('redacts sensitive keys and inline credentials', () => {
    expect(redact({ apiKey: 'secret', nested: { value: 'Bearer abc123' } })).toEqual({ apiKey: '<redacted>', nested: { value: 'Bearer <redacted>' } });
    expect(redactText('token=abc hello')).toBe('token=<redacted> hello');
  });
  it('bounds depth, entries, and strings', () => {
    expect(redact({ a: { b: { c: 'x' } } }, { maxDepth: 1 })).toEqual({ a: { b: '<truncated:depth>' } });
    expect(redact('abcdef', { maxStringLength: 3 })).toBe('abc<truncated>');
  });
});
