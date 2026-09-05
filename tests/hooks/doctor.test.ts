import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHooksDoctor } from '../../src/hooks/doctor.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');

describe('Hook Doctor Diagnostics (omcu hooks doctor)', () => {
  it('runs doctor without live probe and inspects installed configuration', async () => {
    const report = await runHooksDoctor({ cwd: packageRoot, live: false });

    expect(report.ok).toBe(true);
    expect(report.installedHooks.length).toBeGreaterThanOrEqual(6);
    expect(report.installedHooks).toContain('sessionStart');
    expect(report.installedHooks).toContain('preToolUse');
    expect(report.installedHooks).toContain('stop');

    // Categorization check
    const categories = new Set(report.items.map((i) => i.category));
    expect(categories.has('native_hook_installed')).toBe(true);
    expect(categories.has('native_hook_observed_live')).toBe(true);
    expect(categories.has('sdk_event_observed')).toBe(true);
    expect(categories.has('omcu_domain_event')).toBe(true);
    expect(categories.has('unsupported_not_run')).toBe(true);

    const liveItem = report.items.find((i) => i.category === 'native_hook_observed_live');
    expect(liveItem?.status).toBe('not_run');

    const unsupportedItem = report.items.find((i) => i.category === 'unsupported_not_run');
    expect(unsupportedItem?.status).toBe('not_run');
  });

  it('runs doctor with live probe and confirms roundtrip with nonce matching', async () => {
    const report = await runHooksDoctor({ cwd: packageRoot, live: true });

    expect(report.ok).toBe(true);
    const liveItem = report.items.find((i) => i.name === 'native_hook_live_probe');
    expect(liveItem).toBeDefined();
    expect(liveItem?.status).toBe('ok');
    expect(liveItem?.message).toContain('Live hook roundtrip verified');
    expect(liveItem?.details).toMatchObject({
      provenance: 'omcu',
      version: '0.3.0',
    });
  });
});
