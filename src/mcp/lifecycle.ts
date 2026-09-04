import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { atomicWriteJson, withDirectoryLock, withDirectoryLockSync } from '../runtime/atomic.js';
import { PACKAGE_VERSION } from '../version.js';

export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export type McpTargetState =
  | 'absent'
  | 'exact-owned'
  | 'owned-drifted'
  | 'foreign-conflict'
  | 'malformed'
  | 'unsafe-target';

export interface McpInstallReceipt {
  readonly store_kind: 'omcu_mcp_install_receipt';
  readonly schema_version: 1;
  readonly target_file: string;
  readonly target_sha256_before: string | null;
  readonly target_sha256_after: string;
  readonly target_mode: number;
  readonly target_dev?: number | undefined;
  readonly target_ino?: number | undefined;
  readonly server_name: 'oh-my-cursor';
  readonly installed_server: McpServerConfig;
  readonly previous_server: McpServerConfig | null;
  readonly launcher_kind: 'stable-shim' | 'developer-checkout';
  readonly managed_updates: boolean;
  readonly omcu_version: string;
  readonly package_root: string;
  readonly created_at: string;
  readonly receipt_sha256: string;
}

export interface McpHealthReport {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly protocol_version?: string | undefined;
  readonly server_name?: string | undefined;
  readonly server_version?: string | undefined;
  readonly tools_count?: number | undefined;
}

export interface McpStatusResult {
  readonly file: string;
  readonly state: McpTargetState;
  readonly configured_server: McpServerConfig | null;
  readonly expected_server: McpServerConfig;
  readonly launcher_kind: 'stable-shim' | 'developer-checkout';
  readonly managed_updates: boolean;
  readonly executable_exists: boolean;
  readonly resolves_to_current_release: boolean;
  readonly receipt_found: boolean;
  readonly receipt_path: string | null;
  readonly health: McpHealthReport | null;
  readonly details?: string | undefined;
}

export interface McpInstallOptions {
  readonly targetFile?: string | undefined;
  readonly receiptFile?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly replace?: boolean | undefined;
  readonly homeDir?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly cwd?: string | undefined;
}

export interface McpInstallResult {
  readonly installed: boolean;
  readonly action: 'install' | 'replace' | 'noop';
  readonly file: string;
  readonly server: 'oh-my-cursor';
  readonly config: McpServerConfig;
  readonly previous_config: McpServerConfig | null;
  readonly launcher_kind: 'stable-shim' | 'developer-checkout';
  readonly managed_updates: boolean;
  readonly receipt_path: string | null;
  readonly dry_run: boolean;
  readonly diff?: {
    readonly before: McpServerConfig | null;
    readonly after: McpServerConfig;
  };
}

export interface McpUninstallOptions {
  readonly targetFile?: string | undefined;
  readonly receiptFile?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly homeDir?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly cwd?: string | undefined;
}

export interface McpUninstallResult {
  readonly uninstalled: boolean;
  readonly action: 'removed' | 'restored' | 'already_absent';
  readonly file: string;
  readonly server: 'oh-my-cursor';
  readonly restored_config: McpServerConfig | null;
  readonly dry_run: boolean;
}

