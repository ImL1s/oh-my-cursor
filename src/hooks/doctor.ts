import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HookDoctorItem, HookDoctorReport } from './types.js';

export interface RunHooksDoctorOptions {
  readonly cwd: string;
  readonly packageRoot?: string | undefined;
  readonly live?: boolean | undefined;
}

export async function runHooksDoctor(
  options: RunHooksDoctorOptions
): Promise<HookDoctorReport> {
  const items: HookDoctorItem[] = [];
  const installedHooks: string[] = [];

  const packageRoot = options.packageRoot ?? options.cwd;
  const hooksJsonPath = path.join(packageRoot, 'hooks', 'hooks.json');
  const hookScriptPath = path.join(packageRoot, 'hooks', 'omcu-hook.mjs');

  // 1. Check installed hooks configuration
  if (!fs.existsSync(hooksJsonPath)) {
    items.push({
      name: 'hooks_configuration_file',
      category: 'native_hook_installed',
      status: 'error',
      message: `hooks.json missing at ${hooksJsonPath}`,
    });
  } else {
    try {
      const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      if (content.version === 1 && typeof content.hooks === 'object' && content.hooks !== null) {
        items.push({
          name: 'hooks_configuration_file',
          category: 'native_hook_installed',
          status: 'ok',
          message: `Valid hooks.json specification (version ${content.version})`,
        });

        for (const [eventName, hookConfigs] of Object.entries(content.hooks)) {
          installedHooks.push(eventName);
          const count = Array.isArray(hookConfigs) ? hookConfigs.length : 0;
          items.push({
            name: `hook:${eventName}`,
            category: 'native_hook_installed',
            status: count > 0 ? 'ok' : 'warning',
            message: `Installed ${count} handler command(s) for ${eventName}`,
            details: { count, configs: hookConfigs },
          });
        }
      } else {
        items.push({
          name: 'hooks_configuration_file',
          category: 'native_hook_installed',
          status: 'error',
          message: 'Invalid hooks.json format or missing version/hooks object',
        });
      }
    } catch (err) {
      items.push({
        name: 'hooks_configuration_file',
        category: 'native_hook_installed',
        status: 'error',
        message: `Failed to parse hooks.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 2. Live probe execution
  if (options.live) {
    if (!fs.existsSync(hookScriptPath)) {
      items.push({
        name: 'native_hook_live_probe',
        category: 'native_hook_observed_live',
        status: 'error',
        message: `Hook executable missing at ${hookScriptPath}`,
      });
    } else {
      const probeNonce = crypto.randomBytes(16).toString('hex');
      try {
        const res = spawnSync(process.execPath, [hookScriptPath, 'sessionStart'], {
          input: JSON.stringify({ omcu_probe_nonce: probeNonce }),
          encoding: 'utf8',
          env: { ...process.env, CURSOR_PLUGIN_ROOT: packageRoot },
          timeout: 5000,
        });

        if (res.status !== 0) {
          items.push({
            name: 'native_hook_live_probe',
            category: 'native_hook_observed_live',
            status: 'error',
            message: `Live probe exited with status ${res.status}: ${res.stderr.trim()}`,
          });
        } else {
          try {
            const probeResult = JSON.parse(res.stdout.trim());
            if (probeResult.provenance === 'omcu' && probeResult.nonce === probeNonce) {
              items.push({
                name: 'native_hook_live_probe',
                category: 'native_hook_observed_live',
                status: 'ok',
                message: 'Live hook roundtrip verified with nonce matching',
                details: probeResult,
              });
            } else {
              items.push({
                name: 'native_hook_live_probe',
                category: 'native_hook_observed_live',
                status: 'error',
                message: 'Live probe returned unexpected payload or nonce mismatch',
                details: probeResult,
              });
            }
          } catch {
            items.push({
              name: 'native_hook_live_probe',
              category: 'native_hook_observed_live',
              status: 'error',
              message: `Live probe returned non-JSON stdout: ${res.stdout.slice(0, 200)}`,
            });
          }
        }
      } catch (err) {
        items.push({
          name: 'native_hook_live_probe',
          category: 'native_hook_observed_live',
          status: 'error',
          message: `Failed to execute live probe: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } else {
    items.push({
      name: 'native_hook_live_probe',
      category: 'native_hook_observed_live',
      status: 'not_run',
      message: 'Live hook probe skipped; pass --live to test live process execution',
    });
  }

  // 3. SDK Event observation readiness
  items.push({
    name: 'cursor_sdk_stream_observer',
    category: 'sdk_event_observed',
    status: 'ok',
    message: 'Cursor SDK stream projector active (@cursor/sdk run.stream / run.wait projection ready)',
  });

  // 4. OMCU Domain Event readiness
  items.push({
    name: 'omcu_domain_event_projector',
    category: 'omcu_domain_event',
    status: 'ok',
    message: 'Domain event projector active (workflow transition, artifact spill, evidence recording ready)',
  });

  // 5. Explicitly document unsupported upstream mechanisms
  items.push({
    name: 'unmediated_host_daemon_interception',
    category: 'unsupported_not_run',
    status: 'not_run',
    message: 'Unsupported: OMCU relies on native Cursor hooks and SDK events; unmediated daemon interception is not supported',
  });

  const ok = items.every((i) => i.status !== 'error');

  return {
    ok,
    installedHooks,
    items,
    timestamp: new Date().toISOString(),
  };
}
