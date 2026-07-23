import { spawn } from 'node:child_process';
import type { CommandRunner } from './types.js';

export const defaultCommandRunner: CommandRunner = {
  run: (command, args, options = {}) => new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, options.timeoutMs ?? 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({
        code: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}E_COMMAND_TIMEOUT\n` : stderr,
      });
    });
  }),
};
