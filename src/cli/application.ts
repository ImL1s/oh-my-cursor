import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCursorCapabilities, validateCapabilityLock } from '../capabilities/discovery.js';
import type { CapabilityLock } from '../capabilities/types.js';
import { CursorAgentAdapter } from '../host/cursor-agent.js';
import { redactText } from '../runtime/redaction.js';
import { openProjectStateRoot, openWritableProjectStateRoot, projectStateRoot } from '../runtime/state-root.js';
import { handleLifecycle } from './lifecycle.js';
import { handleLocalServices } from './local-services.js';
import { handleOrchestration } from './orchestration.js';
import { HostLaunchUsageError, runHostLaunch, shouldHostLaunch } from './host-launch.js';
import { COMMAND_SCHEMAS, parseCli, renderCommandHelp, type ParsedCommand } from './parser.js';
import { printJson, type CliContext, type CliIo } from './shared.js';

export type { CliIo } from './shared.js';
export interface CliDependencies {
  readonly adapter?: CursorAgentAdapter;
  readonly cwd?: string;
  readonly version?: string;
  readonly capabilityLock?: CapabilityLock;
  readonly packageRoot?: string;
  readonly homeDir?: string;
}

export const HELP = `oh-my-cursor (omcu)

Global diagnostics:
  omcu --json-errors <command> ...                  structured error envelope on stderr

Host launch (OMX-aligned):
  omcu                         interactive cursor-agent (+ --plugin-dir)
  omcu "prompt"                interactive with initial prompt
  omcu prompt <text>           explicit host prompt route
  omcu --prompt <text>         explicit host prompt route
  omcu --madmax [args…]        break-glass: --yolo --sandbox disabled
                               (explicit deny rules remain; --approve-mcps/--trust opt-in)
  omcu --direct|--tmux …       launch policy (auto falls back; --tmux fails closed)

Lifecycle / orchestration:
  omcu install status|list|verify|prune|repair      lifecycle inspection, repair & garbage collection
  omcu setup|update [--init-project-state]           lifecycle (project state is opt-in)
  omcu rollback --receipt <id|path> [--dry-run]      transactional operator rollback
  omcu doctor [--repair-owner|--repair-journals]|uninstall  observational doctor; explicit owner/journal repair
  omcu plugin status|doctor [--live]                native Cursor plugin status & live provenance doctor
  omcu components list [--resolved]                 catalog component resolution inventory
  omcu aliases explain <name>                       compatibility alias lookup and collision scan
  omcu capabilities discover|native-status|cursor-components pinned host & native component probes
  omcu state create|status|transition|verify|event   CLI-authoritative state
  omcu cancel --id <run-id>                          CLI-authoritative cancellation
  omcu session create|list|resume|continue           Cursor-native sessions
  omcu resume --id <chat-id> [--prompt <text>]       session resume alias
  omcu recover [show] ...                            bounded immutable recovery
  omcu compact checkpoint|show|render ...            local checkpoint chain
  omcu memory put|list|show|search|export|import      redacted project memory
  omcu notify status|configure|enqueue|show|dispatch disabled transport by default
  omcu tracker record|history ...                    local lifecycle journal
  omcu wiki render|show ...                          lifecycle-derived local wiki
  omcu mcp status|install|uninstall [--file <path>]  safe project MCP lifecycle
  omcu mcp-server                                    stdio MCP (non-authoritative)
  omcu mcp-install [--file <path>]                   project MCP config install
  omcu workflow install|list|show|plan|run|status|replay|lease-status|lease-reconcile
  omcu ralplan|ralph|ulw ...                         Cursor-backed orchestration
  omcu autopilot|pipeline ...                        experimental advisory pipeline
  omcu persist start|status|done|stop ...            opt-in boulder-never-stops loop (hooks)
  omcu team start|run|status|collect|stop ...        experimental local tmux; not native
  omcu team api <op> --input '<json>'                OMX-shaped mailbox/tasks (P0)
  omcu review|qa|accept|integrate|ask ...             Cursor-backed role prompts

Truth markers:
  Host launch / --madmax is not a mode FSM and never stamps verified.
  Workflow, mode, team, and MCP outputs never self-assert verified state.
  Team is experimental local tmux orchestration, not a native Cursor team.
  Team api never stamps verified; native_cursor_team remains false.
  Notification dispatch is unsupported until an explicit transport is configured in code.

${renderCommandHelp([])}`;

interface CliErrorEnvelope {
  readonly code: string;
  readonly command_path: string;
  readonly token: string | null;
  readonly message: string;
  readonly usage: string;
}

function errorCode(message: string): string {
  return /^E_[A-Z0-9_]+/.exec(message)?.[0] ?? 'E_CLI_FAILED';
}

function terminalSafe(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function commandTarget(argv: readonly string[]): readonly string[] {
  const command = argv[0];
  if (command === undefined || !Object.hasOwn(COMMAND_SCHEMAS, command)) return [];
  const action = argv[1];
  return action !== undefined && !action.startsWith('-') && Object.hasOwn(COMMAND_SCHEMAS[command]!.actions ?? {}, action)
    ? [command, action]
    : [command];
}

function diagnosticToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : '<redacted>';
}

function errorToken(message: string, argv: readonly string[]): string | null {
  const optionToken = /(?:^|\s)(--?[A-Za-z0-9][A-Za-z0-9-]*)/.exec(message)?.[1];
  if (optionToken !== undefined) return optionToken;
  if (message.startsWith('E_ACTION_')) return diagnosticToken(argv[1]);
  if (message.startsWith('E_CLI_INVALID')) return diagnosticToken(argv[0]);
  return null;
}

