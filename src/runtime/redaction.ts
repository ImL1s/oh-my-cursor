import crypto from 'node:crypto';

const REDACTED = '<redacted>';
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|api[_-]?key|prompt|command|argv|stdin|body)/i;
const ASSIGNMENT = /\b(authorization|cookie|token|secret|password|passwd|api[_-]?key)\s*([=:])\s*(?:bearer\s+)?[^\s,;]+/gi;
const BEARER = /\bbearer\s+[^\s,;]+/gi;
const TOKEN_PREFIX = /\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}\b/gi;

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
      return bounded
        .replace(BEARER, 'Bearer <redacted>')
        .replace(ASSIGNMENT, '$1$2<redacted>')
        .replace(TOKEN_PREFIX, '<redacted>');
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

export function escapeControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    switch (char) {
      case '\t': return '\\t';
      case '\r': return '\\r';
      case '\n': return '\\n';
      default: return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  });
}

const SENSITIVE_OPTION = /^--(?:token|api[_-]?key|secret|password|passwd|auth)$/i;
const SENSITIVE_KEY_VALUE = /^(--(?:token|api[_-]?key|secret|password|passwd|auth)=)(.+)$/i;

export function redactArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (i > 0 && SENSITIVE_OPTION.test(argv[i - 1]!)) {
      result.push('<redacted>');
      continue;
    }
    const match = SENSITIVE_KEY_VALUE.exec(arg);
    if (match) {
      result.push(`${match[1]}<redacted>`);
      continue;
    }
    if (arg.length > 80 || (i === argv.length - 1 && !arg.startsWith('-') && arg.length > 30)) {
      const bytes = Buffer.byteLength(arg, 'utf8');
      const hash = crypto.createHash('sha256').update(arg).digest('hex').slice(0, 16);
      const preview = redactText(arg.slice(0, 32)).replace(/[\r\n\t]+/g, ' ');
      result.push(`<prompt: ${bytes}B sha256:${hash} "${escapeControlCharacters(preview)}...">`);
      continue;
    }
    result.push(escapeControlCharacters(redactText(arg)));
  }
  return result;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatRedactedCommandLine(executable: string, argv: readonly string[]): string {
  const quotedExecutable = shellQuote(escapeControlCharacters(executable));
  const redactedArgs = redactArgv(argv);
  return `${quotedExecutable} ${redactedArgs.map(shellQuote).join(' ')}`;
}


