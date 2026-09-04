import fs from 'node:fs';
import path from 'node:path';
import { quarantineInvalidCliOwnerRecord } from '../state/authority.js';
import { installOrUpdate, runSetupDoctor, uninstall, type InstallResult } from '../setup/index.js';
import {
  inspectMcpStatus,
  installMcpServer,
  uninstallMcpServer,
  type McpStatusResult,
} from '../mcp/lifecycle.js';
import { externalStateRoot, flagValue, optionValue, printJson, type CliContext } from './shared.js';

export async function handleLifecycle(context: CliContext): Promise<number | null> {
  const { command, action } = context.parsed;
  const stateRoot = optionValue<string>(context, '--state-root') ?? externalStateRoot(context.homeDir);
  if (command === 'setup' || command === 'update') {
    const result = await installOrUpdate({
      sourceRoot: optionValue<string>(context, '--source') ?? context.packageRoot,
      action: command === 'update' ? 'update' : 'install',
      homeDir: context.homeDir,
      stateRoot,
      projectRoot: context.cwd,
      initializeProjectState: flagValue(context, '--init-project-state'),
    });
    printJson(context.io, result);
    return installExitCode(result);
  }
  if (command === 'doctor') {
    const repairOwner = flagValue(context, '--repair-owner');
    const quarantinedOwner = repairOwner
      ? quarantineInvalidCliOwnerRecord(context.root)
      : null;
    const report = await runSetupDoctor({ packageRoot: context.packageRoot, projectRoot: context.cwd, homeDir: context.homeDir });
    printJson(context.io, repairOwner
      ? { ...report, owner_repair: { repaired: quarantinedOwner !== null, quarantine_path: quarantinedOwner } }
      : report);
    return report.exit_code;
  }
  if (command === 'uninstall') {
    const receiptPath = optionValue<string>(context, '--receipt') ?? (JSON.parse(fs.readFileSync(path.join(stateRoot, 'install', 'current.json'), 'utf8')) as { receipt_path: string }).receipt_path;
    const result = uninstall({ receiptPath, homeDir: context.homeDir, stateRoot, purgeProjectState: flagValue(context, '--purge-project-state') });
    printJson(context.io, result);
    return uninstallExitCode(result.status);
  }
  if (command === 'mcp') {
    const file = optionValue<string>(context, '--file');
    const receipt = optionValue<string>(context, '--receipt');
    const dryRun = flagValue(context, '--dry-run');
    const replace = flagValue(context, '--replace');
    const noProbe = flagValue(context, '--no-probe');

    if (action === 'status') {
      const result = await inspectMcpStatus({
        targetFile: file,
        receiptFile: receipt,
        cwd: context.cwd,
        homeDir: context.homeDir,
        packageRoot: context.packageRoot,
        noProbe,
      });
      printJson(context.io, result);
      return mcpStatusExitCode(result);
    }
    if (action === 'install') {
      const result = await installMcpServer({
        targetFile: file,
        receiptFile: receipt,
        dryRun,
        replace,
        cwd: context.cwd,
        homeDir: context.homeDir,
        packageRoot: context.packageRoot,
      });
      printJson(context.io, result);
      return 0;
    }
    if (action === 'uninstall') {
      const result = await uninstallMcpServer({
        targetFile: file,
        receiptFile: receipt,
        dryRun,
        cwd: context.cwd,
        homeDir: context.homeDir,
        packageRoot: context.packageRoot,
      });
      printJson(context.io, result);
      return 0;
    }
  }
  if (command === 'mcp-install') {
    const file = optionValue<string>(context, '--file');
    const receipt = optionValue<string>(context, '--receipt');
    const dryRun = flagValue(context, '--dry-run');
    const replace = flagValue(context, '--replace');
    const result = await installMcpServer({
      targetFile: file,
      receiptFile: receipt,
      dryRun,
      replace,
      cwd: context.cwd,
      homeDir: context.homeDir,
      packageRoot: context.packageRoot,
    });
    printJson(context.io, result);
    return 0;
  }
  if (command === 'native-status' || (command === 'capabilities' && action === 'native-status')) {
    const result = await context.adapter.run({ argv: ['status'], cwd: context.cwd, interactive: false });
    printJson(context.io, { available: result.code === 0, exit_code: result.code, stdout: result.stdout, stderr: result.stderr });
    return result.code;
  }
  return null;
}

function mcpStatusExitCode(result: McpStatusResult): number {
  if (result.state === 'malformed' || result.state === 'unsafe-target' || result.state === 'foreign-conflict') {
    return 1;
  }
  if (result.health !== null && !result.health.ok) {
    return 1;
  }
  return 0;
}

export function uninstallExitCode(status: string): number {
  return status === 'completed_with_collisions' ? 2 : 0;
}

export function installExitCode(result: Pick<InstallResult, 'doctor'>): number {
  // Successful installs must exit 0 even when post-install doctor only warns.
  // Doctor soft-warns (exit 2) are advisory; failures (ok=false / exit 1) fail
  // the install path. Returning 2 here made `curl | bash` bootstrap look broken
  // after a receipt was already written.
  const doctor = result.doctor;
  if (doctor === null || doctor === undefined) return 0;
  if (!doctor.ok || doctor.exit_code === 1) return 1;
  return 0;
}