function structuredError(message: string, argv: readonly string[]): CliErrorEnvelope {
  const target = commandTarget(argv);
  let usage = 'Usage: omcu <command> [options]';
  try { usage = target.length === 0 ? 'Usage: omcu <command> [options]' : renderCommandHelp(target).trim(); }
  catch { /* retain root usage for malformed paths */ }
  return {
    code: errorCode(message),
    command_path: target.length === 0 ? (diagnosticToken(argv[0]) ?? '') : target.join(' '),
    token: errorToken(message, argv),
    message,
    usage,
  };
}

function packageRootFromModule(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (cursor !== path.dirname(cursor)) {
    const manifest = path.join(cursor, 'package.json');
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
      if (parsed.name === '@iml1s/oh-my-cursor') return cursor;
    }
    cursor = path.dirname(cursor);
  }
  throw new Error('E_PACKAGE_ROOT_NOT_FOUND');
}
function defaultLock(packageRoot: string): CapabilityLock {
  const file = path.join(packageRoot, 'omcu_capabilities.lock.json');
  if (!fs.existsSync(file)) throw new Error('E_CAPABILITY_LOCK_NOT_FOUND');
  return validateCapabilityLock(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}, io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  const jsonErrors = argv[0] === '--json-errors';
  const effectiveArgv = jsonErrors ? argv.slice(1) : argv;
  let parsed: ParsedCommand | undefined;
  try {
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());

    // Help/version stay explicit and never touch project state (#8).
    if (effectiveArgv.length === 1 && ['help', '--help', '-h'].includes(effectiveArgv[0] ?? '')) {
      io.stdout(HELP);
      return 0;
    }
    if (effectiveArgv.length === 1 && ['version', '--version', '-v'].includes(effectiveArgv[0] ?? '')) {
      io.stdout(`${dependencies.version ?? '0.3.0'}\n`);
      return 0;
    }
    // Host launch does not use project `.omcu` (#8).
    if (shouldHostLaunch(effectiveArgv)) {
      const packageRoot = path.resolve(dependencies.packageRoot ?? packageRootFromModule());
      return await runHostLaunch(effectiveArgv, { cwd, packageRoot, stderr: (text) => io.stderr(text) });
    }

    // Parse/validate grammar before any project-state mutation (#8 + #12).
    parsed = parseCli(effectiveArgv);
    const parsedCommand = parsed;
    if (parsedCommand.command === 'help') {
      io.stdout(parsedCommand.args.length === 0 ? HELP : renderCommandHelp(parsedCommand.args));
      return 0;
    }
    if (parsedCommand.command === 'version') { io.stdout(`${dependencies.version ?? '0.3.0'}\n`); return 0; }

    const packageRoot = path.resolve(dependencies.packageRoot ?? packageRootFromModule());
    const adapter = dependencies.adapter ?? new CursorAgentAdapter();
    const homeDir = path.resolve(dependencies.homeDir ?? os.homedir());
    let rootMemo: ReturnType<typeof projectStateRoot> | undefined;
    const context: CliContext = {
      parsed: parsedCommand,
      cwd,
      packageRoot,
      adapter,
      io,
      homeDir,
      get root() {
        if (parsedCommand.stateAccess === 'none') throw new Error(`E_STATE_ACCESS_FORBIDDEN: ${parsedCommand.command}${parsedCommand.action === null ? '' : ` ${parsedCommand.action}`}`);
        if (rootMemo === undefined) {
          if (parsedCommand.stateAccess === 'write-ensure') {
            rootMemo = projectStateRoot(cwd);
          } else if (parsedCommand.stateAccess === 'write-existing') {
            rootMemo = openWritableProjectStateRoot(cwd);
          } else {
            rootMemo = openProjectStateRoot(cwd);
          }
        }
        return rootMemo;
      },
    };

    if (parsedCommand.command === 'capabilities' && parsedCommand.action === 'discover') {
      const result = await discoverCursorCapabilities(adapter, dependencies.capabilityLock ?? defaultLock(packageRoot), cwd);
      printJson(io, result); return result.verified ? 0 : 1;
    }

    const handlers = [handleLifecycle, handleLocalServices, handleOrchestration] as const;
    for (const handler of handlers) {
      const code = await handler(context);
      if (code !== null) return code;
    }
    io.stderr(`E_CLI_INVALID: no handler for ${parsedCommand.command}${parsedCommand.action === null ? '' : ` ${parsedCommand.action}`}\n`); return 2;
  } catch (error) {
    const originalMessage = terminalSafe(redactText(error instanceof Error ? error.message : String(error), 4096));
    const message = error instanceof SyntaxError && parsed?.stateAccess === 'read-existing'
      ? 'E_STATE_CORRUPT'
      : originalMessage;
    if (error instanceof HostLaunchUsageError) {
      io.stderr(jsonErrors ? `${JSON.stringify(structuredError(message, effectiveArgv))}\n` : `${message}\n`);
      return error.exitCode;
    }
    if (jsonErrors) {
      io.stderr(`${JSON.stringify(structuredError(message, effectiveArgv))}\n`);
      return 1;
    }
    io.stderr(`${message}\n`);
    if (/^E_(CLI|ACTION|OPTION|POSITIONAL|INTEGER|JSON|HELP)_/.test(message)) {
      io.stderr('Hint: omcu --help\n');
    }
    return 1;
  }
}
