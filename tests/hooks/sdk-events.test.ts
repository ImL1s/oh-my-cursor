import { describe, expect, it } from 'vitest';
import { SdkEventProjector } from '../../src/hooks/sdk-events.js';
import { getHookTraces, clearInMemoryTraces } from '../../src/hooks/trace.js';

describe('SDK Event Projector (observation without impersonating native hooks)', () => {
  it('projects assistant messages, tool calls, and tool results into typed events', () => {
    clearInMemoryTraces();
    const projector = new SdkEventProjector('run-test-101');

    // 1. Assistant message
    const msg1 = projector.projectMessage({ role: 'assistant', content: 'Hello world' } as any);
    expect(msg1.source).toBe('cursor_sdk');
    expect(msg1.eventType).toBe('assistant_output');
    expect(msg1.runId).toBe('run-test-101');

    // 2. Tool call
    const msg2 = projector.projectMessage({
      type: 'tool_call',
      tool_name: 'Shell',
      tool_args: { command: 'git status' },
    } as any);
    expect(msg2.source).toBe('cursor_sdk');
    expect(msg2.eventType).toBe('tool_call');

    // 3. Tool result
    const msg3 = projector.projectMessage({
      type: 'tool_result',
      tool_name: 'Shell',
      output: 'On branch main',
    } as any);
    expect(msg3.source).toBe('cursor_sdk');
    expect(msg3.eventType).toBe('tool_result');

    // 4. Status change
    const msg4 = projector.projectMessage({
      type: 'status_change',
      status: 'running',
    } as any);
    expect(msg4.eventType).toBe('status_change');

    // 5. Terminal result
    const term = projector.recordTerminal({ result: 'completed successfully' } as any);
    expect(term.eventType).toBe('run_terminal');

    // 6. Domain events
    const domainEvt = projector.emitDomainEvent('workflow_transition', {
      from: 'implement',
      to: 'verify',
    });
    expect(domainEvt.source).toBe('omcu_domain');
    expect(domainEvt.eventType).toBe('workflow_transition');

    // Check stats
    const stats = projector.getStats();
    expect(stats.messageCount).toBe(4);
    expect(stats.assistantMessageCount).toBe(1);
    expect(stats.toolCallCount).toBe(1);
    expect(stats.toolResultCount).toBe(1);
    expect(stats.completed).toBe(true);

    // Check trace records and provenance tagging
    const traces = getHookTraces('run-test-101');
    expect(traces.length).toBeGreaterThanOrEqual(5);
    const sdkTraces = traces.filter((t) => t.eventType === 'sdk_event');
    const domainTraces = traces.filter((t) => t.eventType === 'domain_event');
    expect(sdkTraces.length).toBeGreaterThan(0);
    expect(domainTraces.length).toBeGreaterThan(0);
  });
});