export interface ResolvedLauncher {
  readonly server: McpServerConfig;
  readonly launcher_kind: 'stable-shim' | 'developer-checkout';
  readonly managed_updates: boolean;
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function resolveMcpTargetFile(targetPath?: string, cwd: string = process.cwd()): string {
  if (targetPath !== undefined && targetPath.trim() !== '') {
    return path.resolve(cwd, targetPath);
  }
  return path.join(path.resolve(cwd), '.cursor', 'mcp.json');
}

export function validateMcpTargetSafe(target: string): void {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`E_MCP_TARGET_UNSAFE: Target file cannot be a symbolic link: ${resolved}`);
    }
    if (!stat.isFile()) {
      throw new Error(`E_MCP_TARGET_UNSAFE: Target must be a regular file: ${resolved}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`E_MCP_TARGET_UNSAFE: Target file is not owned by current user (uid ${process.getuid()} vs ${stat.uid}): ${resolved}`);
    }
  } else {
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent)) {
      const parentStat = fs.lstatSync(parent);
      if (parentStat.isSymbolicLink()) {
        throw new Error(`E_MCP_TARGET_UNSAFE: Target parent directory cannot be a symbolic link: ${parent}`);
      }
      if (!parentStat.isDirectory()) {
        throw new Error(`E_MCP_TARGET_UNSAFE: Target parent must be a directory: ${parent}`);
      }
      if (typeof process.getuid === 'function' && parentStat.uid !== process.getuid()) {
        throw new Error(`E_MCP_TARGET_UNSAFE: Target parent directory is not owned by current user: ${parent}`);
      }
    }
  }
}

export function validateTargetAndReceiptDistinct(target: string, receiptPath: string): void {
  const resolvedTarget = path.resolve(target);
  const resolvedReceipt = path.resolve(receiptPath);
  if (resolvedTarget === resolvedReceipt) {
    throw new Error(
      `E_MCP_RECEIPT_ALIAS_TARGET: Receipt file cannot resolve to the same path as target file: ${resolvedReceipt}`,
    );
  }
  if (fs.existsSync(resolvedTarget) && fs.existsSync(resolvedReceipt)) {
    try {
      const statTarget = fs.statSync(resolvedTarget);
      const statReceipt = fs.statSync(resolvedReceipt);
      if (statTarget.dev === statReceipt.dev && statTarget.ino === statReceipt.ino) {
        throw new Error(
          `E_MCP_RECEIPT_ALIAS_TARGET: Receipt file aliases target file via hard link: ${resolvedReceipt}`,
        );
      }
    } catch (err) {
      if ((err as Error).message.startsWith('E_MCP_RECEIPT_ALIAS_TARGET')) {
        throw err;
      }
    }
  }
}

export function resolveMcpReceiptPath(target: string, projectRoot: string, customReceipt?: string): string {
  let resolvedReceipt: string;
  if (customReceipt !== undefined && customReceipt.trim() !== '') {
    resolvedReceipt = path.resolve(projectRoot, customReceipt);
  } else {
    const resolvedTarget = path.resolve(target);
    const resolvedProject = path.resolve(projectRoot);
    const omcuDir = path.join(resolvedProject, '.omcu');
    if (fs.existsSync(omcuDir) && fs.lstatSync(omcuDir).isDirectory()) {
      resolvedReceipt = path.join(omcuDir, 'mcp-install-receipt.json');
    } else {
      resolvedReceipt = path.join(path.dirname(resolvedTarget), '.omcu-mcp-receipt.json');
    }
  }
  validateTargetAndReceiptDistinct(target, resolvedReceipt);
  return resolvedReceipt;
}

export function findMcpReceipt(target: string, projectRoot: string, customReceipt?: string): string | null {
  const resolvedTarget = path.resolve(target);
  if (customReceipt !== undefined && customReceipt.trim() !== '') {
    const resolved = path.resolve(projectRoot, customReceipt);
    if (resolved === resolvedTarget) {
      return null;
    }
    if (!fs.existsSync(resolved)) {
      return null;
    }
    try {
      const receipt = readMcpInstallReceipt(resolved);
      if (path.resolve(receipt.target_file) === resolvedTarget) {
        return resolved;
      }
    } catch {
      // ignore invalid receipt
    }
    return null;
  }
  const resolvedProject = path.resolve(projectRoot);
  const candidates = [
    path.join(resolvedProject, '.omcu', 'mcp-install-receipt.json'),
    path.join(path.dirname(resolvedTarget), '.omcu-mcp-receipt.json'),
    path.join(path.dirname(resolvedTarget), '.cursor', '.omcu-mcp-receipt.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const receipt = readMcpInstallReceipt(candidate);
        if (path.resolve(receipt.target_file) === resolvedTarget) {
          return candidate;
        }
      } catch {
        // continue searching
      }
    }
  }
  return null;
}

export function createMcpInstallReceipt(
  material: Omit<McpInstallReceipt, 'receipt_sha256'>,
): McpInstallReceipt {
  const digest = crypto.createHash('sha256').update(canonical(material)).digest('hex');
  return { ...material, receipt_sha256: digest };
}

export function validateMcpInstallReceipt(value: unknown): McpInstallReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E_MCP_RECEIPT_INVALID: Receipt is not a JSON object');
  }
  const r = value as McpInstallReceipt;
  if (
    r.store_kind !== 'omcu_mcp_install_receipt' ||
    r.schema_version !== 1 ||
    r.server_name !== 'oh-my-cursor' ||
    typeof r.target_file !== 'string' ||
    typeof r.target_sha256_after !== 'string' ||
    !r.installed_server ||
    typeof r.installed_server.command !== 'string' ||
    !Array.isArray(r.installed_server.args) ||
    typeof r.receipt_sha256 !== 'string'
  ) {
    throw new Error('E_MCP_RECEIPT_INVALID: Receipt schema invalid');
  }
  const { receipt_sha256, ...material } = r;
  const expectedDigest = crypto.createHash('sha256').update(canonical(material)).digest('hex');
  if (receipt_sha256 !== expectedDigest) {
    throw new Error('E_MCP_RECEIPT_INVALID: Receipt checksum mismatch');
  }
  return r;
}

export function readMcpInstallReceipt(receiptPath: string): McpInstallReceipt {
  const resolved = path.resolve(receiptPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`E_MCP_RECEIPT_MISSING: Receipt not found at ${resolved}`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('E_MCP_RECEIPT_INVALID: Receipt must be a regular file');
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('E_MCP_RECEIPT_INVALID: Receipt is not valid JSON');
  }
  return validateMcpInstallReceipt(parsed);
}

export function areServerConfigsEqual(
  a: unknown,
  b: unknown,
): boolean {
  if (!a || !b) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const aObj = a as Partial<McpServerConfig>;
  const bObj = b as Partial<McpServerConfig>;
  if (typeof aObj.command !== 'string' || typeof bObj.command !== 'string') return false;
  if (aObj.command !== bObj.command) return false;
  if (!Array.isArray(aObj.args) || !Array.isArray(bObj.args)) return false;
  if (aObj.args.length !== bObj.args.length) return false;
  for (let i = 0; i < aObj.args.length; i++) {
    if (aObj.args[i] !== bObj.args[i]) return false;
  }
  if (aObj.cwd !== bObj.cwd) {
    if (aObj.cwd !== undefined || bObj.cwd !== undefined) return false;
  }
  const aEnv = aObj.env;
  const bEnv = bObj.env;
  if (aEnv !== undefined && (typeof aEnv !== 'object' || aEnv === null || Array.isArray(aEnv))) return false;
  if (bEnv !== undefined && (typeof bEnv !== 'object' || bEnv === null || Array.isArray(bEnv))) return false;
  const aEnvObj = (aEnv ?? {}) as Record<string, unknown>;
  const bEnvObj = (bEnv ?? {}) as Record<string, unknown>;
  const aKeys = Object.keys(aEnvObj).sort();
  const bKeys = Object.keys(bEnvObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i]!;
    if (k !== bKeys[i] || aEnvObj[k] !== bEnvObj[k]) return false;
  }
  return true;
}

export function parseMcpJson(raw: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`E_MCP_CONFIG_INVALID: Root of ${filePath} must be a JSON object; remediation: reset ${filePath} to {"mcpServers":{}}`);
    }
    if (parsed.mcpServers !== undefined && (parsed.mcpServers === null || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers))) {
      throw new Error(`E_MCP_SERVERS_INVALID: Field 'mcpServers' in ${filePath} must be an object; remediation: set "mcpServers": {}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E_MCP_')) {
      throw error;
    }
    const syntaxErr = error as SyntaxError;
    const { line, column } = computeJsonErrorLocation(raw, syntaxErr.message);
    throw new Error(`E_MCP_CONFIG_INVALID: Malformed JSON in ${filePath} at line ${line}, column ${column}: ${syntaxErr.message}. Remediation: verify JSON syntax or restore from backup.`);
  }
}

