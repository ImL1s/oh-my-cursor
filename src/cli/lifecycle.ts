import fs from 'node:fs';
import path from 'node:path';
import { quarantineInvalidCliOwnerRecord } from '../state/authority.js';
import {
  inspectInstallStatus,
  installOrUpdate,
  listInstallations,
  pruneInstallations,
  repairInstallation,
  rollbackInstallation,
  runSetupDoctor,
  uninstall,
  verifyInstallations,
  type CommandRunner,
  type InstallResult,
} from '../setup/index.js';
import {
  inspectMcpStatus,
  installMcpServer,
  uninstallMcpServer,
  type McpStatusResult,
} from '../mcp/lifecycle.js';
import {
  inspectPluginStatus,
  runPluginDoctor,
  listComponentsReport,
} from '../plugin/index.js';
import { explainAlias } from '../catalog/index.js';
import { discoverCursorComponents } from '../capabilities/discovery.js';
import type { CursorAgentAdapter } from '../host/cursor-agent.js';
import { externalStateRoot, flagValue, optionValue, printJson, type CliContext } from './shared.js';

function adapterToCommandRunner(adapter: CursorAgentAdapter, defaultCwd: string): CommandRunner {
  return {
    async run(_command, args, options) {
      try {
        const result = await adapter.run(
          { argv: args, cwd: options?.cwd ?? defaultCwd, interactive: false },
          {
            ...(options?.env !== undefined ? { env: options.env } : {}),
            ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          },
        );
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      } catch (err) {
        return {
          code: 1,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export async function handleLifecycle(context: CliContext): Promise<number | null> {
  const { command, action } = context.parsed;
  const stateRoot = optionValue<string>(context, '--state-root') ?? externalStateRoot(context.homeDir);
  const runner = adapterToCommandRunner(context.adapter, context.cwd);
  if (command === 'setup' || command === 'update') {
    const source = optionValue<string>(context, '--source');
    const archive = optionValue<string>(context, '--archive');
    const checksums = optionValue<string>(context, '--checksums');
    const tag = optionValue<string>(context, '--tag');
    const latest = flagValue(context, '--latest');
    const dryRun = flagValue(context, '--dry-run');

    if (command === 'update') {
      if (!source && !archive && !tag && !latest) {
        throw new Error('E_UPDATE_SOURCE_REQUIRED: specify an explicit update source (--source <dir>, --archive <tar> --checksums <file>, --tag <tag>, or --latest)');
      }
    }

    const result = await installOrUpdate({
      ...(source ? { sourceRoot: source } : (command === 'setup' && !archive && !tag && !latest ? { sourceRoot: context.packageRoot } : {})),
      action: command === 'update' ? 'update' : 'install',
      ...(archive ? { sourceArchive: archive } : {}),
      ...(checksums ? { checksumsFile: checksums } : {}),
      ...(tag ? { releaseTag: tag } : {}),
      ...(latest ? { releaseLatest: true } : {}),
      homeDir: context.homeDir,
      stateRoot,
      projectRoot: context.cwd,
      initializeProjectState: flagValue(context, '--init-project-state'),
      dryRun,
      runner,
    });
    printJson(context.io, result);
    return installExitCode(result);
  }
  if (command === 'rollback') {
    const receipt = optionValue<string>(context, '--receipt');
    const dryRun = flagValue(context, '--dry-run');
    const result = await rollbackInstallation({
      receiptPathOrId: receipt ?? undefined,
      homeDir: context.homeDir,
      stateRoot,
      projectRoot: context.cwd,
      dryRun,
      runner,
    });
    printJson(context.io, result);
    return 0;
  }
  if (command === 'install') {
    if (action === 'status') {
      const result = await inspectInstallStatus({
        homeDir: context.homeDir,
        stateRoot,
        projectRoot: context.cwd,
      });
      printJson(context.io, result);
      return result.healthy ? 0 : 1;
    }
    if (action === 'list') {
      const result = await listInstallations({
        homeDir: context.homeDir,
        stateRoot,
        projectRoot: context.cwd,
      });
      printJson(context.io, result);
      return 0;
    }
    if (action === 'verify') {
      const all = flagValue(context, '--all');
      const result = await verifyInstallations({
        homeDir: context.homeDir,
        stateRoot,
        all,
      });
      printJson(context.io, result);
      return result.ok ? 0 : 1;
    }
    if (action === 'prune') {
      const dryRun = flagValue(context, '--dry-run') || !flagValue(context, '--apply');
      const keep = optionValue<number>(context, '--keep') ?? 2;
      const result = await pruneInstallations({
        homeDir: context.homeDir,
        stateRoot,
        projectRoot: context.cwd,
        keep,
        dryRun,
      });
      printJson(context.io, result);
      return 0;
    }
    if (action === 'repair') {
      const result = await repairInstallation({
        homeDir: context.homeDir,
        stateRoot,
        projectRoot: context.cwd,
        runner,
      });
      printJson(context.io, result);
      return result.repaired ? 0 : (result.doctor?.ok === false ? 1 : 0);
    }
  }
  if (command === 'doctor') {
    const repairOwner = flagValue(context, '--repair-owner');
    const repairJournals = flagValue(context, '--repair-journals');
    const quarantinedOwner = repairOwner
      ? quarantineInvalidCliOwnerRecord(context.root)
      : null;
    const report = await runSetupDoctor({
      packageRoot: context.packageRoot,
      projectRoot: context.cwd,
      homeDir: context.homeDir,
      repairJournals,
      runner,
    });
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
  if (command === 'plugin') {
    if (action === 'status') {
      const result = await inspectPluginStatus({
        packageRoot: context.packageRoot,
        projectRoot: context.cwd,
        homeDir: context.homeDir,
        stateRoot,
        runner,
      });
      printJson(context.io, result);
      return result.ok ? 0 : 1;
    }
    if (action === 'doctor') {
      const live = flagValue(context, '--live');
      const result = await runPluginDoctor({
        packageRoot: context.packageRoot,
        projectRoot: context.cwd,
        homeDir: context.homeDir,
        stateRoot,
        runner,
      }, live);
      printJson(context.io, result);
      return result.ok ? 0 : 1;
    }
  }
  if (command === 'components') {
    if (action === 'list') {
      const resolved = flagValue(context, '--resolved');
      const result = listComponentsReport(context.packageRoot, resolved);
      printJson(context.io, result);
      return result.ok ? 0 : 1;
    }
  }
  if (command === 'aliases') {
    if (action === 'explain') {
      const name = context.parsed.positionals[0] ?? '';
      const result = explainAlias(name, context.packageRoot);
      printJson(context.io, result);
      return result.found ? 0 : 1;
    }
  }
  if (command === 'capabilities' && action === 'cursor-components') {
    const live = flagValue(context, '--live');
    const result = await discoverCursorComponents(context.adapter, context.packageRoot, context.cwd, live);
    printJson(context.io, result);
    return result.ok ? 0 : 1;
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
  if (result.configured_server !== null && !result.executable_exists) {
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
