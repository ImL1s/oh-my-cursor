import crypto from 'node:crypto';
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
import {
  listAgentRoles,
  resolveRoleAndProfile,
  discoverCustomAgents,
  composeAgentPrompt,
  resolveAgentRoute,
  explainAgentRoute,
  validateAgentInvocation,
} from '../agents/index.js';
import {
  getHookRegistry,
  HOOK_TIER_NAMES,
  dispatchHook,
  runHooksDoctor,
  getHookTraces,
  generateHooksConfig,
  checkHooksConfig,
  type CursorNativeHookEvent,
} from '../hooks/index.js';
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
  if (command === 'agents') {
    if (action === 'list') {
      const source = optionValue<string>(context, '--source');
      const canonicalRoles = listAgentRoles(source ? { source } : undefined);
      const customRoles = (!source || source === 'all' || source === 'custom')
        ? discoverCustomAgents(context.cwd)
        : [];
      const allRoles = [...canonicalRoles, ...customRoles];
      printJson(context.io, {
        ok: true,
        count: allRoles.length,
        roles: allRoles.map((r) => ({
          id: r.id,
          canonicalName: r.canonicalName,
          category: r.category,
          mode: r.mode,
          routingTier: r.model.routingTier,
          profiles: r.profiles.map((p) => p.profileId),
          defaultProfile: r.defaultProfile,
          custom: Boolean(r.custom),
          description: r.profiles.find((p) => p.profileId === r.defaultProfile)?.description ?? '',
        })),
      });
      return 0;
    }
    if (action === 'show') {
      const roleName = context.parsed.positionals[0] ?? '';
      const profileName = optionValue<string>(context, '--profile');
      try {
        const { role, profile } = resolveRoleAndProfile(roleName, profileName);
        const promptPreview = composeAgentPrompt(role, profile.profileId);
        printJson(context.io, {
          ok: true,
          role,
          selectedProfile: profile,
          promptPreview: {
            promptHash: promptPreview.promptHash,
            effectiveTools: promptPreview.effectiveTools,
            deniedTools: promptPreview.deniedTools,
            writeScope: promptPreview.writeScope,
            maxDepth: promptPreview.maxDepth,
            canDelegate: promptPreview.canDelegate,
            systemPrompt: promptPreview.systemPrompt,
          },
        });
        return 0;
      } catch (err) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return 1;
      }
    }
    if (action === 'invoke') {
      const roleName = context.parsed.positionals[0] ?? '';
      const prompt = optionValue<string>(context, '--prompt') ?? '';
      const runtime = (optionValue<string>(context, '--runtime') ?? 'local') as 'local' | 'cloud';
      const background = flagValue(context, '--background');
      const profileName = optionValue<string>(context, '--profile');
      try {
        const { role, profile } = resolveRoleAndProfile(roleName, profileName);
        const enforcement = validateAgentInvocation(
          role,
          { runtime, isBackground: background, profile: profile.profileId },
          profile
        );
        if (!enforcement.allowed) {
          printJson(context.io, {
            ok: false,
            error: enforcement.reason,
            code: enforcement.errorCode ?? 'E_ENFORCEMENT_FAILED',
          });
          return 1;
        }
        const route = resolveAgentRoute(role, profile, { runtime });
        const composed = composeAgentPrompt(role, profile.profileId, { objective: prompt });
        const runId = `omcu-run-${crypto.randomUUID().slice(0, 8)}`;
        printJson(context.io, {
          ok: true,
          run_id: runId,
          role: role.canonicalName,
          profile: profile.profileId,
          runtime,
          background,
          model: route.selectedModel,
          routingTier: route.routingTier,
          prompt_hash: composed.promptHash,
          effective_tools: composed.effectiveTools,
          status: 'dispatched',
        });
        return 0;
      } catch (err) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return 1;
      }
    }
  }
  if (command === 'route') {
    if (action === 'explain') {
      const agent = optionValue<string>(context, '--agent') ?? '';
      const profile = optionValue<string>(context, '--profile');
      const model = optionValue<string>(context, '--model');
      const runtime = optionValue<string>(context, '--runtime') as 'local' | 'cloud' | undefined;
      try {
        const explanation = explainAgentRoute(agent, { profile, model, runtime });
        printJson(context.io, {
          ok: true,
          explanation,
        });
        return explanation.resolutionStep === 'unavailable' ? 1 : 0;
      } catch (err) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return 1;
      }
    }
  }
  if (command === 'hooks') {
    if (action === 'list') {
      const event = optionValue<string>(context, '--event') as CursorNativeHookEvent | undefined;
      const registry = getHookRegistry();
      const handlers = registry.listHandlers(event ? { event } : undefined);
      printJson(context.io, {
        ok: true,
        count: handlers.length,
        handlers: handlers.map((h) => ({
          id: h.id,
          name: h.name,
          event: h.event,
          tier: h.tier,
          tierName: HOOK_TIER_NAMES[h.tier],
          priority: h.priority,
          matcher: h.matcher,
          loopLimit: h.loopLimit,
          failurePolicy: h.failurePolicy,
          canonicalContractId: h.canonicalContractId,
          immutable: h.immutable,
          description: h.description,
        })),
      });
      return 0;
    }
    if (action === 'show') {
      const id = context.parsed.positionals[0] ?? '';
      const registry = getHookRegistry();
      const handler = registry.getHandler(id);
      if (!handler) {
        printJson(context.io, { ok: false, error: `Hook handler not found: ${id}` });
        return 1;
      }
      printJson(context.io, {
        ok: true,
        handler: {
          id: handler.id,
          name: handler.name,
          description: handler.description,
          event: handler.event,
          tier: handler.tier,
          tierName: HOOK_TIER_NAMES[handler.tier],
          priority: handler.priority,
          matcher: handler.matcher,
          loopLimit: handler.loopLimit,
          timeoutMs: handler.timeoutMs,
          maxInputBytes: handler.maxInputBytes,
          failurePolicy: handler.failurePolicy,
          sourceAnalogs: handler.sourceAnalogs,
          canonicalContractId: handler.canonicalContractId,
          stateAccess: handler.stateAccess,
          immutable: handler.immutable,
          supportedRuntimes: handler.supportedRuntimes,
        },
      });
      return 0;
    }
    if (action === 'doctor') {
      const live = flagValue(context, '--live');
      const report = await runHooksDoctor({ cwd: context.cwd, packageRoot: context.packageRoot, live });
      printJson(context.io, report);
      return report.ok ? 0 : 1;
    }
    if (action === 'trace') {
      const runId = optionValue<string>(context, '--run');
      const traces = getHookTraces(runId, context.cwd);
      printJson(context.io, {
        ok: true,
        count: traces.length,
        runId,
        traces,
      });
      return 0;
    }
    if (action === 'test') {
      const event = context.parsed.positionals[0] ?? '';
      const fixtureStr = optionValue<string>(context, '--fixture') ?? '{}';
      try {
        let fixtureInput: unknown;
        if (fixtureStr.startsWith('@') || fs.existsSync(fixtureStr)) {
          const filePath = fixtureStr.startsWith('@') ? fixtureStr.slice(1) : fixtureStr;
          fixtureInput = JSON.parse(fs.readFileSync(path.resolve(context.cwd, filePath), 'utf8'));
        } else {
          fixtureInput = JSON.parse(fixtureStr);
        }
        const dispatchResult = await dispatchHook(event, fixtureInput, { cwd: context.cwd });
        printJson(context.io, {
          ok: dispatchResult.success,
          dispatchResult,
        });
        return dispatchResult.success ? 0 : 1;
      } catch (err) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return 1;
      }
    }
    if (action === 'generate') {
      const check = flagValue(context, '--check');
      const target = (optionValue<string>(context, '--target') ?? 'plugin') as 'plugin' | 'project';
      const targetFile = target === 'plugin'
        ? path.join(context.packageRoot, 'hooks', 'hooks.json')
        : path.join(context.cwd, '.cursor', 'hooks.json');

      if (check) {
        const checkResult = checkHooksConfig(targetFile, target);
        printJson(context.io, {
          ok: checkResult.inSync,
          target,
          file: targetFile,
          inSync: checkResult.inSync,
          diff: checkResult.diff,
        });
        return checkResult.inSync ? 0 : 1;
      }

      const generated = generateHooksConfig({ target });
      printJson(context.io, {
        ok: true,
        target,
        config: generated,
      });
      return 0;
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
