import { describe, expect, it } from 'vitest';
import { defaultCommandRunner } from '../../src/setup/runner.js';

describe('setup command runner timeout', () => {
  it('escalates from SIGTERM to SIGKILL when a host probe ignores termination', async () => {
    const started = Date.now();
    const result = await defaultCommandRunner.run(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)',
    ], { timeoutMs: 150 });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('returns timeout failure even when TERM handler exits zero during grace', async () => {
    const result = await defaultCommandRunner.run(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),50));setInterval(()=>{},1000)',
    ], { timeoutMs: 150 });
    expect(result.code).toBe(124);
    expect(result.stderr).toContain('E_COMMAND_TIMEOUT');
  });
});
