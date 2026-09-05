import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentRecord,
  type ModelSelection,
  type Run,
  type RunRecord,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
  type SDKMessage,
  type SDKUserMessage,
  type SendOptions,
} from '@cursor/sdk';
import { CursorRuntimeError } from './errors.js';
import { resolveLocalAgentStore } from './store.js';
import type {
  CursorRunHandle,
  CursorRuntime,
  CursorRuntimeOptions,
  ManagedCursorAgent,
  PromptInput,
  PromptOutput,
  RuntimeTarget,
  SupportedOperation,
} from './types.js';

export class CursorRunHandleImpl implements CursorRunHandle {
  public readonly agentId: string;
  public readonly runId: string;
  public readonly requestId?: string | undefined;
  public readonly target: RuntimeTarget;
  public readonly model?: ModelSelection | undefined;

  constructor(
    private readonly run: Run,
    target: RuntimeTarget
  ) {
    this.agentId = run.agentId;
    this.runId = run.id;
    const reqId = (run as unknown as { requestId?: string; request_id?: string }).requestId
      ?? (run as unknown as { requestId?: string; request_id?: string }).request_id;
    if (reqId !== undefined) {
      this.requestId = reqId;
    }
    this.target = target;
    if (run.model !== undefined) {
      this.model = run.model;
    }
  }

  get status(): string {
    return this.run.status;
  }

  supports(op: SupportedOperation): boolean {
    try {
      return this.run.supports(op);
    } catch {
      return false;
    }
  }

  unsupportedReason(op: SupportedOperation): string | undefined {
    try {
      return this.run.unsupportedReason(op);
    } catch {
      return 'Operation not supported';
    }
  }

