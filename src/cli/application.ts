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

export const HELP = `oh-my-cursor (omcu)\n\nUsage:\n  omcu setup|update|doctor|uninstall                 lifecycle (local install)\n  omcu capabilities discover|native-status          pinned host probes\n  omcu state create|status|transition|verify|event   CLI-authoritative state\n  omcu cancel --id <run-id>                          CLI-authoritative cancellation\n  omcu session create|list|resume|continue           Cursor-native sessions\n  omcu resume --id <chat-id> [--prompt <text>]       session resume alias\n  omcu recover [show] ...                            bounded immutable recovery\n  omcu compact checkpoint|show|render ...            local checkpoint chain\n  omcu memory put|list|show|search|export|import      redacted project memory\n  omcu notify status|configure|enqueue|show|dispatch disabled transport by default\n  omcu tracker record|history ...                    local lifecycle journal\n  omcu wiki render|show ...                          lifecycle-derived local wiki\n  omcu mcp-server                                    stdio MCP (non-authoritative)\n  omcu mcp-install [--file <path>]                   project MCP config install\n  omcu workflow install|list|show|plan|run|status|replay\n  omcu ralplan|ralph|ulw ...                         Cursor-backed orchestration\n  omcu autopilot|pipeline ...                        experimental advisory pipeline\n  omcu persist start|status|done|stop ...            opt-in boulder-never-stops loop (hooks)\n  omcu team start|run|status|collect|stop ...        experimental local tmux; not native\n  omcu review|qa|accept|integrate|ask ...             Cursor-backed role prompts\n\nTruth markers:\n  Workflow, mode, team, and MCP outputs never self-assert verified state.\n  Team is experimental local tmux orchestration, not a native Cursor team.\n  Notification dispatch is unsupported until an explicit transport is configured in code.\n`;

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
  const parsed = parseCli(argv);
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const packageRoot = path.resolve(dependencies.packageRoot ?? packageRootFromModule());
  const adapter = dependencies.adapter ?? new CursorAgentAdapter();
  const context = { cwd, packageRoot, adapter, root: projectStateRoot(cwd), io, homeDir: path.resolve(dependencies.homeDir ?? os.homedir()) };
  try {
    if (parsed.command === 'help') { io.stdout(HELP); return 0; }
    if (parsed.command === 'version') { io.stdout(`${dependencies.version ?? '0.2.1'}\n`); return 0; }
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
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
