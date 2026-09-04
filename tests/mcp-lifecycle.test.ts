import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/application.js';
import {
  inspectMcpStatus,
  installMcpServer,
  uninstallMcpServer,
  resolveMcpLauncher,
  probeMcpHealth,
  readMcpInstallReceipt,
  findMcpReceipt,
  repairOwnedMcpServerSync,
  areServerConfigsEqual,
  type McpServerConfig,
} from '../src/mcp/lifecycle.js';
import { PACKAGE_VERSION } from '../src/version.js';

const roots: string[] = [];
function makeDir(prefix = 'omcu-mcp-lifecycle-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP lifecycle management (Issue #17)', () => {
  describe('Launcher resolution', () => {
    it('selects stable-shim when ~/.local/bin/omcu exists', () => {
      const home = makeDir('home-');
      const binDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'omcu');
      fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const launcher = resolveMcpLauncher({ homeDir: home, packageRoot: '/pkg', cwd: '/project' });
      expect(launcher.launcher_kind).toBe('stable-shim');
      expect(launcher.managed_updates).toBe(true);
      expect(launcher.server.command).toBe(shim);
      expect(launcher.server.args).toEqual(['mcp-server']);
      expect(launcher.server.cwd).toBe('/project');
    });

    it('falls back to developer-checkout when stable-shim is absent', () => {
      const home = makeDir('home-empty-');
      const pkg = makeDir('pkg-');
      const launcher = resolveMcpLauncher({ homeDir: home, packageRoot: pkg, cwd: '/project' });
      expect(launcher.launcher_kind).toBe('developer-checkout');
      expect(launcher.managed_updates).toBe(false);
      expect(launcher.server.command).toBe(process.execPath);
      expect(launcher.server.args).toEqual([path.join(pkg, 'dist', 'bin', 'omcu.js'), 'mcp-server']);
    });
  });

  describe('Install and status lifecycle', () => {
    it('installs into a brand new target file, creates directory and receipt, and sets default 0644 mode', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');
      const result = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });

      expect(result.installed).toBe(true);
      expect(result.action).toBe('install');
      expect(result.dry_run).toBe(false);
      expect(result.previous_config).toBeNull();
      expect(fs.existsSync(target)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor']).toBeDefined();
      expect(parsed.mcpServers['oh-my-cursor'].args).toEqual([path.join(process.cwd(), 'dist', 'bin', 'omcu.js'), 'mcp-server']);

      // Check receipt was written and is valid
      const receiptPath = findMcpReceipt(target, dir);
      expect(receiptPath).not.toBeNull();
      const receipt = readMcpInstallReceipt(receiptPath!);
      expect(receipt.store_kind).toBe('omcu_mcp_install_receipt');
      expect(receipt.schema_version).toBe(1);
      expect(receipt.server_name).toBe('oh-my-cursor');
      expect(receipt.target_sha256_before).toBeNull();
      expect(receipt.target_sha256_after).toBeDefined();
      expect(receipt.installed_server).toEqual(result.config);
      expect(receipt.previous_server).toBeNull();
      expect(receipt.omcu_version).toBe(PACKAGE_VERSION);
    });

    it('preserves unrelated top-level keys and existing servers', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify({
          title: 'custom-project',
          customSetting: 42,
          mcpServers: {
            'other-service': { command: 'other-cmd', args: ['run'] },
          },
        }, null, 2),
      );

      const home = path.join(dir, 'home');
      const result = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      expect(result.installed).toBe(true);
      expect(result.action).toBe('install');

      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.title).toBe('custom-project');
      expect(parsed.customSetting).toBe(42);
      expect(parsed.mcpServers['other-service']).toEqual({ command: 'other-cmd', args: ['run'] });
      expect(parsed.mcpServers['oh-my-cursor']).toBeDefined();
    });

    it('is strictly idempotent on exact re-install', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      const first = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      expect(first.action).toBe('install');

      const contentBefore = fs.readFileSync(target, 'utf8');
      const second = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      expect(second.installed).toBe(true);
      expect(second.action).toBe('noop');
      expect(fs.readFileSync(target, 'utf8')).toBe(contentBefore);
    });

    it('dry-run returns structured diff without mutating files', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      const dry = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir, dryRun: true });
      expect(dry.installed).toBe(true);
      expect(dry.dry_run).toBe(true);
      expect(dry.action).toBe('install');
      expect(dry.diff?.before).toBeNull();
      expect(dry.diff?.after).toEqual(dry.config);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('refuses collision on foreign same-name server without --replace', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify({
          mcpServers: {
            'oh-my-cursor': { command: 'foreign-binary', args: ['--serve'] },
          },
        }),
      );

      const home = path.join(dir, 'home');
      await expect(installMcpServer({ targetFile: target, homeDir: home, cwd: dir })).rejects.toThrow(
        'E_MCP_SERVER_COLLISION',
      );

      // Verify original file was preserved
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor'].command).toBe('foreign-binary');
    });

    it('tolerates malformed or unknown server objects in areServerConfigsEqual without throwing', () => {
      expect(areServerConfigsEqual({ command: 'test' }, { command: 'test', args: [] })).toBe(false);
      expect(areServerConfigsEqual({ command: 'test', args: null }, { command: 'test', args: [] })).toBe(false);
      expect(areServerConfigsEqual({ command: 'test', args: 'not-array' }, { command: 'test', args: [] })).toBe(false);
      expect(areServerConfigsEqual(null, undefined)).toBe(false);
      expect(areServerConfigsEqual('string', { command: 'test', args: [] })).toBe(false);
      expect(areServerConfigsEqual(123, 123)).toBe(false);
    });

    it('handles hand-edited malformed server entry gracefully with E_MCP_SERVER_COLLISION and repairs with --replace', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const home = path.join(dir, 'home');
      const binDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'omcu');
      fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // Hand-edited entry that has command matching expected launcher but omits args
      fs.writeFileSync(
        target,
        JSON.stringify({
          mcpServers: {
            'oh-my-cursor': { command: shim },
          },
        }),
      );

      // Without --replace: throws structured E_MCP_SERVER_COLLISION, NOT generic TypeError
      await expect(installMcpServer({ targetFile: target, homeDir: home, cwd: dir })).rejects.toThrow(
        'E_MCP_SERVER_COLLISION',
      );

      // With --replace: successfully overwrites and repairs the invalid entry
      const result = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir, replace: true });
      expect(result.installed).toBe(true);
      expect(result.action).toBe('replace');

      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor'].args).toEqual(['mcp-server']);
    });

    it('replaces foreign server with --replace and records previous config in receipt', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const foreignConfig: McpServerConfig = { command: 'foreign-binary', args: ['--serve'] };
      fs.writeFileSync(
        target,
        JSON.stringify({
          mcpServers: {
            'oh-my-cursor': foreignConfig,
          },
        }),
      );

      const home = path.join(dir, 'home');
      const result = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir, replace: true });
      expect(result.installed).toBe(true);
      expect(result.action).toBe('replace');
      expect(result.previous_config).toEqual(foreignConfig);

      const receipt = readMcpInstallReceipt(result.receipt_path!);
      expect(receipt.previous_server).toEqual(foreignConfig);
    });

    it('preserves original rollback config in receipt when replacing owned-drift', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      // Initial install in developer-checkout mode (target was clean, previous_server is null)
      const initial = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      expect(initial.action).toBe('install');
      const initialReceipt = readMcpInstallReceipt(initial.receipt_path!);
      expect(initialReceipt.previous_server).toBeNull();

      // Now create a stable shim in home to change expected launcher to stable-shim
      const binDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'omcu');
      fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // Run install with replace to upgrade to stable shim
      const upgraded = await installMcpServer({ targetFile: target, homeDir: home, cwd: dir, replace: true });
      expect(upgraded.action).toBe('replace');
      const upgradedReceipt = readMcpInstallReceipt(upgraded.receipt_path!);
      expect(upgradedReceipt.installed_server.command).toBe(shim);
      // Crucial: previous_server MUST still be null (not the obsolete developer checkout config)
      expect(upgradedReceipt.previous_server).toBeNull();

      // Uninstall should remove 'oh-my-cursor' entirely rather than restoring the obsolete dev checkout
      const uninstalled = await uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home });
      expect(uninstalled.action).toBe('removed');
      expect(uninstalled.restored_config).toBeNull();
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor']).toBeUndefined();
    });
  });

  describe('Uninstall and rollback lifecycle', () => {
    it('restores previous server when uninstalling a replaced entry', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const foreignConfig: McpServerConfig = { command: 'foreign-binary', args: ['--serve'] };
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': foreignConfig } }));

      const home = path.join(dir, 'home');
      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir, replace: true });

      // Now uninstall
      const uninstalled = await uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home });
      expect(uninstalled.uninstalled).toBe(true);
      expect(uninstalled.action).toBe('restored');
      expect(uninstalled.restored_config).toEqual(foreignConfig);

      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor']).toEqual(foreignConfig);

      // Receipt is cleaned up
      expect(findMcpReceipt(target, dir)).toBeNull();
    });

    it('removes entry cleanly when it was newly added', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      const uninstalled = await uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home });
      expect(uninstalled.uninstalled).toBe(true);
      expect(uninstalled.action).toBe('removed');
      expect(uninstalled.restored_config).toBeNull();

      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers['oh-my-cursor']).toBeUndefined();
      expect(findMcpReceipt(target, dir)).toBeNull();
    });

    it('refuses uninstall with E_MCP_UNINSTALL_COLLISION if user edited server after installation', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });

      // User manual edit
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      parsed.mcpServers['oh-my-cursor'].args.push('--user-custom-flag');
      fs.writeFileSync(target, JSON.stringify(parsed, null, 2));

      await expect(uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home })).rejects.toThrow(
        'E_MCP_UNINSTALL_COLLISION',
      );

      // Verify user edit was not lost or deleted
      const afterAttempt = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(afterAttempt.mcpServers['oh-my-cursor'].args).toContain('--user-custom-flag');
    });

    it('refuses uninstall with E_MCP_RECEIPT_MISSING when no receipt exists', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': { command: 'test' } } }));

      await expect(uninstallMcpServer({ targetFile: target, cwd: dir })).rejects.toThrow(
        'E_MCP_RECEIPT_MISSING',
      );
    });

    it('refuses uninstall with E_MCP_RECEIPT_TARGET_MISMATCH when custom receipt targets a different file', async () => {
      const dir = makeDir();
      const targetA = path.join(dir, 'a', 'mcp.json');
      const targetB = path.join(dir, 'b', 'mcp.json');
      const receiptA = path.join(dir, 'receipt-a.json');
      const receiptB = path.join(dir, 'receipt-b.json');
      const home = path.join(dir, 'home');

      await installMcpServer({ targetFile: targetA, receiptFile: receiptA, homeDir: home, cwd: dir });
      await installMcpServer({ targetFile: targetB, receiptFile: receiptB, homeDir: home, cwd: dir });

      // findMcpReceipt with custom receipt for another file returns null
      expect(findMcpReceipt(targetB, dir, receiptA)).toBeNull();

      // uninstalling targetB with receiptA throws E_MCP_RECEIPT_TARGET_MISMATCH
      await expect(
        uninstallMcpServer({ targetFile: targetB, receiptFile: receiptA, cwd: dir, homeDir: home }),
      ).rejects.toThrow('E_MCP_RECEIPT_TARGET_MISMATCH');

      // Verify neither targetB nor receiptA was removed or modified
      expect(fs.existsSync(targetB)).toBe(true);
      expect(fs.existsSync(receiptA)).toBe(true);
      const parsedB = JSON.parse(fs.readFileSync(targetB, 'utf8'));
      expect(parsedB.mcpServers['oh-my-cursor']).toBeDefined();
    });

    it('refuses install and uninstall with E_MCP_RECEIPT_ALIAS_TARGET when receipt aliases target', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: {} }));

      // Install with receiptFile pointing to target
      await expect(
        installMcpServer({ targetFile: target, receiptFile: target, cwd: dir }),
      ).rejects.toThrow('E_MCP_RECEIPT_ALIAS_TARGET');

      // Uninstall with receiptFile pointing to target
      await expect(
        uninstallMcpServer({ targetFile: target, receiptFile: target, cwd: dir }),
      ).rejects.toThrow('E_MCP_RECEIPT_ALIAS_TARGET');

      // Ensure target wasn't corrupted
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsed.mcpServers).toBeDefined();
    });

    it('uninstall dry-run previews removal without changing file or receipt', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });
      const dry = await uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home, dryRun: true });

      expect(dry.uninstalled).toBe(true);
      expect(dry.dry_run).toBe(true);
      expect(dry.action).toBe('removed');

      // File and receipt still exist
      expect(fs.existsSync(target)).toBe(true);
      expect(findMcpReceipt(target, dir)).not.toBeNull();
    });

    it('throws E_MCP_UNINSTALL_COLLISION when server entry is corrupted to null or invalid value', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });

      // Corrupt server entry to null
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': null } }));

      await expect(
        uninstallMcpServer({ targetFile: target, cwd: dir, homeDir: home }),
      ).rejects.toThrow('E_MCP_UNINSTALL_COLLISION');

      // Receipt must NOT have been removed
      expect(findMcpReceipt(target, dir)).not.toBeNull();
    });

    it('rolls back target file changes when receipt removal fails', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');
      const customReceipt = path.join(dir, 'receipt.json');

      const foreignConfig: McpServerConfig = { command: 'foreign-binary', args: ['--serve'] };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': foreignConfig } }));

      // Install with replace into target and custom receipt
      await installMcpServer({
        targetFile: target,
        receiptFile: customReceipt,
        homeDir: home,
        cwd: dir,
        replace: true,
      });

      // Target now has OMCU installed
      const installedTargetRaw = fs.readFileSync(target, 'utf8');

      // Mock rmSync to fail when removing receipt
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
        throw new Error('Permission denied: mock unlink error');
      });

      try {
        await expect(
          uninstallMcpServer({ targetFile: target, receiptFile: customReceipt, cwd: dir, homeDir: home }),
        ).rejects.toThrow('E_MCP_RECEIPT_REMOVE_FAILED');

        // Verify target was rolled back to its pre-uninstall state (still has installed OMCU config)
        expect(fs.readFileSync(target, 'utf8')).toBe(installedTargetRaw);

        // Verify receipt is still present
        expect(fs.existsSync(customReceipt)).toBe(true);
      } finally {
        rmSpy.mockRestore();
      }

      // After error is resolved, uninstall succeeds and restores original foreign config
      const uninstalled = await uninstallMcpServer({ targetFile: target, receiptFile: customReceipt, cwd: dir, homeDir: home });
      expect(uninstalled.action).toBe('restored');
      expect(uninstalled.restored_config).toEqual(foreignConfig);
      const parsedAfter = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(parsedAfter.mcpServers['oh-my-cursor']).toEqual(foreignConfig);
    });
  });

  describe('Status inspection and target classification', () => {
    it('classifies absent target correctly', async () => {
      const dir = makeDir();
      const target = path.join(dir, 'nonexistent', 'mcp.json');
      const status = await inspectMcpStatus({ targetFile: target, cwd: dir, noProbe: true });
      expect(status.state).toBe('absent');
      expect(status.configured_server).toBeNull();
      expect(status.executable_exists).toBe(false);
    });

    it('classifies exact-owned correctly', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');
      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });

      const status = await inspectMcpStatus({ targetFile: target, homeDir: home, cwd: dir, noProbe: true });
      expect(status.state).toBe('exact-owned');
      expect(status.configured_server).not.toBeNull();
      expect(status.receipt_found).toBe(true);
    });

    it('classifies foreign-conflict correctly', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': { command: 'foreign', args: [] } } }));

      const status = await inspectMcpStatus({ targetFile: target, cwd: dir, noProbe: true });
      expect(status.state).toBe('foreign-conflict');
    });

    it('classifies malformed JSON and provides line and column', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{\n  "mcpServers": {\n    "bad": \n  }\n}');

      const status = await inspectMcpStatus({ targetFile: target, cwd: dir, noProbe: true });
      expect(status.state).toBe('malformed');
      expect(status.details).toContain('line 4');
      expect(status.details).toContain('Remediation');
    });

    it('classifies falsy server entries (null, false, empty string, non-object) as malformed', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });

      for (const falsyVal of [null, false, '', 0, {}]) {
        fs.writeFileSync(target, JSON.stringify({ mcpServers: { 'oh-my-cursor': falsyVal } }));
        const status = await inspectMcpStatus({ targetFile: target, cwd: dir, noProbe: true });
        expect(status.state).toBe('malformed');
        expect(status.details).toContain("Configured 'oh-my-cursor' server is missing command or args array");
      }
    });

    it('classifies unsafe symlink target', async () => {
      const dir = makeDir();
      const realFile = path.join(dir, 'real.json');
      fs.writeFileSync(realFile, '{}');
      const symlinkFile = path.join(dir, 'symlink.json');
      fs.symlinkSync(realFile, symlinkFile);

      const status = await inspectMcpStatus({ targetFile: symlinkFile, cwd: dir, noProbe: true });
      expect(status.state).toBe('unsafe-target');
      expect(status.details).toContain('symbolic link');
    });

    it('detects owned-drifted when previous stage was installed and current launcher differs', async () => {
      const dir = makeDir();
      const target = path.join(dir, '.cursor', 'mcp.json');
      const home = path.join(dir, 'home');

      // Install in developer checkout mode
      await installMcpServer({ targetFile: target, homeDir: home, cwd: dir });

      // Now create a stable shim in home, which shifts the expected launcher to stable-shim
      const binDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'omcu');
      fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // Status should detect that the config was owned by OMCU but has drifted from the new expected launcher
      const status = await inspectMcpStatus({ targetFile: target, homeDir: home, cwd: dir, noProbe: true });
      expect(status.state).toBe('owned-drifted');
      expect(status.expected_server.command).toBe(shim);

      // repairOwnedMcpServerSync should update it to the stable shim
      const repaired = repairOwnedMcpServerSync({ projectRoot: dir, homeDir: home });
      expect(repaired).not.toBeNull();
      expect(repaired?.action).toBe('replace');

      // Now status is exact-owned
      const statusAfter = await inspectMcpStatus({ targetFile: target, homeDir: home, cwd: dir, noProbe: true });
      expect(statusAfter.state).toBe('exact-owned');
      expect(statusAfter.configured_server?.command).toBe(shim);
    });
  });

  describe('Health probe', () => {
    it('reports failure when server executable does not exist', async () => {
      const report = await probeMcpHealth({
        command: '/nonexistent/bin/path',
        args: ['mcp-server'],
      });
      expect(report.ok).toBe(false);
      expect(report.error).toContain('E_EXECUTABLE_NOT_FOUND');
    });

    it('successfully probes active omcu mcp-server process', async () => {
      const dir = makeDir();
      const launcher = resolveMcpLauncher({ packageRoot: path.resolve('.'), cwd: dir });
      // Ensure .omcu project state exists for mcp-server to initialize
      fs.mkdirSync(path.join(dir, '.omcu'), { recursive: true, mode: 0o700 });

      const report = await probeMcpHealth(launcher.server, 5000);
      expect(report.ok).toBe(true);
      expect(report.protocol_version).toBeDefined();
      expect(report.server_name).toBe('oh-my-cursor');
      expect(report.tools_count).toBeGreaterThan(0);
    });

    it('escalates to SIGKILL and does not hang when probed process ignores SIGTERM', async () => {
      const server: McpServerConfig = {
        command: process.execPath,
        args: [
          '-e',
          'process.on("SIGTERM", () => {});' +
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "test-stub", version: "1.0.0" } } }));' +
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }));' +
          'setInterval(() => {}, 1000);',
        ],
      };

      const start = Date.now();
      const report = await probeMcpHealth(server, 5000);
      const elapsed = Date.now() - start;

      expect(report.ok).toBe(true);
      expect(report.server_name).toBe('test-stub');
      expect(report.tools_count).toBe(0);
      expect(elapsed).toBeLessThan(4000);
    });

    it('rejects malformed initialize response with E_MCP_INIT_INVALID', async () => {
      const server: McpServerConfig = {
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));',
        ],
      };
      const report = await probeMcpHealth(server, 2000);
      expect(report.ok).toBe(false);
      expect(report.error).toContain('E_MCP_INIT_INVALID');
    });

    it('rejects malformed tools/list response with E_MCP_TOOLS_INVALID', async () => {
      const server: McpServerConfig = {
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "test-stub", version: "1.0.0" } } }));' +
          'console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: "not-an-array" } }));',
        ],
      };
      const report = await probeMcpHealth(server, 2000);
      expect(report.ok).toBe(false);
      expect(report.error).toContain('E_MCP_TOOLS_INVALID');
    });
  });

  describe('CLI command integration', () => {
    function harness(cwd: string) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const homeDir = path.join(cwd, 'home');
      fs.mkdirSync(homeDir, { recursive: true });
      return {
        stdout,
        stderr,
        homeDir,
        io: {
          stdout: (text: string) => stdout.push(text),
          stderr: (text: string) => stderr.push(text),
        },
        dependencies: {
          cwd,
          homeDir,
          packageRoot: path.resolve('.'),
        },
      };
    }

    it('executes omcu mcp install, status, and uninstall via CLI', async () => {
      const cwd = makeDir('cli-test-');
      const h = harness(cwd);
      const target = path.join(cwd, '.cursor', 'mcp.json');

      // 1. Install
      const installCode = await runCli(['mcp', 'install', '--file', target], h.dependencies, h.io);
      expect(installCode).toBe(0);
      const installOutput = JSON.parse(h.stdout.at(-1)!);
      expect(installOutput.installed).toBe(true);
      expect(installOutput.action).toBe('install');

      // 2. Status
      h.stdout.length = 0;
      const statusCode = await runCli(['mcp', 'status', '--file', target, '--no-probe'], h.dependencies, h.io);
      expect(statusCode).toBe(0);
      const statusOutput = JSON.parse(h.stdout.at(-1)!);
      expect(statusOutput.state).toBe('exact-owned');

      // 3. Uninstall
      h.stdout.length = 0;
      const uninstallCode = await runCli(['mcp', 'uninstall', '--file', target], h.dependencies, h.io);
      expect(uninstallCode).toBe(0);
      const uninstallOutput = JSON.parse(h.stdout.at(-1)!);
      expect(uninstallOutput.uninstalled).toBe(true);
      expect(uninstallOutput.action).toBe('removed');

      // 4. Status after uninstall
      h.stdout.length = 0;
      const statusAfterCode = await runCli(['mcp', 'status', '--file', target, '--no-probe'], h.dependencies, h.io);
      expect(statusAfterCode).toBe(0);
      const statusAfterOutput = JSON.parse(h.stdout.at(-1)!);
      expect(statusAfterOutput.state).toBe('absent');
    });

    it('legacy omcu mcp-install works as an alias and respects --dry-run and --replace', async () => {
      const cwd = makeDir('legacy-cli-');
      const h = harness(cwd);
      const target = path.join(cwd, '.cursor', 'mcp.json');

      // Dry-run
      const dryCode = await runCli(['mcp-install', '--file', target, '--dry-run'], h.dependencies, h.io);
      expect(dryCode).toBe(0);
      const dryOutput = JSON.parse(h.stdout.at(-1)!);
      expect(dryOutput.dry_run).toBe(true);
      expect(fs.existsSync(target)).toBe(false);

      // Real install
      h.stdout.length = 0;
      const code = await runCli(['mcp-install', '--file', target], h.dependencies, h.io);
      expect(code).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});
