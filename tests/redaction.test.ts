import { describe, expect, it } from 'vitest';
import {
  escapeControlCharacters,
  formatRedactedCommandLine,
  redact,
  redactArgv,
  redactText,
} from '../src/runtime/redaction.js';

describe('bounded redaction', () => {
  it('redacts sensitive keys and inline credentials', () => {
    expect(redact({ apiKey: 'secret', nested: { value: 'Bearer abc123' } })).toEqual({ apiKey: '<redacted>', nested: { value: 'Bearer <redacted>' } });
    expect(redactText('token=abc hello')).toBe('token=<redacted> hello');
  });
  it('bounds depth, entries, and strings', () => {
    expect(redact({ a: { b: { c: 'x' } } }, { maxDepth: 1 })).toEqual({ a: { b: '<truncated:depth>' } });
    expect(redact('abcdef', { maxStringLength: 3 })).toBe('abc<truncated>');
  });

  it('escapes terminal control characters safely', () => {
    expect(escapeControlCharacters('hello\x1b[31mworld\x07\x00')).toBe('hello\\x1b[31mworld\\x07\\x00');
    expect(escapeControlCharacters('clean normal text')).toBe('clean normal text');
  });

  it('redacts argv containing tokens and long prompts', () => {
    const argv = ['--output-format', 'json', '--token', 'ghp_secret12345678', '--api-key=sk-12345678901234', 'a'.repeat(100)];
    const redacted = redactArgv(argv);
    expect(redacted[0]).toBe('--output-format');
    expect(redacted[1]).toBe('json');
    expect(redacted[2]).toBe('--token');
    expect(redacted[3]).toBe('<redacted>');
    expect(redacted[4]).toBe('--api-key=<redacted>');
    expect(redacted[5]).toMatch(/<prompt: 100B sha256:[a-f0-9]+ "a+...">/);
  });

  it('formats command line with robust shell-quoting and control character escaping', () => {
    const formatted = formatRedactedCommandLine('cursor agent', ['--token', 'secret', "don't fix", 'a;rm -rf /']);
    expect(formatted).toBe("'cursor agent' --token '<redacted>' 'don'\\''t fix' 'a;rm -rf /'");
  });
});

