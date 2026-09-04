import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../../src/host/cursor-agent.js';
import { planWorkflow, WorkflowRegistry, WorkflowRunner } from '../../src/workflows/index.js';
import { appendWorkflowEvent } from '../../src/workflows/replay.js';

describe('Workflow resume and durable retries', () => {
  it('retry across process restarts', async () => {
    let call = 0;
    const adapter1 = new CursorAgentAdapter('cursor-agent', async () => {
      call++;
      if (call === 1) return { code: 1, stdout: 'fail 1', stderr: '' };
      throw new Error('Crash');
    });
    
    const registry = new WorkflowRegistry();
    const definition = registry.register({
      schema_version: 1,
      name: 'retryable-workflow',
      version: '1.0.0',
      capability_tier: 'cursor-backed',
      stages: [{ id: 'task-1', mode: 'plan', prompt: 'do it', max_attempts: 3, depends_on: [] }],
    });
    const plan = planWorkflow(definition, 'run-resume', 'test resume');
    
    const runner1 = new WorkflowRunner(adapter1, '/repo');
    let events: any[] = [];
    try {
      await runner1.run(definition, plan, [], async (e) => { events.push(e); });
    } catch (err) {}
    
    const safeEvents = events.slice(0, 3);
    
    const adapter2 = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const runner2 = new WorkflowRunner(adapter2, '/repo');
    const result2 = await runner2.run(definition, plan, safeEvents);
    
    expect(result2.status.status).toBe('complete');
    expect(result2.status.tasks['task-1']?.status).toBe('passed');
    expect(result2.status.tasks['task-1']?.attempts).toHaveLength(2);
    expect(result2.status.tasks['task-1']?.attempts[0]?.attempt).toBe(1);
    expect(result2.status.tasks['task-1']?.attempts[1]?.attempt).toBe(2);
  });

  it('refuses automatic continuation when ambiguous in-flight detection', async () => {
    const registry = new WorkflowRegistry();
    const definition = registry.register({
      schema_version: 1,
      name: 'ambiguous-workflow',
      version: '1.0.0',
      capability_tier: 'cursor-backed',
      stages: [{ id: 'task-1', mode: 'plan', prompt: 'do it', max_attempts: 3, depends_on: [] }],
    });
    const plan = planWorkflow(definition, 'run-ambiguous', 'test');
    let events: any[] = [];
    events.push(appendWorkflowEvent(events, plan.run_id, 'run_started', { plan_sha256: plan.plan_sha256 }));
    events.push(appendWorkflowEvent(events, plan.run_id, 'task_started', { task_id: 'task-1', attempt: 1, argv_sha256: '0000000000000000000000000000000000000000000000000000000000000000' }));
    
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const runner = new WorkflowRunner(adapter, '/repo');
    
    await expect(runner.run(definition, plan, events)).rejects.toThrow('E_WORKFLOW_AMBIGUOUS_RESUME');
  });


  it('max_attempts exhaustion', async () => {
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 1, stdout: 'fail', stderr: '' }));
    const registry = new WorkflowRegistry();
    const definition = registry.register({
      schema_version: 1,
      name: 'fail-workflow',
      version: '1.0.0',
      capability_tier: 'cursor-backed',
      stages: [{ id: 'task-1', mode: 'plan', prompt: 'do it', max_attempts: 2, depends_on: [] }],
    });
    const plan = planWorkflow(definition, 'run-fail', 'test fail');
    
    const runner = new WorkflowRunner(adapter, '/repo');
    const result = await runner.run(definition, plan);
    
    expect(result.status.status).toBe('failed');
    expect(result.status.tasks['task-1']?.status).toBe('attempt_failed_terminal');
    expect(result.status.tasks['task-1']?.attempts).toHaveLength(2);
  });

  it('resume of passed tasks', async () => {
    const adapter1 = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const registry = new WorkflowRegistry();
    const definition = registry.register({
      schema_version: 1,
      name: 'passed-workflow',
      version: '1.0.0',
      capability_tier: 'cursor-backed',
      stages: [{ id: 'task-1', mode: 'plan', prompt: 'do it', max_attempts: 1, depends_on: [] }],
    });
    const plan = planWorkflow(definition, 'run-passed', 'test passed');
    const runner1 = new WorkflowRunner(adapter1, '/repo');
    const result1 = await runner1.run(definition, plan);
    
    const adapter2 = new CursorAgentAdapter('cursor-agent', async () => { throw new Error('Should not run'); });
    const runner2 = new WorkflowRunner(adapter2, '/repo');
    const result2 = await runner2.run(definition, plan, result1.events);
    
    expect(result2.status.status).toBe('complete');
    expect(result2.status.tasks['task-1']?.status).toBe('passed');
    expect(result2.status.tasks['task-1']?.attempts).toHaveLength(1);
  });
});
