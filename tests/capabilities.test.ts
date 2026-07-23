import { describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../src/host/cursor-agent.js';
import { discoverCursorCapabilities } from '../src/capabilities/discovery.js';
import type { CapabilityLock } from '../src/capabilities/types.js';

const lock: CapabilityLock = {
  schema_version: 1, host: 'cursor-agent', host_version: '2026.07.20-8cc9c0b', observed_at: '2026-07-23T00:00:00.000Z',
  capabilities: { session_resume: { verified: true }, native_team_orchestration: { verified: false, reason: 'not observed' } },
};
const help = '--output-format <format>\n--resume [chatId]\n--continue\ncreate-chat\n  ls Resume\n--mode <mode>\n';

describe('capability discovery', () => {
  it('verifies only an exact pinned version and help surface', async () => {
    const adapter = new CursorAgentAdapter('cursor-agent', async (_exe, invocation) => invocation.argv[0] === '--version'
      ? { code: 0, stdout: '2026.07.20-8cc9c0b\n', stderr: '' }
      : { code: 0, stdout: help, stderr: '' });
    const result = await discoverCursorCapabilities(adapter, lock, '/repo');
    expect(result.verified).toBe(true);
    expect(result.capabilities.native_team_orchestration?.verified).toBe(false);
  });

  it('downgrades every capability when the live host drifts', async () => {
    const adapter = new CursorAgentAdapter('cursor-agent', async (_exe, invocation) => invocation.argv[0] === '--version'
      ? { code: 0, stdout: 'newer\n', stderr: '' }
      : { code: 0, stdout: help, stderr: '' });
    const result = await discoverCursorCapabilities(adapter, lock, '/repo');
    expect(result.verified).toBe(false);
    expect(result.capabilities.session_resume?.verified).toBe(false);
  });
});
