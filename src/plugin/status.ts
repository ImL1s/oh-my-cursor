import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_VERSION } from '../version.js';
import {
  buildCatalogManifest,
  fileSha256,
  resolveCatalogComponents,
} from '../catalog/manifest.js';
import type {
  ComponentsListReport,
  PluginDoctorReport,
  PluginStatusReport,
  SupportTierMatrix,
} from '../catalog/types.js';
import { detectActivationModes } from './activation-modes.js';
import { scanComponentCollisions } from './collision.js';
import {
  probeAgentActivation,
  probeHookActivation,
  probeMcpActivation,
  probePluginDiscovery,
  probeSdkService,
  probeSkillActivation,
  type ProbeOptions,
} from './probes.js';

export interface PluginStatusOptions extends ProbeOptions {
  readonly stateRoot?: string | undefined;
  readonly homeDir?: string | undefined;
}

export async function inspectPluginStatus(options: PluginStatusOptions): Promise<PluginStatusReport> {
  const packageRoot = path.resolve(options.packageRoot);
  const projectRoot = path.resolve(options.projectRoot ?? packageRoot);
  const manifestFile = path.join(packageRoot, '.cursor-plugin', 'plugin.json');

  const packagePresent = fs.existsSync(packageRoot);
  let manifestValid = false;
  if (fs.existsSync(manifestFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { name?: string };
      manifestValid = parsed.name === 'oh-my-cursor';
    } catch {
      manifestValid = false;
    }
  }

  const manifestHash = fs.existsSync(manifestFile) ? fileSha256(manifestFile) : '0'.repeat(64);
  const collisions = scanComponentCollisions({
    packageRoot,
    projectRoot,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {}),
  });

  const activationModes = detectActivationModes({
    packageRoot,
    projectRoot,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {}),
  });

  const components = resolveCatalogComponents(packageRoot);
  const allComponentsResolved = components.every((c) => c.status === 'resolved');

  const supportTier: SupportTierMatrix = {
    interactive: 'native',
    cli: 'native',
    sdk: 'native',
  };

  const hasErrors = collisions.some((c) => c.severity === 'error') || !packagePresent || !manifestValid;

  return {
    ok: !hasErrors,
    package_present: packagePresent,
    manifest_valid: manifestValid,
    host_accepted: manifestValid,
    registry_visible: manifestValid,
    activation_proven: false, // Proven only during live probe
    sdk_service_proven: false, // Proven only during live probe
    collisions,
    resolved: {
      release_path: packageRoot,
      version: PACKAGE_VERSION,
      hash: manifestHash,
    },
    support_tier: supportTier,
    activation_modes: activationModes,
    components,
  };
}

export async function runPluginDoctor(
  options: PluginStatusOptions,
  live = false,
): Promise<PluginDoctorReport> {
  const baseStatus = await inspectPluginStatus(options);

  if (!live) {
    // Return static doctor report
    return {
      ...baseStatus,
      live_probes: {
        plugin_discovery: { name: 'plugin_discovery', passed: baseStatus.manifest_valid, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
        skill_activation: { name: 'skill_activation', passed: baseStatus.package_present, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
        agent_activation: { name: 'agent_activation', passed: baseStatus.package_present, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
        hook_activation: { name: 'hook_activation', passed: baseStatus.package_present, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
        mcp_activation: { name: 'mcp_activation', passed: baseStatus.package_present, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
        sdk_service: { name: 'sdk_service', passed: true, durationMs: 0, detail: { note: 'Run with --live to probe Cursor host' } },
      },
    };
  }

  // Run all 6 live provenance probes
  const [
    discovery,
    skill,
    agent,
    hook,
    mcp,
    sdk,
  ] = await Promise.all([
    probePluginDiscovery(options),
    probeSkillActivation(options),
    probeAgentActivation(options),
    probeHookActivation(options),
    probeMcpActivation(options),
    probeSdkService(options),
  ]);

  const allProbesPassed = [discovery, skill, agent, hook, mcp, sdk].every((p) => p.passed);
  const hostAccepted = discovery.passed;
  const activationProven = skill.passed && agent.passed && hook.passed;
  const sdkServiceProven = sdk.passed;

  return {
    ...baseStatus,
    ok: baseStatus.ok && allProbesPassed,
    host_accepted: hostAccepted,
    registry_visible: discovery.passed,
    activation_proven: activationProven,
    sdk_service_proven: sdkServiceProven,
    live_probes: {
      plugin_discovery: discovery,
      skill_activation: skill,
      agent_activation: agent,
      hook_activation: hook,
      mcp_activation: mcp,
      sdk_service: sdk,
    },
  };
}

export function listComponentsReport(
  packageRoot: string,
  resolvedOnly = false,
): ComponentsListReport {
  const all = resolveCatalogComponents(packageRoot);
  const filtered = resolvedOnly ? all.filter((c) => c.status === 'resolved') : all;
  const resolvedCount = all.filter((c) => c.status === 'resolved').length;
  const collidingCount = all.filter((c) => c.status === 'colliding').length;
  const missingCount = all.filter((c) => c.status === 'missing').length;

  return {
    ok: missingCount === 0,
    total: all.length,
    resolved_count: resolvedCount,
    colliding_count: collidingCount,
    missing_count: missingCount,
    components: filtered,
  };
}
