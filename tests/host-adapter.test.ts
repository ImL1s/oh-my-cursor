import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorAgentAdapter, assertSafeArgv, buildPrintArgv, defaultCursorRunner } from '../src/host/cursor-agent.js';
import { parseCursorJsonOutput } from '../src/host/json-output.js';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`descendant ${pid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readPidFile(pidFile: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isSafeInteger(pid)) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '<missing>';
  throw new Error(`pid file ${pidFile} not ready, got: ${raw}`);
}

const descendantScript = `
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const descendant = spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
  ], { stdio: 'ignore' });
  fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(descendant.pid));
`;

describe('Cursor host adapter', () => {
  it('constructs argv without a shell and rejects conflicting session routing', () => {
    expect(buildPrintArgv('hello; rm -rf /', { format: 'json', resume: 'chat-1' })).toEqual([
      '--print', '--output-format', 'json', '--resume', 'chat-1', 'hello; rm -rf /',
    ]);
    expect(() => buildPrintArgv('x', { resume: 'a', continue: true })).toThrow('E_SESSION_ROUTE_CONFLICT');
    expect(() => assertSafeArgv(['bad\0arg'])).toThrow('E_ARGV_INVALID');
  });

  it('parses object, array, and stream JSON within bounds', () => {
    expect(parseCursorJsonOutput('{"type":"result"}')).toEqual({ type: 'result' });
    expect(parseCursorJsonOutput('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => parseCursorJsonOutput('x')).toThrow('E_INVALID_CURSOR_JSON');
  });

  it('attaches parsed JSON for declared JSON output only', async () => {
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{"ok":true}\n', stderr: '' }));
    await expect(adapter.run({ argv: ['--print', '--output-format', 'json', 'hello'], cwd: '/', interactive: false })).resolves.toMatchObject({ json: { ok: true } });
  });

  it('records timeout before termination and rejects an ignore-TERM late success', async () => {
    const started = Date.now();
    await expect(defaultCursorRunner(process.execPath, {
      argv: ['-e', 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),1500));setInterval(()=>{},1000)'],
      cwd: process.cwd(),
      interactive: false,
    }, { timeoutMs: 150 })).rejects.toThrow('E_CURSOR_TIMEOUT');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('does not impose the headless default timeout on an interactive session', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(defaultCursorRunner(process.execPath, {
        argv: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        interactive: true,
      })).resolves.toMatchObject({ code: 0 });
      expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), 120_000);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('never accepts exit zero after output overflow was recorded', async () => {
    await expect(defaultCursorRunner(process.execPath, {
      argv: ['-e', 'process.stdout.write("x".repeat(4096));process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'],
      cwd: process.cwd(),
      interactive: false,
    }, { maxOutputBytes: 64, timeoutMs: 2_000 })).rejects.toThrow('E_OUTPUT_TOO_LARGE');
  });

  it.each([
    { failure: 'timeout', suffix: 'setInterval(()=>{},1000)', options: { timeoutMs: 150 } },
    { failure: 'overflow', suffix: 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)', options: { timeoutMs: 2_000, maxOutputBytes: 64 } },
  ])('terminates a TERM-ignoring descendant process group after $failure', async ({ failure, suffix, options }) => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-host-${failure}-`));
    const pidFile = path.join(root, 'descendant.pid');
    try {
      await expect(defaultCursorRunner(process.execPath, {
        argv: ['-e', `${descendantScript}\n${suffix}`],
        cwd: process.cwd(),
        interactive: false,
      }, { ...options, env: { ...process.env, DESCENDANT_PID_FILE: pidFile } })).rejects.toThrow(
        failure === 'timeout' ? 'E_CURSOR_TIMEOUT' : 'E_OUTPUT_TOO_LARGE',
      );
      const descendantPid = await readPidFile(pidFile);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expectProcessGone(descendantPid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous leading-dash prompts and NUL characters', () => {
    expect(() => buildPrintArgv('--help')).toThrow('E_PROMPT_UNSAFE');
    expect(() => buildPrintArgv('-m plan')).toThrow('E_PROMPT_UNSAFE');
    expect(() => buildPrintArgv('  -flag')).toThrow('E_PROMPT_UNSAFE');
    expect(() => buildPrintArgv('hello\0world')).toThrow('E_PROMPT_INVALID');
  });

  it('installs and cleans up signal listeners deterministically', async () => {
    if (process.platform === 'win32') return;
    const initialSigintCount = process.listenerCount('SIGINT');
    const initialSigtermCount = process.listenerCount('SIGTERM');
    const initialSighupCount = process.listenerCount('SIGHUP');

    await expect(defaultCursorRunner(process.execPath, {
      argv: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      interactive: false,
    })).resolves.toMatchObject({ code: 0 });

    expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
    expect(process.listenerCount('SIGHUP')).toBe(initialSighupCount);
  });
});

