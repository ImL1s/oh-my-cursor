import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCursorCapabilities, validateCapabilityLock } from '../capabilities/discovery.js';
import type { CapabilityLock } from '../capabilities/types.js';
import { CursorAgentAdapter } from '../host/cursor-agent.js';
import { projectStateRoot } from '../runtime/state-root.js';
import { handleLifecycle } from './lifecycle.js';
import { handleLocalServices } from './local-services.js';
import { handleOrchestration } from './orchestration.js';
import { HostLaunchUsageError, runHostLaunch, shouldHostLaunch } from './host-launch.js';
import { parseCli } from './parser.js';
import { printJson, type CliIo } from './shared.js';

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

Host launch (OMX-aligned):
  omcu                         interactive cursor-agent (+ --plugin-dir)
  omcu "prompt"                interactive with initial prompt
  omcu --madmax [args…]        break-glass: --yolo --sandbox disabled
                               (explicit deny rules remain; --approve-mcps/--trust opt-in)
  omcu --direct|--tmux …       launch policy (auto falls back; --tmux fails closed)

Lifecycle / orchestration:
  omcu setup|update|doctor|uninstall                 lifecycle (local install)
  omcu capabilities discover|native-status          pinned host probes
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
  omcu mcp-server                                    stdio MCP (non-authoritative)
  omcu mcp-install [--file <path>]                   project MCP config install
  omcu workflow install|list|show|plan|run|status|replay
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
`;

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
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const packageRoot = path.resolve(dependencies.packageRoot ?? packageRootFromModule());
  const adapter = dependencies.adapter ?? new CursorAgentAdapter();
  const context = { cwd, packageRoot, adapter, root: projectStateRoot(cwd), io, homeDir: path.resolve(dependencies.homeDir ?? os.homedir()) };
  try {
    // Help/version stay explicit; bare argv and --madmax are host launches.
    if (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0] ?? '')) {
      io.stdout(HELP);
      return 0;
    }
    if (argv.length === 1 && ['version', '--version', '-v'].includes(argv[0] ?? '')) {
      io.stdout(`${dependencies.version ?? '0.3.0'}\n`);
      return 0;
    }
    if (shouldHostLaunch(argv)) {
      return await runHostLaunch(argv, { cwd, packageRoot, stderr: (text) => io.stderr(text) });
    }
    const parsed = parseCli(argv);
    if (parsed.command === 'help') { io.stdout(HELP); return 0; }
    if (parsed.command === 'version') { io.stdout(`${dependencies.version ?? '0.3.0'}\n`); return 0; }
    if (parsed.command === 'capabilities' && parsed.action === 'discover') {
      const result = await discoverCursorCapabilities(adapter, dependencies.capabilityLock ?? defaultLock(packageRoot), cwd);
      printJson(io, result); return result.verified ? 0 : 1;
    }
    const handlers = [handleLifecycle, handleLocalServices, handleOrchestration] as const;
    for (const handler of handlers) {
      const code = await handler(parsed.command, parsed.action, parsed.args, context);
      if (code !== null) return code;
    }
    io.stderr(`E_CLI_INVALID: unknown command: ${argv.join(' ')}\n`); return 2;
  } catch (error) {
    if (error instanceof HostLaunchUsageError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
