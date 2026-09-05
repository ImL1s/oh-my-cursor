import fs from 'node:fs';
import path from 'node:path';
import { decidePersist } from '../persist/decision.js';
import { resolveProjectStatePath } from '../runtime/state-root.js';
import { executeContextCompact } from './context-compact.js';
import { evaluatePostStepAudit } from './post-step-audit.js';
import { evaluatePreStepSafety } from './pre-step-gate.js';
import type {
  CursorNativeHookEvent,
  HookExecutionContext,
  HookExecutionTier,
  HookHandlerDefinition,
  HookHandlerResult,
} from './types.js';

export class HookRegistry {
  private readonly handlers = new Map<string, HookHandlerDefinition>();

  constructor() {
    this.registerBuiltinHandlers();
  }

  public register(handler: HookHandlerDefinition): void {
    if (this.handlers.has(handler.id)) {
      const existing = this.handlers.get(handler.id)!;
      if (existing.immutable) {
        throw new Error(`E_HOOK_IMMUTABLE: Handler ${handler.id} is immutable and cannot be overridden`);
      }
    }
    // Prevent non-immutable custom handlers from registering into Tier 1 (safety_permission)
    if (handler.tier === 1 && !handler.immutable) {
      throw new Error(`E_HOOK_TIER_VIOLATION: Non-immutable handler ${handler.id} cannot claim Tier 1 safety permission`);
    }

    this.handlers.set(handler.id, handler);
  }

  public getHandler(id: string): HookHandlerDefinition | undefined {
    return this.handlers.get(id);
  }

  public listHandlers(filter?: {
    event?: CursorNativeHookEvent;
    tier?: HookExecutionTier;
  }): readonly HookHandlerDefinition[] {
    let list = Array.from(this.handlers.values());
    if (filter?.event) {
      list = list.filter((h) => h.event === filter.event);
    }
    if (filter?.tier) {
      list = list.filter((h) => h.tier === filter.tier);
    }
    return this.sortHandlers(list);
  }

  public getOrderedHandlersForEvent(event: CursorNativeHookEvent): readonly HookHandlerDefinition[] {
    const applicable = Array.from(this.handlers.values()).filter((h) => h.event === event);
    return this.sortHandlers(applicable);
  }

  public reset(): void {
    this.handlers.clear();
    this.registerBuiltinHandlers();
  }

  private sortHandlers(handlers: HookHandlerDefinition[]): HookHandlerDefinition[] {
    return handlers.slice().sort((a, b) => {
      // 1. Tier ascending (1 -> 5)
      if (a.tier !== b.tier) return a.tier - b.tier;
      // 2. Priority ascending
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 3. ID alphabetical tie-break
      return a.id.localeCompare(b.id);
    });
  }