function computeJsonErrorLocation(raw: string, errorMessage: string): { line: number; column: number } {
  const lineColMatch = /line (\d+) column (\d+)/i.exec(errorMessage);
  if (lineColMatch) {
    return { line: Number(lineColMatch[1]), column: Number(lineColMatch[2]) };
  }
  const posMatch = /position (\d+)/i.exec(errorMessage);
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), raw.length);
    const lines = raw.slice(0, pos).split('\n');
    return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
  }

  const tokenMatch = /Unexpected token '?([^'\s]+)'?/i.exec(errorMessage);
  if (tokenMatch && tokenMatch[1]) {
    const token = tokenMatch[1];
    for (let i = 0; i < raw.length; i++) {
      if (raw.startsWith(token, i)) {
        try {
          JSON.parse(raw.slice(0, i + token.length));
        } catch (e) {
          const msg = (e as Error).message;
          if (!msg.includes('end of JSON') && !msg.includes('Unexpected end')) {
            const lines = raw.slice(0, i).split('\n');
            return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
          }
        }
      }
    }
  }

  return { line: 1, column: 1 };
}

export function resolveMcpLauncher(options: {
  homeDir?: string | undefined;
  packageRoot?: string | undefined;
  cwd?: string | undefined;
}): ResolvedLauncher {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const shimPath = path.join(home, '.local', 'bin', 'omcu');

  if (fs.existsSync(shimPath)) {
    return {
      server: {
        command: shimPath,
        args: ['mcp-server'],
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      launcher_kind: 'stable-shim',
      managed_updates: true,
    };
  }

  const pkgRoot = path.resolve(options.packageRoot ?? process.cwd());
  const entrypoint = path.join(pkgRoot, 'dist', 'bin', 'omcu.js');
  return {
    server: {
      command: process.execPath,
      args: [entrypoint, 'mcp-server'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    launcher_kind: 'developer-checkout',
    managed_updates: false,
  };
}

function checkExecutableExists(server: McpServerConfig): boolean {
  if (server.command === process.execPath || server.command === 'node') {
    const script = server.args[0];
    if (typeof script === 'string' && (script.startsWith('-') || fs.existsSync(script))) {
      return true;
    }
    return false;
  }
  return fs.existsSync(server.command);
}

function checkResolvesToCurrentRelease(
  server: McpServerConfig,
  packageRoot: string,
  homeDir: string,
): boolean {
  const shimPath = path.join(homeDir, '.local', 'bin', 'omcu');
  if (server.command === shimPath && fs.existsSync(shimPath)) {
    try {
      const real = fs.realpathSync(shimPath);
      const expectedDist = path.join(packageRoot, 'dist', 'bin', 'omcu.js');
      if (real === expectedDist) return true;
      const realPkg = path.resolve(path.dirname(real), '../..');
      const manifestPath = path.join(realPkg, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: string };
        return pkg.version === PACKAGE_VERSION;
      }
    } catch {
      return false;
    }
  }
  if (server.command === process.execPath) {
    const script = server.args[0];
    if (typeof script === 'string') {
      const expectedDist = path.join(packageRoot, 'dist', 'bin', 'omcu.js');
      return path.resolve(script) === path.resolve(expectedDist);
    }
  }
  return false;
}

export async function probeMcpHealth(
  server: McpServerConfig,
  timeoutMs = 3000,
): Promise<McpHealthReport> {
  const execExists = checkExecutableExists(server);
  if (!execExists) {
    return { ok: false, error: 'E_EXECUTABLE_NOT_FOUND: Configured server executable does not exist' };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    let rl: readline.Interface | null = null;

    const terminateChild = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (rl) {
        try {
          rl.close();
        } catch {
          // ignore
        }
        rl = null;
      }
      if (!child) return;

      const proc = child;
      try {
        proc.stdin?.end();
        proc.stdin?.destroy();
      } catch {}
      try {
        proc.stdout?.destroy();
      } catch {}
      try {
        proc.stderr?.destroy();
      } catch {}

      if (proc.exitCode !== null || proc.signalCode !== null) {
        try {
          proc.unref();
        } catch {}
        return;
      }

      await new Promise<void>((done) => {
        let doneCalled = false;
        const markDone = () => {
          if (doneCalled) return;
          doneCalled = true;
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
          try {
            proc.unref();
          } catch {}
          done();
        };

        proc.once('close', markDone);
        proc.once('exit', markDone);

        try {
          proc.kill('SIGTERM');
        } catch {
          markDone();
          return;
        }

        forceKillTimer = setTimeout(() => {
          try {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill('SIGKILL');
            }
          } catch {}
          markDone();
        }, 500);
        if (typeof forceKillTimer.unref === 'function') {
          forceKillTimer.unref();
        }
      });
      try {
        proc.unref();
      } catch {}
    };

    const finish = async (report: McpHealthReport) => {
      if (resolved) return;
      resolved = true;
      await terminateChild();
      resolve(report);
    };

    timer = setTimeout(() => {
      void finish({ ok: false, error: 'E_MCP_PROBE_TIMEOUT: Timed out waiting for MCP server response' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    try {
      child = spawn(server.command, [...server.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: server.cwd ?? process.cwd(),
        env: { ...process.env, ...(server.env ?? {}) },
      });

      child.on('error', (err) => {
        void finish({ ok: false, error: `E_MCP_PROBE_SPAWN_FAILED: ${err.message}` });
      });

      if (!child.stdout || !child.stdin) {
        void finish({ ok: false, error: 'E_MCP_PROBE_FAILED: Child process stdio not available' });
        return;
      }
      const childStdin = child.stdin;
      const childStdout = child.stdout;

      rl = readline.createInterface({ input: childStdout, terminal: false });
      let stage: 'waiting_init' | 'waiting_tools' | 'done' = 'waiting_init';
      let protocolVersion: string | undefined;
      let serverName: string | undefined;
      let serverVersion: string | undefined;

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);
          if (stage === 'waiting_init' && msg.id === 1) {
            if (msg.error) {
              void finish({ ok: false, error: `E_MCP_INIT_FAILED: ${msg.error.message}` });
              return;
            }
            if (typeof msg.result !== 'object' || msg.result === null) {
              void finish({ ok: false, error: 'E_MCP_INIT_INVALID: Missing or invalid result in initialize response' });
              return;
            }
            protocolVersion = msg.result.protocolVersion;
            serverName = msg.result.serverInfo?.name;
            serverVersion = msg.result.serverInfo?.version;
            if (typeof protocolVersion !== 'string' || typeof serverName !== 'string') {
              void finish({
                ok: false,
                error: 'E_MCP_INIT_INVALID: Response for initialize must include protocolVersion and serverInfo.name',
              });
              return;
            }
            stage = 'waiting_tools';
            childStdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (stage === 'waiting_tools' && msg.id === 2) {
            if (msg.error) {
              void finish({ ok: false, error: `E_MCP_TOOLS_FAILED: ${msg.error.message}` });
              return;
            }
            if (typeof msg.result !== 'object' || msg.result === null || !Array.isArray(msg.result.tools)) {
              void finish({
                ok: false,
                error: 'E_MCP_TOOLS_INVALID: Response for tools/list must contain a tools array',
              });
              return;
            }
            const tools = msg.result.tools;
            stage = 'done';
            void finish({
              ok: true,
              protocol_version: protocolVersion,
              server_name: serverName,
              server_version: serverVersion,
              tools_count: tools.length,
            });
          }
        } catch {
          // ignore non-json lines
        }
      });

      childStdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'omcu-health-probe', version: PACKAGE_VERSION },
        },
      }) + '\n');
    } catch (err) {
      void finish({ ok: false, error: `E_MCP_PROBE_FAILED: ${(err as Error).message}` });
    }
  });
}

