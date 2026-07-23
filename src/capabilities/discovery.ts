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