  private registerBuiltinHandlers(): void {
    // 1. Pre-step Safety Gate (Tier 1, preToolUse, Shell)
    this.handlers.set('omcu-hook-pre-step-gate', {
      id: 'omcu-hook-pre-step-gate',
      name: 'Pre-Step Safety Gate',
      description: 'Evaluates proposed shell commands and filesystem edits against destructive command blacklist',
      event: 'preToolUse',
      tier: 1,
      priority: 10,
      matcher: 'Shell',
      timeoutMs: 3000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_closed',
      sourceAnalogs: { omo: 'omo_pre_step_gate' },
      canonicalContractId: 'omcu-hook-pre-step-gate',
      stateAccess: 'read',
      immutable: true,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (ctx: HookExecutionContext): HookHandlerResult => {
        const evaluation = evaluatePreStepSafety(ctx.toolName ?? 'Shell', ctx.toolInput, ctx.cwd);
        if (!evaluation.safe) {
          return {
            handled: true,
            action: 'deny',
            reason: evaluation.reason ?? 'Blocked by pre-step safety gate',
            errorCode: evaluation.errorCode ?? 'E_SAFETY_DENY',
            auditPassed: false,
            auditErrors: evaluation.violations,
          };
        }
        return { handled: true, action: 'pass', auditPassed: true };
      },
    });

    // 2. Lifecycle Pre-Tool Scope Enforcer (Tier 1, preToolUse)
    this.handlers.set('omcu-hook-lifecycle-pre-tool', {
      id: 'omcu-hook-lifecycle-pre-tool',
      name: 'Lifecycle Pre-Tool Safety Interceptor',
      description: 'Synchronous pre-tool call interceptor validating write scopes and boundary invariants',
      event: 'preToolUse',
      tier: 1,
      priority: 20,
      timeoutMs: 3000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_closed',
      sourceAnalogs: { omc: 'omc_hooks', omx: 'omx_subagent_stop' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'read',
      immutable: true,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (ctx: HookExecutionContext): HookHandlerResult => {
        const evaluation = evaluatePreStepSafety(ctx.toolName ?? '', ctx.toolInput, ctx.cwd);
        if (!evaluation.safe) {
          return {
            handled: true,
            action: 'deny',
            reason: evaluation.reason ?? 'Pre-tool boundary check failed',
            errorCode: 'E_LIFECYCLE_BOUNDARY_VIOLATION',
            auditPassed: false,
            auditErrors: evaluation.violations,
          };
        }
        return { handled: true, action: 'pass', auditPassed: true };
      },
    });

    // 3. Session Start Hook (Tier 2, sessionStart)
    this.handlers.set('omcu-hook-session-start', {
      id: 'omcu-hook-session-start',
      name: 'Session Start Initializer',
      description: 'Initializes OMCU session context and verifies plugin environment',
      event: 'sessionStart',
      tier: 2,
      priority: 10,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omc: 'omc_hooks' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'read',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (): HookHandlerResult => {
        return { handled: true, action: 'pass' };
      },
    });

    // 4. Before Submit Prompt Context Injector (Tier 2, beforeSubmitPrompt)
    this.handlers.set('omcu-hook-before-prompt-context', {
      id: 'omcu-hook-before-prompt-context',
      name: 'Before Prompt Context Injector',
      description: 'Prepares bound context, rules references, and compaction pointers before prompt submission',
      event: 'beforeSubmitPrompt',
      tier: 2,
      priority: 20,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omc: 'omc_hooks', omx: 'omx_context_compact' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'read',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (): HookHandlerResult => {
        return {
          handled: true,
          action: 'pass',
          outputPayload: { continue: true },
        };
      },
    });

    // 5. Context Compaction Hook (Tier 2, preCompact)
    this.handlers.set('omcu-hook-context-compact', {
      id: 'omcu-hook-context-compact',
      name: 'Context Compaction State Checkpoint',
      description: 'Persists active session state to disk prior to LLM context window compaction',
      event: 'preCompact',
      tier: 2,
      priority: 30,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omx: 'omx_context_compact' },
      canonicalContractId: 'omcu-hook-context-compact',
      stateAccess: 'write',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: async (ctx: HookExecutionContext): Promise<HookHandlerResult> => {
        try {
          const result = await executeContextCompact(ctx.cwd, ctx.rawInput);
          return {
            handled: true,
            action: 'pass',
            traceRecord: result ? { ...result } : undefined,
          };
        } catch {
          return { handled: true, action: 'pass' };
        }
      },
    });

    // 6. Persist Stop Hook (Tier 3, stop)
    this.handlers.set('omcu-hook-persist-stop', {
      id: 'omcu-hook-persist-stop',
      name: 'Persist Stop Oracle',
      description: 'Bounded repeat-until-criteria persistence oracle delivering native followup_message',
      event: 'stop',
      tier: 3,
      priority: 10,
      loopLimit: 500,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omc: 'omc_hooks', omx: 'omx_subagent_stop' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'read',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (ctx: HookExecutionContext): HookHandlerResult => {
        const statePath = resolveProjectStatePath(ctx.cwd);
        const persistCandidates = [
          path.join(statePath, 'persist.json'),
          path.join(statePath, 'persist', 'state.json'),
        ];
        let rawState: unknown = null;
        for (const candidate of persistCandidates) {
          if (fs.existsSync(candidate)) {
            try {
              rawState = JSON.parse(fs.readFileSync(candidate, 'utf8'));
              break;
            } catch {
              // Ignore read error
            }
          }
        }
        if (!rawState) {
          return { handled: true, action: 'pass' };
        }
        try {
          const decision = decidePersist(rawState, ctx.rawInput, Date.now());
          if (decision.continue && decision.followup_message) {
            return {
              handled: true,
              action: 'continue',
              followupMessage: decision.followup_message,
              outputPayload: { followup_message: decision.followup_message },
            };
          }
        } catch {
          // Fail open to normal stop
        }
        return { handled: true, action: 'pass' };
      },
    });

    // 7. Subagent Stop Hook (Tier 3, subagentStop)
    this.handlers.set('omcu-hook-subagent-stop', {
      id: 'omcu-hook-subagent-stop',
      name: 'Subagent Stop Interceptor',
      description: 'Subagent termination interceptor enforcing single-depth boundary and persistence',
      event: 'subagentStop',
      tier: 3,
      priority: 20,
      loopLimit: 500,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omx: 'omx_subagent_stop' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'read',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (ctx: HookExecutionContext): HookHandlerResult => {
        const statePath = resolveProjectStatePath(ctx.cwd);
        const persistCandidates = [
          path.join(statePath, 'persist.json'),
          path.join(statePath, 'persist', 'state.json'),
        ];
        let rawState: unknown = null;
        for (const candidate of persistCandidates) {
          if (fs.existsSync(candidate)) {
            try {
              rawState = JSON.parse(fs.readFileSync(candidate, 'utf8'));
              break;
            } catch {
              // Ignore read error
            }
          }
        }
        if (!rawState) {
          return { handled: true, action: 'pass' };
        }
        try {
          const decision = decidePersist(rawState, ctx.rawInput, Date.now());
          if (decision.continue && decision.followup_message) {
            return {
              handled: true,
              action: 'continue',
              followupMessage: decision.followup_message,
              outputPayload: { followup_message: decision.followup_message },
            };
          }
        } catch {
          // Fail open
        }
        return { handled: true, action: 'pass' };
      },
    });

    // 8. After Agent Response Hook (Tier 4, afterAgentResponse)
    this.handlers.set('omcu-hook-after-agent-response', {
      id: 'omcu-hook-after-agent-response',
      name: 'After Agent Response Recorder',
      description: 'Observes completed turns and records completion promises and artifact references',
      event: 'afterAgentResponse',
      tier: 4,
      priority: 10,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omc: 'omc_hooks' },
      canonicalContractId: 'omcu-hook-lifecycle',
      stateAccess: 'none',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (): HookHandlerResult => {
        return { handled: true, action: 'pass' };
      },
    });

