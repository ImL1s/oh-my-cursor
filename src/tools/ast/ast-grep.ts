import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolError } from '../types.js';
import type {
  AstGrepMatch,
  AstGrepRewriteOptions,
  AstGrepRewriteResult,
  AstGrepSearchOptions,
  IAstGrepRunner,
} from './types.js';

const execFileAsync = promisify(execFile);

export class DefaultAstGrepRunner implements IAstGrepRunner {
  private availabilityCache = new Map<string, boolean>();

  async isAvailable(language?: string): Promise<boolean> {
    const key = language ?? 'default';
    if (this.availabilityCache.has(key)) {
      return this.availabilityCache.get(key)!;
    }

    try {
      await execFileAsync('ast-grep', ['--version']);
      this.availabilityCache.set(key, true);
      return true;
    } catch {
      try {
        await execFileAsync('sg', ['--version']);
        this.availabilityCache.set(key, true);
        return true;
      } catch {
        this.availabilityCache.set(key, false);
        return false;
      }
    }
  }

  async search(options: AstGrepSearchOptions): Promise<readonly AstGrepMatch[]> {
    const available = await this.isAvailable(options.language);
    if (!available) {
      throw new ToolError(
        'E_AST_PARSER_UNAVAILABLE',
        `ast-grep parser is not available for language '${options.language ?? 'auto'}'. Regex fallback is prohibited for AST operations.`
      );
    }

    const bin = 'ast-grep';
    const args = ['run', '--pattern', options.pattern, '--json'];
    if (options.language) {
      args.push('--lang', options.language);
    }
    if (options.paths && options.paths.length > 0) {
      args.push(...options.paths);
    }

    try {
      const { stdout } = await execFileAsync(bin, args, {
        cwd: options.rootDir ?? process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as AstGrepMatch[];
      return parsed;
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `ast-grep search failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async rewrite(options: AstGrepRewriteOptions): Promise<AstGrepRewriteResult> {
    const available = await this.isAvailable(options.language);
    if (!available) {
      throw new ToolError(
        'E_AST_PARSER_UNAVAILABLE',
        `ast-grep parser is not available for language '${options.language ?? 'auto'}'. Regex fallback is prohibited for AST operations.`
      );
    }

    const bin = 'ast-grep';
    const args = ['run', '--pattern', options.pattern, '--rewrite', options.rewrite];
    if (options.language) {
      args.push('--lang', options.language);
    }
    if (options.paths && options.paths.length > 0) {
      args.push(...options.paths);
    }
    if (!options.dryRun) {
      args.push('--update-all');
    }

    try {
      const { stdout } = await execFileAsync(bin, args, {
        cwd: options.rootDir ?? process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        matches: [],
        diff: stdout,
        applied: !options.dryRun,
      };
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `ast-grep rewrite failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
}

let activeRunner: IAstGrepRunner = new DefaultAstGrepRunner();

export function setAstGrepRunner(runner: IAstGrepRunner): void {
  activeRunner = runner;
}

export function getAstGrepRunner(): IAstGrepRunner {
  return activeRunner;
}