export async function inspectMcpStatus(options: {
  targetFile?: string | undefined;
  receiptFile?: string | undefined;
  cwd?: string | undefined;
  homeDir?: string | undefined;
  packageRoot?: string | undefined;
  noProbe?: boolean | undefined;
}): Promise<McpStatusResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = resolveMcpTargetFile(options.targetFile, cwd);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const pkgRoot = path.resolve(options.packageRoot ?? process.cwd());
  const expectedLauncher = resolveMcpLauncher({ homeDir: home, packageRoot: pkgRoot, cwd });
  const receiptPath = findMcpReceipt(target, cwd, options.receiptFile);
  let receipt: McpInstallReceipt | null = null;
  if (receiptPath) {
    try {
      receipt = readMcpInstallReceipt(receiptPath);
    } catch {
      // invalid receipt
    }
  }

  if (fs.existsSync(target)) {
    try {
      validateMcpTargetSafe(target);
    } catch (error) {
      return {
        file: target,
        state: 'unsafe-target',
        configured_server: null,
        expected_server: expectedLauncher.server,
        launcher_kind: expectedLauncher.launcher_kind,
        managed_updates: expectedLauncher.managed_updates,
        executable_exists: false,
        resolves_to_current_release: false,
        receipt_found: receipt !== null,
        receipt_path: receiptPath,
        health: null,
        details: (error as Error).message,
      };
    }
  }

  if (!fs.existsSync(target)) {
    return {
      file: target,
      state: 'absent',
      configured_server: null,
      expected_server: expectedLauncher.server,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      executable_exists: false,
      resolves_to_current_release: false,
      receipt_found: receipt !== null,
      receipt_path: receiptPath,
      health: null,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(target, 'utf8');
    parsed = parseMcpJson(raw, target);
  } catch (error) {
    return {
      file: target,
      state: 'malformed',
      configured_server: null,
      expected_server: expectedLauncher.server,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      executable_exists: false,
      resolves_to_current_release: false,
      receipt_found: receipt !== null,
      receipt_path: receiptPath,
      health: null,
      details: (error as Error).message,
    };
  }

  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  const configured = (servers?.['oh-my-cursor'] ?? null) as McpServerConfig | null;

  if (!configured) {
    return {
      file: target,
      state: 'absent',
      configured_server: null,
      expected_server: expectedLauncher.server,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      executable_exists: false,
      resolves_to_current_release: false,
      receipt_found: receipt !== null,
      receipt_path: receiptPath,
      health: null,
    };
  }

  if (typeof configured !== 'object' || typeof configured.command !== 'string' || !Array.isArray(configured.args)) {
    return {
      file: target,
      state: 'malformed',
      configured_server: null,
      expected_server: expectedLauncher.server,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      executable_exists: false,
      resolves_to_current_release: false,
      receipt_found: receipt !== null,
      receipt_path: receiptPath,
      health: null,
      details: "Configured 'oh-my-cursor' server is missing command or args array",
    };
  }

  const execExists = checkExecutableExists(configured);
  const resolvesCurrent = checkResolvesToCurrentRelease(configured, pkgRoot, home);

  let state: McpTargetState;
  if (areServerConfigsEqual(configured, expectedLauncher.server)) {
    state = 'exact-owned';
  } else if (receipt && areServerConfigsEqual(configured, receipt.installed_server)) {
    state = 'owned-drifted';
  } else {
    state = 'foreign-conflict';
  }

  let health: McpHealthReport | null = null;
  if (options.noProbe !== true) {
    health = await probeMcpHealth(configured);
  }

  return {
    file: target,
    state,
    configured_server: configured,
    expected_server: expectedLauncher.server,
    launcher_kind: expectedLauncher.launcher_kind,
    managed_updates: expectedLauncher.managed_updates,
    executable_exists: execExists,
    resolves_to_current_release: resolvesCurrent,
    receipt_found: receipt !== null,
    receipt_path: receiptPath,
    health,
  };
}