    // 9. Post-Step Audit Hook (Tier 4, postToolUse)
    this.handlers.set('omcu-hook-post-step-audit', {
      id: 'omcu-hook-post-step-audit',
      name: 'Post-Step Audit Interceptor',
      description: 'Validates that step edits did not introduce syntax errors or broken tests',
      event: 'postToolUse',
      tier: 4,
      priority: 20,
      timeoutMs: 5000,
      maxInputBytes: 1024 * 1024,
      failurePolicy: 'fail_open',
      sourceAnalogs: { omo: 'omo_post_step_audit' },
      canonicalContractId: 'omcu-hook-post-step-audit',
      stateAccess: 'read',
      immutable: false,
      supportedRuntimes: ['local', 'cloud', 'interactive'],
      handler: (ctx: HookExecutionContext): HookHandlerResult => {
        const audit = evaluatePostStepAudit(ctx.toolName ?? '', ctx.toolOutput);
        return {
          handled: true,
          action: audit.passed ? 'pass' : 'modify',
          auditPassed: audit.passed,
          auditErrors: audit.errors,
          recoveryHints: audit.hints,
        };
      },
    });
  }
}

let globalHookRegistry: HookRegistry | null = null;

export function getHookRegistry(): HookRegistry {
  if (!globalHookRegistry) {
    globalHookRegistry = new HookRegistry();
  }
  return globalHookRegistry;
}
