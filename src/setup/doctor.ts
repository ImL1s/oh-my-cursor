import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCommandRunner } from './runner.js';
import type { CommandRunner, SetupCheck } from './types.js';

export interface DoctorInput {
  readonly packageRoot: string;
  readonly projectRoot?: string;
  readonly homeDir?: string;
  readonly cursorCommand?: string;
  readonly runner?: CommandRunner;
}

export interface DoctorReport {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly exit_code: 0 | 1 | 2;
  readonly capability_tier: 0 | 1 | 2 | 3;
  readonly checks: readonly SetupCheck[];
}

function fileCheck(id: string, file: string, absent: SetupCheck['status']): SetupCheck {
  return fs.existsSync(file)
    ? { id, status: 'pass', message: `${path.basename(file)} present`, detail: { path: file } }
    : { id, status: absent, message: `${path.basename(file)} absent`, detail: { path: file } };
}

interface PluginInspection {
  readonly check: SetupCheck;
  readonly resources: Readonly<Record<'rules' | 'hooks' | 'mcpServers', readonly string[]>>;
}

function withinPackage(root: string, declared: string): string {
  if (declared.includes('\0') || path.isAbsolute(declared)) throw new Error('manifest path is not package-relative');
  const target = path.resolve(root, declared);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('manifest path escapes package root');
  return target;
}

function resourceValues(value: unknown, field: string): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[];
  if (value === undefined) return [];
  throw new Error(`${field} must be a package-relative string or string array`);
}

function pluginManifest(root: string): PluginInspection {
  const manifest = path.join(root, '.cursor-plugin', 'plugin.json');
  const empty = { rules: [], hooks: [], mcpServers: [] } as const;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (parsed.name !== 'oh-my-cursor' || typeof parsed.version !== 'string') {
      return { check: { id: 'plugin_manifest', status: 'fail', message: 'Cursor plugin manifest fields are invalid' }, resources: empty };
    }
    const resourceFields = ['commands', 'agents', 'skills', 'rules', 'hooks', 'mcpServers'] as const;
    const resolved = Object.fromEntries(resourceFields.map((field) => {
      const values = resourceValues(parsed[field], field).map((declared) => withinPackage(root, declared));
      for (const target of values) {
        if (!fs.existsSync(target)) throw new Error(`${field} references a missing package resource`);
      }
      return [field, values];
    })) as Record<(typeof resourceFields)[number], string[]>;
    return {
      check: { id: 'plugin_manifest', status: 'pass', message: `oh-my-cursor plugin v${parsed.version} is structurally loadable` },
      resources: { rules: resolved.rules, hooks: resolved.hooks, mcpServers: resolved.mcpServers },
    };
  } catch (error) {
    return {
      check: { id: 'plugin_manifest', status: 'fail', message: 'Cursor plugin manifest is unreadable or unsafe', detail: String(error) },
      resources: empty,
    };
  }
}

function configTier(root: string, projectRoot: string, resources: PluginInspection['resources']): { checks: SetupCheck[]; tier: 0 | 1 | 2 | 3 } {
  const checks: SetupCheck[] = [];
  const ruleCandidates = [...resources.rules, path.join(root, '.cursor', 'rules', 'oh-my-cursor.mdc')];
  const rule = ruleCandidates.find((candidate) => fs.existsSync(candidate));
  checks.push(rule === undefined
    ? { id: 'rules', status: 'warn', message: 'No project/plugin rules configuration is claimed' }
    : { id: 'rules', status: 'pass', message: 'Rules configuration is present', detail: { path: rule } });
  const hookCandidates = [...resources.hooks, path.join(root, '.cursor', 'hooks.json'), path.join(root, 'hooks.json')];
  const hook = hookCandidates.find((candidate) => fs.existsSync(candidate));
  checks.push(hook === undefined
    ? { id: 'hooks', status: 'warn', message: 'No project/plugin hooks configuration is claimed' }
    : { id: 'hooks', status: 'pass', message: 'Hooks configuration is present', detail: { path: hook } });
  const mcpCandidates = [...resources.mcpServers, path.join(root, '.cursor', 'mcp.json'), path.join(root, '.mcp.json'), path.join(projectRoot, '.cursor', 'mcp.json')];
  const mcp = mcpCandidates.find((candidate) => fs.existsSync(candidate));
  checks.push(mcp === undefined
    ? { id: 'mcp', status: 'warn', message: 'No MCP configuration is claimed' }
    : { id: 'mcp', status: 'pass', message: 'MCP configuration is present', detail: { path: mcp } });
  const tier: 0 | 1 | 2 | 3 = rule === undefined ? 0 : hook === undefined ? 1 : mcp === undefined ? 2 : 3;
  return { checks, tier };
}

