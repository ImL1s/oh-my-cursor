import type { CursorAgentAdapter } from '../host/cursor-agent.js';
import type { CapabilityDiscovery, CapabilityLock } from './types.js';

const REQUIRED_HELP = [
  '--output-format <format>', '--resume [chatId]', '--continue', 'create-chat', '\n  ls ', '--mode <mode>',
] as const;

export function validateCapabilityLock(value: unknown): CapabilityLock {
  if (value === null || typeof value !== 'object') throw new Error('E_CAPABILITY_LOCK_INVALID');
  const lock = value as Partial<CapabilityLock>;
  if (lock.schema_version !== 1 || lock.host !== 'cursor-agent' || typeof lock.host_version !== 'string' || lock.capabilities === null || typeof lock.capabilities !== 'object') {
    throw new Error('E_CAPABILITY_LOCK_INVALID');
  }
  return lock as CapabilityLock;
}

export async function discoverCursorCapabilities(adapter: CursorAgentAdapter, lock: CapabilityLock, cwd: string): Promise<CapabilityDiscovery> {
  const [versionResult, helpResult] = await Promise.all([
    adapter.run({ argv: ['--version'], cwd, interactive: false }, { timeoutMs: 10_000 }),
    adapter.run({ argv: ['--help'], cwd, interactive: false }, { timeoutMs: 10_000 }),
  ]);
  const observedVersion = versionResult.code === 0 ? versionResult.stdout.trim() : null;
  const versionMatches = observedVersion === lock.host_version;
  const missing = REQUIRED_HELP.filter((needle) => !helpResult.stdout.includes(needle));
  const helpMatches = helpResult.code === 0 && missing.length === 0;
  const diagnostics: string[] = [];
  if (!versionMatches) diagnostics.push(`version mismatch: expected ${lock.host_version}, observed ${observedVersion ?? 'unavailable'}`);
  if (!helpMatches) diagnostics.push(`help missing pinned surface(s): ${missing.join(', ') || 'help unavailable'}`);
  return {
    schema_version: 1,
    host: 'cursor-agent',
    expected_version: lock.host_version,
    observed_version: observedVersion,
    version_matches: versionMatches,
    help_matches: helpMatches,
    verified: versionMatches && helpMatches,
    diagnostics,
    capabilities: versionMatches && helpMatches
      ? lock.capabilities
      : Object.fromEntries(Object.entries(lock.capabilities).map(([name, claim]) => [name, { ...claim, verified: false, reason: 'current host probe did not match the pinned capability lock' }])),
  };
}

export async function discoverCursorComponents(
  adapter: CursorAgentAdapter,
  packageRoot: string,
  cwd: string,
  live = false,
): Promise<import('../catalog/types.js').CursorComponentsCapabilityReport> {
  const [versionResult, helpResult, pluginResult] = await Promise.all([
    adapter.run({ argv: ['--version'], cwd, interactive: false }, { timeoutMs: 10_000 }),
    adapter.run({ argv: ['--help'], cwd, interactive: false }, { timeoutMs: 10_000 }),
    live ? adapter.run({ argv: ['--plugin-dir', packageRoot, '--help'], cwd, interactive: false }, { timeoutMs: 10_000 }) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  ]);

  const observedVersion = versionResult.code === 0 ? versionResult.stdout.trim() : null;
  const hostAccepted = pluginResult.code === 0;

  return {
    ok: observedVersion !== null && hostAccepted,
    host: 'cursor-agent',
    host_version: observedVersion,
    components: {
      plugin_manifest: {
        supported: true,
        status: 'native',
        detail: 'Cursor supports --plugin-dir with .cursor-plugin/plugin.json manifest schema',
      },
      skills: {
        supported: true,
        status: 'native',
        detail: 'Native Cursor skills supported in skills/<name>/SKILL.md format',
      },
      agents: {
        supported: true,
        status: 'native',
        detail: 'Custom agents supported in agents/<name>.md format',
      },
      rules: {
        supported: true,
        status: 'native',
        detail: 'Cursor rules supported under .cursor/rules/*.mdc format',
      },
      hooks: {
        supported: true,
        status: 'native',
        detail: 'Cursor lifecycle hooks supported via hooks/hooks.json format',
      },
      mcp: {
        supported: true,
        status: 'native',
        detail: 'Model Context Protocol supported via .mcp.json stdio server',
      },
      sdk: {
        supported: true,
        status: 'native',
        detail: 'Cursor SDK (@cursor/sdk@1.0.31) supported as execution runtime',
      },
    },
    live_proven: live && hostAccepted,
  };
}
