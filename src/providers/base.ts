import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CustomProcessRunner,
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderExecutionResult,
  ProviderId,
  ProviderReadiness,
} from './types.js';

export const STANDARD_SAFE_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
];

export const COMMON_DANGEROUS_FLAGS: readonly string[] = [
  '--madmax',
  '--yolo',
  '--dangerously-skip-permissions',
  '--no-sandbox',
  '--privileged',
  '-rf',
  '--rm',
  '--eval',
  '--exec',
];

export function findBinaryInPath(binary: string): string | null {
  if (path.isAbsolute(binary)) {
    return fs.existsSync(binary) ? binary : null;
  }
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not executable
      }
    }
  }
  return null;
}

export const BLOCKED_INJECTED_ENV: ReadonlySet<string> = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
]);

const SAFE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function filterAllowlistedEnv(
  ambient: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  extra?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const result: Record<string, string> = {};
  const fullAllowlist = new Set([...STANDARD_SAFE_ENV, ...allowlist]);

  for (const key of fullAllowlist) {
    if (ambient[key] !== undefined) {
      result[key] = ambient[key]!;
    }
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!BLOCKED_INJECTED_ENV.has(key) && SAFE_ENV_NAME_PATTERN.test(key)) {
        result[key] = value;
      }
    }
  }

  return result;
}

export function validateSafeArgs(
  args: readonly string[],
  dangerousFlags: readonly string[] = COMMON_DANGEROUS_FLAGS
): void {
  for (const arg of args) {
    for (const dangerous of dangerousFlags) {
      if (arg === dangerous || arg.startsWith(`${dangerous}=`)) {
        throw new Error(`E_DANGEROUS_FLAG_REJECTED: prohibited flag '${dangerous}' is not permitted`);
      }
    }
  }
}

export const defaultProcessRunner: CustomProcessRunner = (
  executable,
  args,
  options
) =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const child = spawn(executable, [...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
        reject(new Error(`E_PROCESS_TIMEOUT: execution exceeded ${timeoutMs}ms`));
      }
    }, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 500).unref();
          reject(new Error('E_ABORTED: execution cancelled by signal'));
        }
      });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      }
    });
  });

export abstract class BaseCliProviderAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;
  abstract readonly isCanonical: boolean;
  abstract readonly defaultBinary: string;
  readonly candidateBinaries: readonly string[] = [];
  abstract readonly envAllowlist: readonly string[];
  abstract readonly supportedModels: readonly string[];

  readonly dangerousFlags: readonly string[] = COMMON_DANGEROUS_FLAGS;

  abstract buildExecutionArgs(prompt: string, model?: string): readonly string[];

  resolveBinaryPath(customBinary?: string): string | null {
    if (customBinary) {
      return customBinary;
    }
    const candidates = this.candidateBinaries.length > 0 ? this.candidateBinaries : [this.defaultBinary];
    for (const bin of candidates) {
      const found = findBinaryInPath(bin);
      if (found) return found;
    }
    return null;
  }

  protected checkAuthStatus(
    _env: NodeJS.ProcessEnv,
    _binaryPath: string
  ): 'authenticated' | 'unauthenticated' | 'unknown' {
    return 'unknown';
  }

  async probe(cwd?: string, runner: CustomProcessRunner = defaultProcessRunner): Promise<ProviderReadiness> {
    const binary = this.resolveBinaryPath();
    if (!binary) {
      const candidates = this.candidateBinaries.length > 0 ? this.candidateBinaries : [this.defaultBinary];
      const binaryName = candidates.length > 1 ? candidates.map((b) => `'${b}'`).join(' or ') : `'${this.defaultBinary}'`;
      return {
        provider: this.id,
        available: false,
        reason: `Binary ${binaryName} not found in PATH`,
        supportedModels: this.supportedModels,
      };
    }

    try {
      const versionResult = await runner(binary, ['--version'], {
        cwd,
        timeoutMs: 5000,
        env: filterAllowlistedEnv(process.env, this.envAllowlist),
      });

      const version = versionResult.code === 0 ? versionResult.stdout.trim() : undefined;
      const auth = this.checkAuthStatus(process.env, binary);

      return {
        provider: this.id,
        available: versionResult.code === 0,
        binaryPath: binary,
        version: version || 'unknown',
        authStatus: auth,
        supportedModels: this.supportedModels,
      };
    } catch (error) {
      return {
        provider: this.id,
        available: false,
        binaryPath: binary,
        error: error instanceof Error ? error.message : String(error),
        supportedModels: this.supportedModels,
      };
    }
  }

  async execute(options: ProviderExecutionOptions): Promise<ProviderExecutionResult> {
    const startTime = Date.now();
    const runner = options.runner ?? defaultProcessRunner;

    // Safety checks first
    if (options.customArgs) {
      validateSafeArgs(options.customArgs, this.dangerousFlags);
    }

    const effectiveArgs = options.customArgs ?? this.buildExecutionArgs(options.prompt, options.model);
    validateSafeArgs(effectiveArgs, this.dangerousFlags);

    const binary = this.resolveBinaryPath(options.customBinary);

    if (!binary) {
      const candidates = this.candidateBinaries.length > 0 ? this.candidateBinaries : [this.defaultBinary];
      const binaryName = options.customBinary ? `'${options.customBinary}'` : candidates.map((b) => `'${b}'`).join(' or ');
      return {
        provider: this.id,
        model: options.model ?? this.supportedModels[0] ?? 'default',
        runtime: 'external',
        exitCode: 1,
        text: '',
        durationMs: Date.now() - startTime,
        error: `E_PROVIDER_BINARY_NOT_FOUND: ${binaryName} is not installed or not in PATH.`,
      };
    }

    const safeEnv = filterAllowlistedEnv(process.env, this.envAllowlist, options.env);

    try {
      const result = await runner(binary, effectiveArgs, {
        cwd: options.cwd,
        env: safeEnv,
        timeoutMs: options.timeoutMs ?? 60_000,
        signal: options.signal,
      });

      return {
        provider: this.id,
        model: options.model ?? this.supportedModels[0] ?? 'default',
        runtime: 'external',
        exitCode: result.code,
        text: result.stdout.trim() || result.stderr.trim(),
        durationMs: Date.now() - startTime,
        error: result.code === 0 ? undefined : (result.stderr.trim() || `Process exited with code ${result.code}`),
      };
    } catch (err) {
      return {
        provider: this.id,
        model: options.model ?? this.supportedModels[0] ?? 'default',
        runtime: 'external',
        exitCode: 1,
        text: '',
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
