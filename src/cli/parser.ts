export interface ParsedCommand {
  readonly command: string;
  readonly action: string | null;
  readonly args: readonly string[];
}

export function parseCli(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0] ?? '')) return { command: 'help', action: null, args: [] };
  if (argv.length === 1 && ['version', '--version', '-v'].includes(argv[0] ?? '')) return { command: 'version', action: null, args: [] };
  const [command = '', possibleAction, ...rest] = argv;
  const actionCommands = new Set(['capabilities', 'session', 'state', 'run', 'lease', 'recover', 'compact', 'memory', 'notify', 'tracker', 'wiki', 'workflow', 'team', 'persist']);
  if (!actionCommands.has(command)) return { command, action: null, args: argv.slice(1) };
  if (possibleAction === undefined || possibleAction.startsWith('-')) return { command, action: null, args: argv.slice(1) };
  return { command, action: possibleAction, args: rest };
}

export function hasFlag(args: readonly string[], name: string): boolean { return args.includes(name); }

export function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

export function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  return value;
}

export function integerOption(args: readonly string[], name: string, fallback?: number): number {
  const raw = option(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`E_INTEGER_INVALID: ${name}`);
  return value;
}

export function jsonOption(args: readonly string[], name: string, fallback?: unknown): unknown {
  const raw = option(args, name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`E_OPTION_REQUIRED: ${name}`);
  }
  try { return JSON.parse(raw) as unknown; } catch { throw new Error(`E_JSON_INVALID: ${name}`); }
}
