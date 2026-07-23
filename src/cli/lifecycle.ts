import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { installOrUpdate, runSetupDoctor, uninstall, type InstallResult } from '../setup/index.js';
import { option } from './parser.js';
import { externalStateRoot, printJson, type CliContext } from './shared.js';

export async function handleLifecycle(command: string, action: string | null, args: readonly string[], context: CliContext): Promise<number | null> {
  const stateRoot = option(args, '--state-root') ?? externalStateRoot(context.homeDir);
  if (command === 'setup' || command === 'update') {
    const result = await installOrUpdate({
      sourceRoot: option(args, '--source') ?? context.packageRoot,
      action: command === 'update' ? 'update' : 'install',
      homeDir: context.homeDir,
      stateRoot,
      projectRoot: context.cwd,
    });
    printJson(context.io, result);
    return installExitCode(result);
  }
  if (command === 'doctor') {
    const report = await runSetupDoctor({ packageRoot: context.packageRoot, projectRoot: context.cwd, homeDir: context.homeDir });
    printJson(context.io, report);
    return report.exit_code;
  }
  if (command === 'uninstall') {
    const receiptPath = option(args, '--receipt') ?? (JSON.parse(fs.readFileSync(path.join(stateRoot, 'install', 'current.json'), 'utf8')) as { receipt_path: string }).receipt_path;
    const result = uninstall({ receiptPath, homeDir: context.homeDir, stateRoot, purgeProjectState: args.includes('--purge-project-state') });
    printJson(context.io, result);
    return uninstallExitCode(result.status);
  }
  if (command === 'mcp-install') {
    const target = path.resolve(option(args, '--file') ?? path.join(context.cwd, '.cursor', 'mcp.json'));
    const parsed: unknown = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
    if (!isPlainObject(parsed)) throw new Error('E_MCP_CONFIG_INVALID');
    const servers = parsed.mcpServers;
    if (servers !== undefined && !isPlainObject(servers)) throw new Error('E_MCP_SERVERS_INVALID');
    const executable = path.join(context.packageRoot, 'dist', 'bin', 'omcu.js');
    const next = { ...parsed, mcpServers: { ...(servers ?? {}), 'oh-my-cursor': { command: process.execPath, args: [executable, 'mcp-server'], cwd: context.cwd } } };
    atomicWriteJson(target, next);
    printJson(context.io, { installed: true, file: target, server: 'oh-my-cursor' });
    return 0;
  }
  if (command === 'native-status' || (command === 'capabilities' && action === 'native-status')) {
    const result = await context.adapter.run({ argv: ['status'], cwd: context.cwd, interactive: false });
    printJson(context.io, { available: result.code === 0, exit_code: result.code, stdout: result.stdout, stderr: result.stderr });
    return result.code;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function uninstallExitCode(status: string): number {
  return status === 'completed_with_collisions' ? 2 : 0;
}

export function installExitCode(result: Pick<InstallResult, 'doctor'>): number {
  return result.doctor?.exit_code ?? 0;
}