export async function runSetupDoctor(input: DoctorInput): Promise<DoctorReport> {
  const root = path.resolve(input.packageRoot);
  const projectRoot = path.resolve(input.projectRoot ?? root);
  const homeDir = path.resolve(input.homeDir ?? os.homedir());
  const runner = input.runner ?? defaultCommandRunner;
  const command = input.cursorCommand ?? 'cursor-agent';
  const env = { ...process.env, HOME: homeDir };
  const manifest = pluginManifest(root);
  const checks: SetupCheck[] = [manifest.check];

  const version = await runner.run(command, ['--version'], { cwd: projectRoot, env });
  checks.push(version.code === 0 && version.stdout.trim() !== ''
    ? { id: 'cursor_version', status: 'pass', message: `cursor-agent ${version.stdout.trim()}` }
    : { id: 'cursor_version', status: 'fail', message: 'cursor-agent canonical --version probe failed', detail: { code: version.code } });

  const status = await runner.run(command, ['status'], { cwd: projectRoot, env });
  checks.push(status.code === 0
    ? { id: 'cursor_status', status: 'pass', message: 'cursor-agent status reports authenticated/reachable' }
    : { id: 'cursor_status', status: 'warn', message: 'cursor-agent is reachable but status is not ready/authenticated', detail: { code: status.code } });

  const help = await runner.run(command, ['--help'], { cwd: projectRoot, env });
  const helpSurface = ['--version', '--help', 'status'].every((needle) => `${help.stdout}\n${help.stderr}`.includes(needle));
  checks.push(help.code === 0 && helpSurface
    ? { id: 'cursor_help', status: 'pass', message: 'cursor-agent help exposes canonical version/help/status surface' }
    : { id: 'cursor_help', status: 'fail', message: 'cursor-agent help is missing canonical surfaces' });

  const plugin = await runner.run(command, ['--plugin-dir', root, '--help'], { cwd: projectRoot, env });
  if (manifest.check.status === 'fail') {
    checks.push({ id: 'plugin_dir', status: 'fail', message: 'Plugin directory cannot be considered loadable because its manifest is invalid' });
  } else if (plugin.code === 0) {
    checks.push({
      id: 'plugin_dir',
      status: 'warn',
      message: 'cursor-agent accepts --plugin-dir, but --help does not prove runtime plugin activation',
      detail: { code: plugin.code, activation_proven: false },
    });
  } else {
    checks.push({ id: 'plugin_dir', status: 'fail', message: 'cursor-agent rejected the --plugin-dir invocation', detail: { code: plugin.code } });
  }

  const tiers = configTier(root, projectRoot, manifest.resources);
  checks.push(...tiers.checks);
  checks.push(fileCheck('project_state', path.join(projectRoot, '.omcu'), 'warn'));

  const hasFail = checks.some((check) => check.status === 'fail');
  const hasWarn = checks.some((check) => check.status === 'warn');
  return {
    schema_version: 1,
    ok: !hasFail,
    exit_code: hasFail ? 1 : hasWarn ? 2 : 0,
    capability_tier: tiers.tier,
    checks,
  };
}
