import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSetupDoctor } from '../../src/setup/doctor.js';
import type { CommandRunner } from '../../src/setup/types.js';

describe('Cursor setup doctor', () => {
  it('uses canonical isolated probes and reports unclaimed config tiers honestly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-doctor-'));
    const calls: readonly string[][] = [];
    const recorded = calls as string[][];
    try {
      fs.mkdirSync(path.join(root, '.cursor-plugin'), { recursive: true });
      fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.omcu'));
      fs.writeFileSync(path.join(root, '.cursor', 'rules', 'oh-my-cursor.mdc'), 'rule');
      fs.writeFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-cursor', version: '1.0.0', rules: './.cursor/rules/',
      }));
      const runner: CommandRunner = {
        async run(command, args, options) {
          recorded.push([command, ...args, options?.env?.HOME ?? '']);
          if (args[0] === '--version') return { code: 0, stdout: '2026.07.20\n', stderr: '' };
          if (args[0] === 'status') return { code: 1, stdout: '', stderr: 'not authenticated' };
          return { code: 0, stdout: '--version --help status --plugin-dir', stderr: '' };
        },
      };
      const report = await runSetupDoctor({ packageRoot: root, projectRoot: root, homeDir: path.join(root, 'home'), runner });
      expect(report.ok).toBe(true);
      expect(report.exit_code).toBe(2);
      expect(report.capability_tier).toBe(1);
      expect(recorded.map((call) => call.slice(0, -1))).toEqual([
        ['cursor-agent', '--version'],
        ['cursor-agent', 'status'],
        ['cursor-agent', '--help'],
        ['cursor-agent', '--plugin-dir', root, '--help'],
      ]);
      expect(report.checks.find((check) => check.id === 'hooks')?.status).toBe('warn');
      expect(report.checks.find((check) => check.id === 'mcp')?.status).toBe('warn');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts official string resource paths and resolves hooks/MCP inside the package root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-doctor-official-'));
    try {
      for (const directory of ['.cursor-plugin', '.cursor/rules', 'hooks']) fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.mkdirSync(path.join(root, '.omcu'));
      fs.writeFileSync(path.join(root, '.cursor', 'rules', 'oh-my-cursor.mdc'), 'rule');
      fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{}');
      fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
      fs.writeFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-cursor',
        version: '1.0.0',
        rules: './.cursor/rules/',
        hooks: './hooks/hooks.json',
        mcpServers: './.mcp.json',
      }));
      const runner: CommandRunner = {
        async run(_command, args) {
          if (args[0] === '--version') return { code: 0, stdout: '2026.07.20\n', stderr: '' };
          if (args[0] === 'status') return { code: 0, stdout: 'authenticated\n', stderr: '' };
          return { code: 0, stdout: '--version --help status --plugin-dir', stderr: '' };
        },
      };
      const report = await runSetupDoctor({ packageRoot: root, projectRoot: root, homeDir: path.join(root, 'home'), runner });
      expect(report.ok).toBe(true);
      expect(report.exit_code).toBe(0);
      expect(report.capability_tier).toBe(3);
      expect(report.checks.find((check) => check.id === 'plugin_dir')).toMatchObject({
        status: 'pass', detail: { activation_proven: false },
      });
      expect(report.checks.find((check) => check.id === 'hooks')).toMatchObject({
        status: 'pass', detail: { path: path.join(root, 'hooks', 'hooks.json') },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects manifest resources that escape the package root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-doctor-escape-'));
    try {
      fs.mkdirSync(path.join(root, '.cursor-plugin'), { recursive: true });
      fs.writeFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({
        name: 'oh-my-cursor', version: '1.0.0', hooks: '../foreign-hooks.json',
      }));
      const runner: CommandRunner = { async run() { return { code: 1, stdout: '', stderr: '' }; } };
      const report = await runSetupDoctor({ packageRoot: root, runner });
      expect(report.ok).toBe(false);
      expect(report.checks[0]).toMatchObject({ id: 'plugin_manifest', status: 'fail' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never reports plugin-dir loadability for a nonexistent package even when --help exits zero', async () => {
    const root = path.join(os.tmpdir(), `omcu-doctor-missing-${process.pid}-${Date.now()}`);
    const runner: CommandRunner = {
      async run(_command, args) {
        if (args[0] === '--version') return { code: 0, stdout: '2026.07.20\n', stderr: '' };
        if (args[0] === 'status') return { code: 0, stdout: 'authenticated\n', stderr: '' };
        return { code: 0, stdout: '--version --help status --plugin-dir', stderr: '' };
      },
    };
    const report = await runSetupDoctor({ packageRoot: root, projectRoot: os.tmpdir(), runner });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'plugin_dir')).toMatchObject({ status: 'fail' });
  });
});