export async function installMcpServer(options: McpInstallOptions = {}): Promise<McpInstallResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = resolveMcpTargetFile(options.targetFile, cwd);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const pkgRoot = path.resolve(options.packageRoot ?? process.cwd());
  const expectedLauncher = resolveMcpLauncher({ homeDir: home, packageRoot: pkgRoot, cwd });
  const receiptPath = resolveMcpReceiptPath(target, cwd, options.receiptFile);
  validateTargetAndReceiptDistinct(target, receiptPath);
  const targetDir = path.dirname(target);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  }

  return withDirectoryLock(target, async () => {
    let beforeSha256: string | null = null;
    let existingMode = 0o644;
    let targetStat: fs.Stats | null = null;
    let parsed: Record<string, unknown> = {};

    if (fs.existsSync(target)) {
      validateMcpTargetSafe(target);
      targetStat = fs.lstatSync(target);
      existingMode = targetStat.mode & 0o777;
      const raw = fs.readFileSync(target, 'utf8');
      beforeSha256 = sha256(raw);
      parsed = parseMcpJson(raw, target);
    }

    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
    const currentServer = servers['oh-my-cursor'] as McpServerConfig | undefined;
    const existingReceiptPath = findMcpReceipt(target, cwd, options.receiptFile);

    if (currentServer && areServerConfigsEqual(currentServer, expectedLauncher.server)) {
      return {
        installed: true,
        action: 'noop',
        file: target,
        server: 'oh-my-cursor',
        config: expectedLauncher.server,
        previous_config: null,
        launcher_kind: expectedLauncher.launcher_kind,
        managed_updates: expectedLauncher.managed_updates,
        receipt_path: existingReceiptPath,
        dry_run: options.dryRun === true,
      };
    }

    let action: 'install' | 'replace';
    let previousConfig: McpServerConfig | null = null;
    if (currentServer !== undefined) {
      if (options.replace !== true) {
        throw new Error(
          `E_MCP_SERVER_COLLISION: Server 'oh-my-cursor' is already configured in ${target} with a different configuration. Use --replace to overwrite and preserve rollback receipt.`,
        );
      }
      action = 'replace';
      previousConfig = currentServer;
    } else {
      action = 'install';
    }

    if (options.dryRun === true) {
      return {
        installed: true,
        action,
        file: target,
        server: 'oh-my-cursor',
        config: expectedLauncher.server,
        previous_config: previousConfig,
        launcher_kind: expectedLauncher.launcher_kind,
        managed_updates: expectedLauncher.managed_updates,
        receipt_path: null,
        dry_run: true,
        diff: {
          before: previousConfig,
          after: expectedLauncher.server,
        },
      };
    }

    if (fs.existsSync(target)) {
      const currentRaw = fs.readFileSync(target, 'utf8');
      if (sha256(currentRaw) !== beforeSha256) {
        throw new Error('E_MCP_TARGET_CHANGED: Target file changed concurrently');
      }
    }

    const nextServers = { ...servers, 'oh-my-cursor': expectedLauncher.server };
    const nextConfig = { ...parsed, mcpServers: nextServers };

    atomicWriteJson(target, nextConfig, { mode: existingMode });
    const afterRaw = fs.readFileSync(target, 'utf8');
    const afterSha256 = sha256(afterRaw);
    const updatedStat = fs.lstatSync(target);

    const receiptPath = resolveMcpReceiptPath(target, cwd, options.receiptFile);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o755 });

    const receipt = createMcpInstallReceipt({
      store_kind: 'omcu_mcp_install_receipt',
      schema_version: 1,
      target_file: target,
      target_sha256_before: beforeSha256,
      target_sha256_after: afterSha256,
      target_mode: updatedStat.mode & 0o777,
      target_dev: updatedStat.dev,
      target_ino: updatedStat.ino,
      server_name: 'oh-my-cursor',
      installed_server: expectedLauncher.server,
      previous_server: previousConfig,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      omcu_version: PACKAGE_VERSION,
      package_root: pkgRoot,
      created_at: new Date().toISOString(),
    });

    atomicWriteJson(receiptPath, receipt, { mode: 0o600 });

    return {
      installed: true,
      action,
      file: target,
      server: 'oh-my-cursor',
      config: expectedLauncher.server,
      previous_config: previousConfig,
      launcher_kind: expectedLauncher.launcher_kind,
      managed_updates: expectedLauncher.managed_updates,
      receipt_path: receiptPath,
      dry_run: false,
    };
  });
}

