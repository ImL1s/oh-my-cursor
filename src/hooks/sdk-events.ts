import crypto from 'node:crypto';
import type { SDKMessage, RunResult } from '@cursor/sdk';
import { recordHookTrace } from './trace.js';
import type { HookTraceEntry } from './types.js';

export type SdkEventType =
  | 'assistant_output'
  | 'tool_call'
  | 'tool_result'
  | 'status_change'
  | 'run_terminal';

export type OmcuDomainEventType =
  | 'workflow_transition'
  | 'goal_update'
  | 'artifact_created'
  | 'evidence_recorded';

export interface SdkProjectedEvent {
  readonly id: string;
  readonly runId: string;
  readonly source: 'cursor_sdk';
  readonly eventType: SdkEventType;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OmcuDomainEvent {
  readonly id: string;
  readonly runId: string;
  readonly source: 'omcu_domain';
  readonly eventType: OmcuDomainEventType;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SdkStreamStats {
  readonly runId: string;
  readonly messageCount: number;
  readonly assistantMessageCount: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly statusChanges: readonly string[];
  readonly startTime: number;
  readonly lastUpdateTime: number;
  readonly completed: boolean;
  readonly terminalResult?: RunResult | undefined;
}

export class SdkEventProjector {
  private messageCount = 0;
  private assistantMessageCount = 0;
  private toolCallCount = 0;
  private toolResultCount = 0;
  private readonly statusChanges: string[] = [];
  private readonly startTime = Date.now();
  private lastUpdateTime = Date.now();
  private completed = false;
  private terminalResult?: RunResult | undefined;

  constructor(
    public readonly runId: string,
    private readonly cwd?: string | undefined
  ) {}

  public projectMessage(message: SDKMessage): SdkProjectedEvent {
    this.messageCount += 1;
    this.lastUpdateTime = Date.now();

    const msgObj = message as unknown as Record<string, unknown>;
    let eventType: SdkEventType = 'assistant_output';

    if (msgObj.role === 'tool' || msgObj.type === 'tool_result') {
      eventType = 'tool_result';
      this.toolResultCount += 1;
    } else if (msgObj.type === 'tool_call' || (Array.isArray(msgObj.tool_calls) && msgObj.tool_calls.length > 0)) {
      eventType = 'tool_call';
      this.toolCallCount += 1;
    } else if (msgObj.type === 'status_change') {
      eventType = 'status_change';
      if (typeof msgObj.status === 'string') {
        this.statusChanges.push(msgObj.status);
      }
    } else if (msgObj.role === 'assistant') {
      this.assistantMessageCount += 1;
    }

    const event: SdkProjectedEvent = {
      id: crypto.randomUUID(),
      runId: this.runId,
      source: 'cursor_sdk',
      eventType,
      timestamp: new Date().toISOString(),
      payload: msgObj,
    };

    const traceEntry: HookTraceEntry = {
      id: event.id,
      runId: this.runId,
      event: `sdk:${eventType}`,
      eventType: 'sdk_event',
      status: 'success',
      durationMs: 0,
      timestamp: event.timestamp,
      details: { eventType, source: 'cursor_sdk' },
    };
    recordHookTrace(traceEntry, this.cwd);

    return event;
  }

  public recordTerminal(result: RunResult): SdkProjectedEvent {
    this.completed = true;
    this.terminalResult = result;
    this.lastUpdateTime = Date.now();

    const event: SdkProjectedEvent = {
      id: crypto.randomUUID(),
      runId: this.runId,
      source: 'cursor_sdk',
      eventType: 'run_terminal',
      timestamp: new Date().toISOString(),
      payload: {
        error: result.error,
        durationMs: this.lastUpdateTime - this.startTime,
      },
    };

    const traceEntry: HookTraceEntry = {
      id: event.id,
      runId: this.runId,
      event: 'sdk:run_terminal',
      eventType: 'sdk_event',
      status: result.error ? 'failed' : 'success',
      durationMs: this.lastUpdateTime - this.startTime,
      timestamp: event.timestamp,
      details: { error: result.error },
    };
    recordHookTrace(traceEntry, this.cwd);

    return event;
  }

  public emitDomainEvent(
    eventType: OmcuDomainEventType,
    payload: Record<string, unknown>
  ): OmcuDomainEvent {
    const event: OmcuDomainEvent = {
      id: crypto.randomUUID(),
      runId: this.runId,
      source: 'omcu_domain',
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    };

    const traceEntry: HookTraceEntry = {
      id: event.id,
      runId: this.runId,
      event: `domain:${eventType}`,
      eventType: 'domain_event',
      status: 'success',
      durationMs: 0,
      timestamp: event.timestamp,
      details: payload,
    };
    recordHookTrace(traceEntry, this.cwd);

    return event;
  }

  public getStats(): SdkStreamStats {
    return {
      runId: this.runId,
      messageCount: this.messageCount,
      assistantMessageCount: this.assistantMessageCount,
      toolCallCount: this.toolCallCount,
      toolResultCount: this.toolResultCount,
      statusChanges: [...this.statusChanges],
      startTime: this.startTime,
      lastUpdateTime: this.lastUpdateTime,
      completed: this.completed,
      terminalResult: this.terminalResult,
    };
  }
}