  async *stream(): AsyncIterable<SDKMessage> {
    try {
      for await (const chunk of this.run.stream()) {
        yield chunk;
      }
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_TERMINAL',
        `Run stream interrupted: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async wait(): Promise<RunResult> {
    try {
      const result = await this.run.wait();
      if (result.error) {
        throw new CursorRuntimeError(
          'E_RUNTIME_TERMINAL',
          `Run completed with error: ${result.error.message || result.error.code || 'unknown'}`,
          result.error
        );
      }
      return result;
    } catch (error) {
      if (error instanceof CursorRuntimeError) throw error;
      throw new CursorRuntimeError(
        'E_RUNTIME_TERMINAL',
        `Error waiting for run completion: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async cancel(): Promise<void> {
    if (!this.supports('cancel')) {
      const reason = this.unsupportedReason('cancel') ?? 'Cancel operation is not supported for this run';
      throw new CursorRuntimeError('E_UNSUPPORTED_OPERATION', reason);
    }
    try {
      await this.run.cancel();
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_TERMINAL',
        `Failed to cancel run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

export class ManagedCursorAgentImpl implements ManagedCursorAgent {
  public readonly agentId: string;
  public readonly target: RuntimeTarget;
  private disposed = false;

  constructor(
    private readonly sdkAgent: SDKAgent,
    target: RuntimeTarget
  ) {
    this.agentId = sdkAgent.agentId;
    this.target = target;
  }

  async send(message: string | AgentMessage, options?: SendOptions): Promise<CursorRunHandle> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'Managed agent has already been disposed');
    }
    try {
      const run = await this.sdkAgent.send(message as string | SDKUserMessage, options);
      return new CursorRunHandleImpl(run, this.target);
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Failed to start run: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (typeof this.sdkAgent[Symbol.asyncDispose] === 'function') {
        await this.sdkAgent[Symbol.asyncDispose]();
      } else if (typeof this.sdkAgent.close === 'function') {
        this.sdkAgent.close();
      }
    } catch {
      // Best-effort cleanup
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function normalizeModel(model: string | ModelSelection | undefined): ModelSelection | undefined {
  if (!model) return undefined;
  if (typeof model === 'string') return { id: model };
  return model;
}

export class DefaultCursorRuntime implements CursorRuntime {
  public readonly target: RuntimeTarget;
  private readonly defaultOptions: CursorRuntimeOptions;
  private readonly managedAgents = new Set<ManagedCursorAgent>();
  private disposed = false;

  constructor(options: CursorRuntimeOptions) {
    if (options.target !== 'local' && options.target !== 'cloud') {
      throw new CursorRuntimeError(
        'E_INVALID_TARGET',
        `Runtime target must be explicitly specified as 'local' or 'cloud', got: ${String(options.target)}`
      );
    }
    this.target = options.target;
    this.defaultOptions = options;
  }

  private async buildAgentOptions(
    overrides?: Partial<CursorRuntimeOptions>
  ): Promise<{ target: RuntimeTarget; agentOptions: AgentOptions }> {
    const target = overrides?.target ?? this.target;
    if (target !== 'local' && target !== 'cloud') {
      throw new CursorRuntimeError(
        'E_INVALID_TARGET',
        `Runtime target must be explicitly specified as 'local' or 'cloud', got: ${String(target)}`
      );
    }

    const rawModel = overrides?.model ?? this.defaultOptions.model;
    const model = normalizeModel(rawModel);
    const agentOptions: AgentOptions = {};
    if (model) {
      agentOptions.model = model;
    }

    if (target === 'local') {
      const cwd = overrides?.cwd ?? this.defaultOptions.cwd ?? process.cwd();
      const customTools: Record<string, SDKCustomTool> = {
        ...(this.defaultOptions.customTools ?? {}),
        ...(overrides?.customTools ?? {}),
      };

      let store = overrides?.store ?? this.defaultOptions.store;
      if (!store) {
        const storeType = overrides?.storeType ?? this.defaultOptions.storeType;
        const storePath = overrides?.storePath ?? this.defaultOptions.storePath;
        if (storeType && storePath) {
          store = await resolveLocalAgentStore({ storeType, rootDir: storePath });
        }
      }

      agentOptions.local = {
        cwd,
        ...(Object.keys(customTools).length > 0 ? { customTools } : {}),
        ...(store ? { store } : {}),
        ...(this.defaultOptions.autoReview ? { autoReview: true } : {}),
      };
    } else {
      // Cloud target - explicit configuration
      agentOptions.cloud = {};
    }

    return { target, agentOptions };
  }

  async prompt(input: PromptInput): Promise<PromptOutput> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    if (input.target !== 'local' && input.target !== 'cloud') {
      throw new CursorRuntimeError(
        'E_INVALID_TARGET',
        `Prompt runtime target must be explicitly specified as 'local' or 'cloud', got: ${String(input.target)}`
      );
    }

    const partialOptions: Partial<CursorRuntimeOptions> = {
      target: input.target,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.customTools !== undefined ? { customTools: input.customTools } : {}),
    };

    const { agentOptions } = await this.buildAgentOptions(partialOptions);

    try {
      const result = await Agent.prompt(input.prompt, agentOptions);
      if (result.error) {
        throw new CursorRuntimeError(
          'E_RUNTIME_TERMINAL',
          `Prompt failed: ${result.error.message || result.error.code || 'unknown'}`,
          result.error
        );
      }
      const output: PromptOutput = {
        text: (result as unknown as { text?: string }).text ?? '',
        result,
        ...((result as unknown as { agentId?: string }).agentId !== undefined
          ? { agentId: (result as unknown as { agentId?: string }).agentId }
          : {}),
        ...((result as unknown as { runId?: string }).runId !== undefined
          ? { runId: (result as unknown as { runId?: string }).runId }
          : {}),
      };
      return output;
    } catch (error) {
      if (error instanceof CursorRuntimeError) throw error;
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Prompt invocation error: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async createAgent(options?: Partial<CursorRuntimeOptions>): Promise<ManagedCursorAgent> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    const { target, agentOptions } = await this.buildAgentOptions(options);

    try {
      const sdkAgent = await Agent.create(agentOptions);
      const managed = new ManagedCursorAgentImpl(sdkAgent, target);
      this.managedAgents.add(managed);
      return managed;
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async resumeAgent(
    agentId: string,
    options?: Partial<CursorRuntimeOptions>
  ): Promise<ManagedCursorAgent> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    const { target, agentOptions } = await this.buildAgentOptions(options);

    try {
      const sdkAgent = await Agent.resume(agentId, agentOptions);
      const managed = new ManagedCursorAgentImpl(sdkAgent, target);
      this.managedAgents.add(managed);
      return managed;
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Failed to resume agent '${agentId}': ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    try {
      const info = await Agent.get(agentId);
      return info as unknown as AgentRecord;
    } catch {
      return null;
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    try {
      const run = await Agent.getRun(runId);
      return run as unknown as RunRecord;
    } catch {
      return null;
    }
  }

  async listRuns(agentId?: string): Promise<readonly RunRecord[]> {
    if (this.disposed) {
      throw new CursorRuntimeError('E_RUNTIME_DISPOSED', 'CursorRuntime has already been disposed');
    }
    try {
      if (!agentId) return [];
      const result = await Agent.listRuns(agentId);
      return (result.items ?? []) as unknown as readonly RunRecord[];
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const agent of this.managedAgents) {
      await agent.close();
    }
    this.managedAgents.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

export function createCursorRuntime(options: CursorRuntimeOptions): CursorRuntime {
  return new DefaultCursorRuntime(options);
}