export async function uninstallMcpServer(options: McpUninstallOptions = {}): Promise<McpUninstallResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = resolveMcpTargetFile(options.targetFile, cwd);

  if (options.receiptFile !== undefined && options.receiptFile.trim() !== '') {
    validateTargetAndReceiptDistinct(target, path.resolve(cwd, options.receiptFile));
  }

  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  }

  return withDirectoryLock(target, async () => {
    if (options.receiptFile !== undefined && options.receiptFile.trim() !== '') {
      const explicitReceiptPath = path.resolve(cwd, options.receiptFile);
      if (!fs.existsSync(explicitReceiptPath)) {
        throw new Error(`E_MCP_RECEIPT_MISSING: Specified receipt file not found: ${explicitReceiptPath}`);
      }
      const explicitReceipt = readMcpInstallReceipt(explicitReceiptPath);
      if (path.resolve(explicitReceipt.target_file) !== target) {
        throw new Error(
          `E_MCP_RECEIPT_TARGET_MISMATCH: Receipt recorded target '${explicitReceipt.target_file}' does not match target '${target}'`,
        );
      }
    }

    const receiptPath = findMcpReceipt(target, cwd, options.receiptFile);
    if (!receiptPath) {
      throw new Error(`E_MCP_RECEIPT_MISSING: No install receipt found for ${target}`);
    }
    const receipt = readMcpInstallReceipt(receiptPath);
    if (path.resolve(receipt.target_file) !== target) {
      throw new Error(
        `E_MCP_RECEIPT_TARGET_MISMATCH: Receipt recorded target '${receipt.target_file}' does not match target '${target}'`,
      );
    }

    if (!fs.existsSync(target)) {
      if (options.dryRun !== true) {
        fs.rmSync(receiptPath, { force: true });
      }
      return {
        uninstalled: true,
        action: 'already_absent',
        file: target,
        server: 'oh-my-cursor',
        restored_config: null,
        dry_run: options.dryRun === true,
      };
    }

    validateMcpTargetSafe(target);
    const raw = fs.readFileSync(target, 'utf8');
    const beforeSha256 = sha256(raw);
    const parsed = parseMcpJson(raw, target);
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
    const currentServer = servers['oh-my-cursor'] as McpServerConfig | undefined;

    if (!currentServer) {
      if (options.dryRun !== true) {
        fs.rmSync(receiptPath, { force: true });
      }
      return {
        uninstalled: true,
        action: 'already_absent',
        file: target,
        server: 'oh-my-cursor',
        restored_config: null,
        dry_run: options.dryRun === true,
      };
    }

    if (!areServerConfigsEqual(currentServer, receipt.installed_server)) {
      throw new Error(
        `E_MCP_UNINSTALL_COLLISION: Server 'oh-my-cursor' in ${target} was modified since installation; refusing to remove or overwrite`,
      );
    }

    let action: 'removed' | 'restored';
    let restoredConfig: McpServerConfig | null = null;
    let nextServers: Record<string, unknown>;

    if (receipt.previous_server !== null) {
      action = 'restored';
      restoredConfig = receipt.previous_server;
      nextServers = { ...servers, 'oh-my-cursor': receipt.previous_server };
    } else {
      action = 'removed';
      restoredConfig = null;
      nextServers = { ...servers };
      delete nextServers['oh-my-cursor'];
    }

    if (options.dryRun === true) {
      return {
        uninstalled: true,
        action,
        file: target,
        server: 'oh-my-cursor',
        restored_config: restoredConfig,
        dry_run: true,
      };
    }

    if (sha256(fs.readFileSync(target, 'utf8')) !== beforeSha256) {
      throw new Error('E_MCP_TARGET_CHANGED: Target file changed concurrently');
    }

    const nextConfig = { ...parsed, mcpServers: nextServers };
    const stat = fs.lstatSync(target);
    atomicWriteJson(target, nextConfig, { mode: stat.mode & 0o777 });

    fs.rmSync(receiptPath, { force: true });

    return {
      uninstalled: true,
      action,
      file: target,
      server: 'oh-my-cursor',
      restored_config: restoredConfig,
      dry_run: false,
    };
  });
}

