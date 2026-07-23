const REDACTED = '<redacted>';
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|api[_-]?key|prompt|command|argv|stdin|body)/i;
const ASSIGNMENT = /\b(authorization|cookie|token|secret|password|passwd|api[_-]?key)\s*([=:])\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER = /\bbearer\s+[^\s,;]+/gi;

export interface RedactionLimits {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxStringLength?: number;
}

export function redact(value: unknown, limits: RedactionLimits = {}): unknown {
  const maxDepth = limits.maxDepth ?? 6;
  const maxEntries = limits.maxEntries ?? 100;
  const maxStringLength = limits.maxStringLength ?? 2048;
  let entries = 0;

  const visit = (input: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
    if (depth > maxDepth) return '<truncated:depth>';
    if (typeof input === 'string') {
      const bounded = input.length > maxStringLength ? `${input.slice(0, maxStringLength)}<truncated>` : input;
      return bounded.replace(BEARER, 'Bearer <redacted>').replace(ASSIGNMENT, '$1$2<redacted>');
    }
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) {
      return input.slice(0, maxEntries).map((item) => visit(item, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(input)) {
      entries += 1;
      if (entries > maxEntries) {
        output.__truncated__ = '<truncated:entries>';
        break;
      }
      output[childKey] = visit(childValue, depth + 1, childKey);
    }
    return output;
  };
  return visit(value, 0);
}

export function redactText(value: string, maxLength = 4096): string {
  return String(redact(value, { maxStringLength: maxLength }));
}
