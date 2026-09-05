import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import type {
  AutomationManifest,
  AutomationStatus,
  CreateAutomationInput,
} from './types.js';

export interface AutomationManagerOptions {
  readonly automationsAvailable?: boolean | undefined;
  readonly enableFallbackScheduler?: boolean | undefined;
}

export class AutomationManager {
  private readonly plansDir: string;
  private readonly cursorAutomationsDir: string;
  private readonly fallbackSchedulerDir: string;
  private readonly automationsAvailable: boolean;
  private readonly fallbackSchedulerEnabled: boolean;

  constructor(
    public readonly workspace: string,
    options?: AutomationManagerOptions
  ) {
    this.plansDir = path.join(path.resolve(workspace), '.omcu', 'automations');
    this.cursorAutomationsDir = path.join(path.resolve(workspace), '.cursor', 'automations');
    this.fallbackSchedulerDir = path.join(path.resolve(workspace), '.omcu', 'scheduler');

    fs.mkdirSync(this.plansDir, { recursive: true });

    // Determine whether native Cursor Automations are available
    if (options?.automationsAvailable !== undefined) {
      this.automationsAvailable = options.automationsAvailable;
    } else {
      this.automationsAvailable =
        process.env.CURSOR_AUTOMATIONS_ENABLED === 'true' ||
        fs.existsSync(this.cursorAutomationsDir);
    }

    this.fallbackSchedulerEnabled =
      options?.enableFallbackScheduler ??
      process.env.OMCU_LOCAL_SCHEDULER_ENABLED === 'true';
  }

  private planFile(automationId: string): string {
    const sanitized = automationId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.plansDir, `automation-${sanitized}.json`);
  }

  private cursorFile(automationId: string): string {
    const sanitized = automationId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.cursorAutomationsDir, `${sanitized}.json`);
  }

  private fallbackFile(automationId: string): string {
    const sanitized = automationId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.fallbackSchedulerDir, `${sanitized}.json`);
  }

  plan(input: CreateAutomationInput): AutomationManifest {
    if (!input.name || input.name.trim() === '') {
      throw new Error('E_AUTOMATION_NAME_INVALID: automation name must be non-empty');
    }
    if (input.trigger.kind === 'cron' && (!input.trigger.cron || input.trigger.cron.trim() === '')) {
      throw new Error('E_AUTOMATION_CRON_INVALID: cron expression is required for cron trigger');
    }
    if (input.trigger.kind === 'event' && (!input.trigger.event || input.trigger.event.trim() === '')) {
      throw new Error('E_AUTOMATION_EVENT_INVALID: event name is required for event trigger');
    }

    const automationId =
      input.automationId ?? `auto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const target = this.automationsAvailable ? 'cursor-native' : 'fallback-local';

    const manifest: AutomationManifest = {
      schema_version: 1,
      automationId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      trigger: input.trigger,
      action: input.action,
      status: 'planned',
      target,
      createdAt: now,
      updatedAt: now,
    };

    atomicWriteJson(this.planFile(automationId), manifest);
    return manifest;
  }

  load(automationId: string): AutomationManifest | null {
    const file = this.planFile(automationId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content) as AutomationManifest;
    } catch {
      return null;
    }
  }

  list(): readonly AutomationManifest[] {
    if (!fs.existsSync(this.plansDir)) return [];
    const entries = fs.readdirSync(this.plansDir);
    const manifests: AutomationManifest[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('automation-') || !entry.endsWith('.json')) continue;
      const file = path.join(this.plansDir, entry);
      try {
        manifests.push(JSON.parse(fs.readFileSync(file, 'utf8')) as AutomationManifest);
      } catch {
        // Skip corrupt files
      }
    }
    return manifests;
  }

  status(automationId?: string): AutomationStatus {
    const manifests = automationId ? [this.load(automationId)].filter(Boolean) as AutomationManifest[] : this.list();

    return {
      automationsAvailable: this.automationsAvailable,
      targetRuntime: this.automationsAvailable ? 'cursor-native' : 'fallback-local',
      fallbackSchedulerEnabled: this.fallbackSchedulerEnabled,
      automations: manifests,
    };
  }

  install(automationId: string, options?: { allowFallback?: boolean }): AutomationManifest {
    const manifest = this.load(automationId);
    if (!manifest) {
      throw new Error(`E_AUTOMATION_NOT_FOUND: automation '${automationId}' not found`);
    }

    const now = new Date().toISOString();
    const fallbackAllowed = options?.allowFallback || this.fallbackSchedulerEnabled;

    if (this.automationsAvailable) {
      try {
        // Export to native Cursor Automations directory
        fs.mkdirSync(this.cursorAutomationsDir, { recursive: true });
        atomicWriteJson(this.cursorFile(automationId), manifest);

        const updated: AutomationManifest = {
          ...manifest,
          status: 'installed',
          target: 'cursor-native',
          installedAt: now,
          updatedAt: now,
        };
        atomicWriteJson(this.planFile(automationId), updated);
        return updated;
      } catch (err) {
        if (!fallbackAllowed) {
          throw err;
        }
      }
    }

    // Cursor Automations are unavailable
    if (!fallbackAllowed) {
      throw new Error(
        'E_AUTOMATION_UNAVAILABLE: Cursor Automations are unavailable in this environment and local scheduler fallback is not enabled. Pass --allow-fallback or set OMCU_LOCAL_SCHEDULER_ENABLED=true.'
      );
    }

    // Install to local scheduler fallback
    fs.mkdirSync(this.fallbackSchedulerDir, { recursive: true });
    atomicWriteJson(this.fallbackFile(automationId), manifest);

    const updated: AutomationManifest = {
      ...manifest,
      status: 'installed',
      target: 'fallback-local',
      installedAt: now,
      updatedAt: now,
    };
    atomicWriteJson(this.planFile(automationId), updated);
    return updated;
  }

  remove(automationId: string): boolean {
    const manifest = this.load(automationId);
    if (!manifest) return false;

    // Remove from Cursor Automations
    const cursorFile = this.cursorFile(automationId);
    if (fs.existsSync(cursorFile)) {
      try {
        fs.unlinkSync(cursorFile);
      } catch {
        // Best effort
      }
    }

    // Remove from Fallback Scheduler
    const fallbackFile = this.fallbackFile(automationId);
    if (fs.existsSync(fallbackFile)) {
      try {
        fs.unlinkSync(fallbackFile);
      } catch {
        // Best effort
      }
    }

    // Update manifest status to disabled
    const updated: AutomationManifest = {
      ...manifest,
      status: 'disabled',
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(this.planFile(automationId), updated);
    return true;
  }
}