export function repairOwnedMcpServerSync(options: {
  projectRoot: string;
  homeDir?: string | undefined;
  packageRoot?: string | undefined;
}): McpInstallResult | null {
  const target = path.join(options.projectRoot, '.cursor', 'mcp.json');
  if (!fs.existsSync(target)) return null;

  const cwd = path.resolve(options.projectRoot);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const pkgRoot = path.resolve(options.packageRoot ?? process.cwd());
  const receiptPath = findMcpReceipt(target, cwd);
  if (!receiptPath) return null;

  try {
    const receipt = readMcpInstallReceipt(receiptPath);
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = parseMcpJson(raw, target);
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
    const current = servers['oh-my-cursor'] as McpServerConfig | undefined;
    if (!current) return null;

    const expectedLauncher = resolveMcpLauncher({ homeDir: home, packageRoot: pkgRoot, cwd });
    if (areServerConfigsEqual(current, expectedLauncher.server)) return null;

    if (areServerConfigsEqual(current, receipt.installed_server)) {
      return withDirectoryLockSync(target, () => {
        const nextServers = { ...servers, 'oh-my-cursor': expectedLauncher.server };
        const nextConfig = { ...parsed, mcpServers: nextServers };
        const stat = fs.lstatSync(target);
        atomicWriteJson(target, nextConfig, { mode: stat.mode & 0o777 });
        const afterSha256 = sha256(fs.readFileSync(target, 'utf8'));
        const updatedStat = fs.lstatSync(target);

        const updatedReceipt = createMcpInstallReceipt({
          store_kind: 'omcu_mcp_install_receipt',
          schema_version: 1,
          target_file: target,
          target_sha256_before: receipt.target_sha256_after,
          target_sha256_after: afterSha256,
          target_mode: updatedStat.mode & 0o777,
          target_dev: updatedStat.dev,
          target_ino: updatedStat.ino,
          server_name: 'oh-my-cursor',
          installed_server: expectedLauncher.server,
          previous_server: receipt.previous_server,
          launcher_kind: expectedLauncher.launcher_kind,
          managed_updates: expectedLauncher.managed_updates,
          omcu_version: PACKAGE_VERSION,
          package_root: pkgRoot,
          created_at: new Date().toISOString(),
        });
        atomicWriteJson(receiptPath, updatedReceipt, { mode: 0o600 });

        return {
          installed: true,
          action: 'replace',
          file: target,
          server: 'oh-my-cursor',
          config: expectedLauncher.server,
          previous_config: current,
          launcher_kind: expectedLauncher.launcher_kind,
          managed_updates: expectedLauncher.managed_updates,
          receipt_path: receiptPath,
          dry_run: false,
        };
      });
    }
  } catch {
    return null;
  }
  return null;
}

export async function repairOwnedMcpServer(options: {
  projectRoot: string;
  homeDir?: string | undefined;
  packageRoot?: string | undefined;
}): Promise<McpInstallResult | null> {
  return repairOwnedMcpServerSync(options);
}
