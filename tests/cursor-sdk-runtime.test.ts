import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import {
  createCursorRuntime,
  CursorRunHandleImpl,
  CursorRuntimeError,
  DefaultCursorRuntime,
  isCursorRuntimeError,
  ManagedCursorAgentImpl,
} from '../src/runtime/cursor-sdk/index.js';

describe('Cursor SDK Runtime (Thin Layer)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Runtime Target Enforcement', () => {
    it('throws E_INVALID_TARGET if runtime target is omitted or invalid', () => {
      // @ts-expect-error testing invalid target
      expect(() => createCursorRuntime({})).toThrow(CursorRuntimeError);
      // @ts-expect-error testing invalid target
      expect(() => createCursorRuntime({ target: 'invalid' })).toThrow(/E_INVALID_TARGET/);
    });

    it('creates a local runtime successfully', () => {
      const runtime = createCursorRuntime({ target: 'local', cwd: '/test-cwd' });
      expect(runtime.target).toBe('local');
    });

    it('creates a cloud runtime successfully', () => {
      const runtime = createCursorRuntime({ target: 'cloud' });
      expect(runtime.target).toBe('cloud');
    });
  });

  describe('Agent.prompt (One-Shot)', () => {
    it('successfully calls Agent.prompt and returns text and native IDs', async () => {
      const mockResult: RunResult = {
        id: 'run-123',
        status: 'completed',
        result: 'Hello from Cursor Agent',
      };
      // Add fake text/agentId/runId properties returned by SDK prompt
      Object.assign(mockResult, {
        text: 'Hello from Cursor Agent',
        agentId: 'agent-abc',
        runId: 'run-123',
      });

      const promptSpy = vi.spyOn(Agent, 'prompt').mockResolvedValue(mockResult);

      const runtime = createCursorRuntime({ target: 'local', cwd: '/test-cwd', model: 'claude-3-5-sonnet' });
      const output = await runtime.prompt({
        prompt: 'Say hello',
        target: 'local',
      });

      expect(promptSpy).toHaveBeenCalledWith('Say hello', expect.objectContaining({
        model: { id: 'claude-3-5-sonnet' },
        local: expect.objectContaining({
          cwd: '/test-cwd',
        }),
      }));
      expect(output.text).toBe('Hello from Cursor Agent');
      expect(output.agentId).toBe('agent-abc');
      expect(output.runId).toBe('run-123');
    });

    it('throws E_RUNTIME_TERMINAL when prompt returns a result with terminal error', async () => {
      const mockResult: RunResult = {
        id: 'run-err',
        status: 'failed',
        error: { message: 'Quota exceeded', code: 'RATE_LIMIT' },
      };
      vi.spyOn(Agent, 'prompt').mockResolvedValue(mockResult);

      const runtime = createCursorRuntime({ target: 'local' });
      await expect(runtime.prompt({ prompt: 'test', target: 'local' })).rejects.toThrow(/E_RUNTIME_TERMINAL: Prompt failed: Quota exceeded/);
    });

    it('throws E_RUNTIME_STARTUP when Agent.prompt throws during invocation', async () => {
      vi.spyOn(Agent, 'prompt').mockRejectedValue(new Error('Connection refused'));

      const runtime = createCursorRuntime({ target: 'local' });
      await expect(runtime.prompt({ prompt: 'test', target: 'local' })).rejects.toThrow(/E_RUNTIME_STARTUP: Prompt invocation error: Connection refused/);
    });
  });

  describe('Agent.create & send (Multi-turn)', () => {
    it('creates agent and tracks native agentId and runId', async () => {
      const fakeRun: Partial<Run> = {
        id: 'run-999',
        agentId: 'agent-777',
        status: 'running',
        supports: (op) => op === 'cancel' || op === 'stream' || op === 'wait',
        unsupportedReason: () => undefined,
        async *stream() {
          yield { type: 'text-delta', delta: 'chunk-1' } as any;
          yield { type: 'text-delta', delta: 'chunk-2' } as any;
        },
        wait: async () => ({ id: 'run-999', status: 'completed', result: 'done' } as RunResult),
        cancel: async () => {},
      };
      Object.assign(fakeRun, { requestId: 'req-abc-123' });

      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'agent-777',
        send: vi.fn().mockResolvedValue(fakeRun as Run),
        close: vi.fn(),
      };

      vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

      const runtime = createCursorRuntime({ target: 'local', cwd: '/workspace' });
      const managedAgent = await runtime.createAgent();
      expect(managedAgent.agentId).toBe('agent-777');
      expect(managedAgent.target).toBe('local');

      const handle = await managedAgent.send('Perform task');
      expect(handle.agentId).toBe('agent-777');
      expect(handle.runId).toBe('run-999');
      expect(handle.requestId).toBe('req-abc-123');
      expect(handle.supports('cancel')).toBe(true);
      expect(handle.supports('conversation')).toBe(false);

      // Verify stream
      const chunks: any[] = [];
      for await (const chunk of handle.stream()) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(2);

      // Verify wait
      const result = await handle.wait();
      expect(result.status).toBe('completed');
    });

    it('handles cancellation and guards when cancel is unsupported', async () => {
      const cancelMock = vi.fn().mockResolvedValue(undefined);
      const supportedRun: Partial<Run> = {
        id: 'run-cancel-1',
        agentId: 'agent-1',
        status: 'running',
        supports: (op) => op === 'cancel',
        unsupportedReason: () => undefined,
        cancel: cancelMock,
      };

      const handle = new CursorRunHandleImpl(supportedRun as Run, 'local');
      expect(handle.supports('cancel')).toBe(true);
      await handle.cancel();
      expect(cancelMock).toHaveBeenCalledOnce();

      const unsupportedRun: Partial<Run> = {
        id: 'run-cancel-2',
        agentId: 'agent-1',
        status: 'running',
        supports: () => false,
        unsupportedReason: () => 'Cancel not permitted in this state',
      };
      const unsupportedHandle = new CursorRunHandleImpl(unsupportedRun as Run, 'local');
      expect(unsupportedHandle.supports('cancel')).toBe(false);
      await expect(unsupportedHandle.cancel()).rejects.toThrow(
        /E_UNSUPPORTED_OPERATION: Cancel not permitted in this state/
      );
    });

    it('differentiates startup error vs mid-run error', async () => {
      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'agent-err',
        send: vi.fn().mockRejectedValue(new Error('Process spawning failed')),
        close: vi.fn(),
      };
      const managed = new ManagedCursorAgentImpl(fakeAgent as SDKAgent, 'local');

      await expect(managed.send('fail startup')).rejects.toThrow(
        /E_RUNTIME_STARTUP: Failed to start run: Process spawning failed/
      );

      const midRunErrorRun: Partial<Run> = {
        id: 'run-fail',
        agentId: 'agent-err',
        status: 'failed',
        supports: () => false,
        unsupportedReason: () => undefined,
        wait: async () => ({ id: 'run-fail', status: 'failed', error: { message: 'Agent crashed midway' } }),
      };
      const handle = new CursorRunHandleImpl(midRunErrorRun as Run, 'local');
      await expect(handle.wait()).rejects.toThrow(
        /E_RUNTIME_TERMINAL: Run completed with error: Agent crashed midway/
      );
    });
  });

  describe('Agent.resume (Process Continuation)', () => {
    it('resumes an agent by ID and retains target identity', async () => {
      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'resumed-agent-42',
        send: vi.fn(),
        close: vi.fn(),
      };
      const resumeSpy = vi.spyOn(Agent, 'resume').mockResolvedValue(fakeAgent as SDKAgent);

      const runtime = createCursorRuntime({ target: 'local', cwd: '/repo' });
      const resumed = await runtime.resumeAgent('resumed-agent-42');

      expect(resumeSpy).toHaveBeenCalledWith('resumed-agent-42', expect.any(Object));
      expect(resumed.agentId).toBe('resumed-agent-42');
      expect(resumed.target).toBe('local');
    });
  });

  describe('Deterministic Resource Disposal', () => {
    it('disposes managed agents when runtime is disposed', async () => {
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'agent-dispose',
        send: vi.fn(),
        close: closeSpy,
      };
      vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

      const runtime = createCursorRuntime({ target: 'local' });
      const managed = await runtime.createAgent();

      await runtime.dispose();
      expect(closeSpy).toHaveBeenCalled();

      // Attempts to operate on disposed runtime should fail
      await expect(runtime.createAgent()).rejects.toThrow(/E_RUNTIME_DISPOSED/);
      await expect(runtime.prompt({ prompt: 'hi', target: 'local' })).rejects.toThrow(/E_RUNTIME_DISPOSED/);
      await expect(managed.send('msg')).rejects.toThrow(/E_RUNTIME_DISPOSED/);
    });
  });
});
