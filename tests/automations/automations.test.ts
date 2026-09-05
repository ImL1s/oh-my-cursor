import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationManager } from '../../src/automations/index.js';

describe('Cursor Automations & Local Fallback Scheduler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-auto-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('plans an automation manifest', () => {
    const manager = new AutomationManager(tempDir, { automationsAvailable: true });
    const plan = manager.plan({
      name: 'Nightly CI',
      trigger: { kind: 'cron', cron: '0 0 * * *' },
      action: {
        role: 'omcu-worker',
        prompt: 'Run test suite',
      },
    });

    expect(plan.automationId).toBeDefined();
    expect(plan.status).toBe('planned');
    expect(plan.target).toBe('cursor-native');

    const loaded = manager.load(plan.automationId);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Nightly CI');
  });

  it('installs to native Cursor Automations when available', () => {
    const manager = new AutomationManager(tempDir, { automationsAvailable: true });
    const plan = manager.plan({
      name: 'Deploy Trigger',
      trigger: { kind: 'event', event: 'release:published' },
      action: {
        role: 'omcu-worker',
        prompt: 'Deploy release artifact',
      },
    });

    const installed = manager.install(plan.automationId);
    expect(installed.status).toBe('installed');
    expect(installed.target).toBe('cursor-native');

    const cursorAutoFile = path.join(tempDir, '.cursor', 'automations', `${plan.automationId}.json`);
    expect(fs.existsSync(cursorAutoFile)).toBe(true);
  });

  it('fails to install when Automations unavailable and fallback scheduler is disabled', () => {
    const manager = new AutomationManager(tempDir, {
      automationsAvailable: false,
      enableFallbackScheduler: false,
    });

    const plan = manager.plan({
      name: 'Scheduled Job',
      trigger: { kind: 'cron', cron: '*/15 * * * *' },
      action: {
        role: 'omcu-worker',
        prompt: 'Health check',
      },
    });

    expect(() => manager.install(plan.automationId)).toThrow(/E_AUTOMATION_UNAVAILABLE/);
  });

  it('installs to local fallback scheduler when Automations unavailable but fallback is enabled', () => {
    const manager = new AutomationManager(tempDir, {
      automationsAvailable: false,
      enableFallbackScheduler: true,
    });

    const plan = manager.plan({
      name: 'Fallback Scheduled Job',
      trigger: { kind: 'cron', cron: '0 12 * * *' },
      action: {
        role: 'omcu-worker',
        prompt: 'Backup state',
      },
    });

    const installed = manager.install(plan.automationId);
    expect(installed.status).toBe('installed');
    expect(installed.target).toBe('fallback-local');

    const fallbackFile = path.join(tempDir, '.omcu', 'scheduler', `${plan.automationId}.json`);
    expect(fs.existsSync(fallbackFile)).toBe(true);
  });

  it('removes installed automation and disables manifest', () => {
    const manager = new AutomationManager(tempDir, { automationsAvailable: true });
    const plan = manager.plan({
      name: 'To Remove',
      trigger: { kind: 'cron', cron: '0 0 * * *' },
      action: { role: 'omcu-worker', prompt: 'temp' },
    });

    manager.install(plan.automationId);
    const cursorAutoFile = path.join(tempDir, '.cursor', 'automations', `${plan.automationId}.json`);
    expect(fs.existsSync(cursorAutoFile)).toBe(true);

    const removed = manager.remove(plan.automationId);
    expect(removed).toBe(true);
    expect(fs.existsSync(cursorAutoFile)).toBe(false);

    const afterRemove = manager.load(plan.automationId);
    expect(afterRemove?.status).toBe('disabled');
  });
});
