import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/application.js';
import {
  inspectPluginStatus,
  runPluginDoctor,
  listComponentsReport,
  probePluginDiscovery,
  probeSkillActivation,
  probeAgentActivation,
  probeHookActivation,
  probeMcpActivation,
  probeSdkService,
} from '../../src/plugin/index.js';
import { explainAlias } from '../../src/catalog/index.js';
import { discoverCursorComponents } from '../../src/capabilities/discovery.js';
import { CursorAgentAdapter } from '../../src/host/cursor-agent.js';
import { PACKAGE_VERSION } from '../../src/version.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');

function harness(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const adapter = new CursorAgentAdapter('cursor-agent', async () => ({
    code: 0,
    stdout: 'Cursor Agent (test harness)\n--help\n--plugin-dir',
    stderr: '',
  }));
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    dependencies: {
      cwd,
      homeDir: path.join(cwd, 'home'),
      packageRoot,
      adapter,
    },
  };
}

describe('OMCU native Cursor plugin provenance and deterministic resolution', () => {
  it('inspects plugin status and resolves canonical components', async () => {
    const status = await inspectPluginStatus({ packageRoot });
    expect(status.ok).toBe(true);
    expect(status.package_present).toBe(true);
    expect(status.manifest_valid).toBe(true);
    expect(status.host_accepted).toBe(true);
    expect(status.registry_visible).toBe(true);
    expect(status.activation_proven).toBe(false); // only proven during live doctor
    expect(status.sdk_service_proven).toBe(false);
    expect(status.resolved.version).toBe(PACKAGE_VERSION);
    expect(status.resolved.release_path).toBe(packageRoot);
    expect(status.resolved.hash.length).toBe(64);
    expect(status.support_tier).toEqual({
      interactive: 'native',
      cli: 'native',
      sdk: 'native',
    });
    expect(status.components).toBeDefined();
    expect(status.components!.length).toBeGreaterThanOrEqual(20);

    const canonicalProbe = status.components!.find((c) => c.canonicalName === 'omcu-provenance-probe');
    expect(canonicalProbe).toBeDefined();
    expect(canonicalProbe!.status).toBe('resolved');
    expect(canonicalProbe!.provenanceMarker).toBe(`omcu:${PACKAGE_VERSION}:omcu-skill-provenance-probe`);
  });

  it('runs static plugin doctor and reports advisory guidance without host execution', async () => {
    const report = await runPluginDoctor({ packageRoot }, false);
    expect(report.ok).toBe(true);
    expect(report.manifest_valid).toBe(true);
    expect(report.live_probes.plugin_discovery.passed).toBe(true);
    expect(report.live_probes.skill_activation.detail?.note).toContain('--live');
  });

  it('runs live plugin doctor proving all 6 component provenance boundaries', async () => {
    const report = await runPluginDoctor({ packageRoot }, true);
    expect(report.ok).toBe(true);
    expect(report.activation_proven).toBe(true);
    expect(report.sdk_service_proven).toBe(true);

    // 1. Plugin discovery
    expect(report.live_probes.plugin_discovery.passed).toBe(true);
    expect(report.live_probes.plugin_discovery.detail?.roots_verified).toBeDefined();

    // 2. Skill activation
    expect(report.live_probes.skill_activation.passed).toBe(true);
    expect(report.live_probes.skill_activation.detail?.fixture).toBe('omcu-provenance-probe');
    expect(report.live_probes.skill_activation.detail?.expected_token).toMatch(/^OMCU_PROVENANCE_PROBE_ACK:[a-f0-9]+:[a-f0-9]{64}$/);

    // 3. Agent activation
    expect(report.live_probes.agent_activation.passed).toBe(true);
    expect(report.live_probes.agent_activation.detail?.agent).toBe('omcu-provenance-agent');
    expect(report.live_probes.agent_activation.detail?.boundary_enforced).toBe('no_nested_subagents');

    // 4. Hook activation
    expect(report.live_probes.hook_activation.passed).toBe(true);
    expect(report.live_probes.hook_activation.detail?.nonce_verified).toBe(true);
    expect(report.live_probes.hook_activation.detail?.provenance).toBe('omcu');

    // 5. MCP activation
    expect(report.live_probes.mcp_activation.passed).toBe(true);
    expect(report.live_probes.mcp_activation.detail?.tools_count).toBeGreaterThanOrEqual(4);

    // 6. SDK service
    expect(report.live_probes.sdk_service.passed).toBe(true);
    expect(report.live_probes.sdk_service.detail?.sdk_target).toBe('local');
  });

  it('distinguishes static presence from live activation failure', async () => {
    // When a broken runner or invalid package causes hook failure
    const fakeBrokenPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-fake-pkg-'));
    try {
      fs.mkdirSync(path.join(fakeBrokenPackage, '.cursor-plugin'), { recursive: true });
      fs.writeFileSync(path.join(fakeBrokenPackage, '.cursor-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-cursor',
        version: PACKAGE_VERSION,
        commands: './commands/',
        agents: './agents/',
        skills: './skills/',
        rules: './.cursor/rules/',
        hooks: './hooks/hooks.json',
        mcpServers: './.mcp.json',
      }));
      fs.mkdirSync(path.join(fakeBrokenPackage, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(fakeBrokenPackage, 'hooks', 'hooks.json'), '{}');
      // Create a hook that produces mismatched provenance
      fs.writeFileSync(path.join(fakeBrokenPackage, 'hooks', 'omcu-hook.mjs'), 'console.log(JSON.stringify({ provenance: "untrusted", version: "0.0.1" })); process.exit(0);\n');

      const hookProbe = await probeHookActivation({ packageRoot: fakeBrokenPackage, nonce: 'test-nonce' });
      expect(hookProbe.passed).toBe(false);
      expect(hookProbe.error).toContain('provenance verification');
    } finally {
      fs.rmSync(fakeBrokenPackage, { recursive: true, force: true });
    }
  });

  it('lists resolved components and filters with --resolved flag', () => {
    const listAll = listComponentsReport(packageRoot, false);
    expect(listAll.ok).toBe(true);
    expect(listAll.total).toBeGreaterThanOrEqual(20);
    expect(listAll.missing_count).toBe(0);

    const listResolved = listComponentsReport(packageRoot, true);
    expect(listResolved.components.length).toBe(listAll.resolved_count);
  });

  it('explains canonical component and backward-compatible alias names', () => {
    const canonical = explainAlias('omcu-autopilot', packageRoot);
    expect(canonical.found).toBe(true);
    expect(canonical.is_canonical).toBe(true);
    expect(canonical.canonical_name).toBe('omcu-autopilot');
    expect(canonical.guidance).toContain('canonical OMCU component');

    const alias = explainAlias('autopilot', packageRoot);
    expect(alias.found).toBe(true);
    expect(alias.is_canonical).toBe(false);
    expect(alias.canonical_replacement).toBe('omcu-autopilot');
    expect(alias.guidance).toContain('backward-compatible alias');

    const unknown = explainAlias('non-existent-thing', packageRoot);
    expect(unknown.found).toBe(false);
    expect(unknown.is_canonical).toBe(false);
    expect(unknown.guidance).toContain('Unknown component or alias');
  });

  it('integrates plugin, components, aliases, and capabilities cursor-components into CLI surface', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-plugin-cli-'));
    const h = harness(cwd);
    try {
      // 1. omcu plugin status
      expect(await runCli(['plugin', 'status'], h.dependencies, h.io)).toBe(0);
      const statusOut = JSON.parse(h.stdout.shift()!) as { ok: boolean; package_present: boolean };
      expect(statusOut.ok).toBe(true);
      expect(statusOut.package_present).toBe(true);

      // 2. omcu plugin doctor --live
      expect(await runCli(['plugin', 'doctor', '--live'], h.dependencies, h.io)).toBe(0);
      const docOut = JSON.parse(h.stdout.shift()!) as { ok: boolean; activation_proven: boolean };
      expect(docOut.ok).toBe(true);
      expect(docOut.activation_proven).toBe(true);

      // 3. omcu components list --resolved
      expect(await runCli(['components', 'list', '--resolved'], h.dependencies, h.io)).toBe(0);
      const compOut = JSON.parse(h.stdout.shift()!) as { ok: boolean; total: number };
      expect(compOut.ok).toBe(true);
      expect(compOut.total).toBeGreaterThanOrEqual(20);

      // 4. omcu aliases explain autopilot
      expect(await runCli(['aliases', 'explain', 'autopilot'], h.dependencies, h.io)).toBe(0);
      const aliasOut = JSON.parse(h.stdout.shift()!) as { found: boolean; canonical_replacement: string };
      expect(aliasOut.found).toBe(true);
      expect(aliasOut.canonical_replacement).toBe('omcu-autopilot');

      // 5. omcu capabilities cursor-components --live
      expect(await runCli(['capabilities', 'cursor-components', '--live'], h.dependencies, h.io)).toBe(0);
      const capOut = JSON.parse(h.stdout.shift()!) as { ok: boolean; live_proven: boolean };
      expect(capOut.ok).toBe(true);
      expect(capOut.live_proven).toBe(true);

      expect(h.stderr).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
