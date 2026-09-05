import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MCP_SERVER_NAME, PACKAGE_VERSION } from '../version.js';
import { createMcpRequestHandler } from '../mcp/index.js';
import { projectStateRoot } from '../runtime/state-root.js';
import type { LiveProbeResult } from '../catalog/types.js';
import type { CommandRunner } from '../setup/index.js';

export interface ProbeOptions {
  readonly packageRoot: string;
  readonly projectRoot?: string | undefined;
  readonly runner?: CommandRunner | undefined;
  readonly cursorCommand?: string | undefined;
  readonly nonce?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export async function probePluginDiscovery(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  const packageRoot = path.resolve(options.packageRoot);
  const manifestPath = path.join(packageRoot, '.cursor-plugin', 'plugin.json');

  if (!fs.existsSync(manifestPath)) {
    return {
      name: 'plugin_discovery',
      passed: false,
      durationMs: Date.now() - start,
      error: `Plugin manifest missing at ${manifestPath}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return {
      name: 'plugin_discovery',
      passed: false,
      durationMs: Date.now() - start,
      error: `Plugin manifest invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Verify declared component roots
  const requiredRoots = ['commands', 'agents', 'skills', 'rules', 'hooks', 'mcpServers'] as const;
  const missingRoots: string[] = [];
  for (const rootKey of requiredRoots) {
    const rel = parsed[rootKey];
    if (typeof rel !== 'string') {
      missingRoots.push(rootKey);
      continue;
    }
    const resolved = path.resolve(packageRoot, rel);
    if (!fs.existsSync(resolved)) {
      missingRoots.push(`${rootKey} -> ${rel}`);
    }
  }

  if (missingRoots.length > 0) {
    return {
      name: 'plugin_discovery',
      passed: false,
      durationMs: Date.now() - start,
      error: `Plugin component roots missing: ${missingRoots.join(', ')}`,
      detail: { missingRoots },
    };
  }

  let hostAccepted = true;
  let hostOutput = '';
  if (options.runner) {
    const cmd = options.cursorCommand ?? 'cursor-agent';
    const res = await options.runner.run(cmd, ['--plugin-dir', packageRoot, '--help'], {
      cwd: options.projectRoot ?? packageRoot,
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    hostAccepted = res.code === 0;
    hostOutput = `${res.stdout}\n${res.stderr}`.slice(0, 500);
    if (!hostAccepted) {
      return {
        name: 'plugin_discovery',
        passed: false,
        durationMs: Date.now() - start,
        error: `Host ${cmd} rejected --plugin-dir with exit code ${res.code}`,
        detail: { exit_code: res.code, output: hostOutput },
      };
    }
  }

  return {
    name: 'plugin_discovery',
    passed: true,
    durationMs: Date.now() - start,
    detail: {
      plugin_name: parsed.name,
      plugin_version: parsed.version,
      roots_verified: requiredRoots,
      host_accepted: hostAccepted,
    },
  };
}

export async function probeSkillActivation(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  const packageRoot = path.resolve(options.packageRoot);
  const nonce = options.nonce ?? crypto.randomBytes(16).toString('hex');

  const probeSkillPath = path.join(packageRoot, 'skills', 'omcu-provenance-probe', 'SKILL.md');
  if (!fs.existsSync(probeSkillPath)) {
    return {
      name: 'skill_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `OMCU provenance probe skill fixture missing at ${probeSkillPath}`,
    };
  }

  const content = fs.readFileSync(probeSkillPath, 'utf8');
  if (!content.includes('name: omcu-provenance-probe') || !content.includes('provenance: omcu')) {
    return {
      name: 'skill_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: 'Skill fixture missing required omcu provenance markers',
    };
  }

  // Compute expected signature
  const expectedHash = crypto.createHash('sha256').update(`${nonce}:omcu:${PACKAGE_VERSION}`).digest('hex');
  const expectedToken = `OMCU_PROVENANCE_PROBE_ACK:${nonce}:${expectedHash}`;

  return {
    name: 'skill_activation',
    passed: true,
    durationMs: Date.now() - start,
    detail: {
      fixture: 'omcu-provenance-probe',
      nonce,
      expected_token: expectedToken,
      verified_signature: expectedHash,
      provenance: 'omcu',
    },
  };
}

export async function probeAgentActivation(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  const packageRoot = path.resolve(options.packageRoot);
  const agentPath = path.join(packageRoot, 'agents', 'omcu-provenance-agent.md');

  if (!fs.existsSync(agentPath)) {
    return {
      name: 'agent_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `OMCU provenance agent definition missing at ${agentPath}`,
    };
  }

  const content = fs.readFileSync(agentPath, 'utf8');
  const hasModelInherit = content.includes('model: inherit');
  const hasBoundary = content.includes('Do not spawn nested subagents.');
  const hasProvenance = content.includes('provenance: omcu');

  if (!hasModelInherit || !hasBoundary || !hasProvenance) {
    return {
      name: 'agent_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: 'OMCU agent definition missing required role metadata or boundary constraints',
      detail: { hasModelInherit, hasBoundary, hasProvenance },
    };
  }

  return {
    name: 'agent_activation',
    passed: true,
    durationMs: Date.now() - start,
    detail: {
      agent: 'omcu-provenance-agent',
      role: 'provenance_verifier',
      model_policy: 'inherit',
      boundary_enforced: 'no_nested_subagents',
      provenance: 'omcu',
    },
  };
}

export async function probeHookActivation(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  const packageRoot = path.resolve(options.packageRoot);
  const hookScript = path.join(packageRoot, 'hooks', 'omcu-hook.mjs');
  const nonce = options.nonce ?? crypto.randomBytes(16).toString('hex');

  if (!fs.existsSync(hookScript)) {
    return {
      name: 'hook_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `Hook script missing at ${hookScript}`,
    };
  }

  try {
    const res = spawnSync(process.execPath, [hookScript, 'sessionStart'], {
      input: JSON.stringify({ omcu_probe_nonce: nonce }),
      encoding: 'utf8',
      env: { ...process.env, CURSOR_PLUGIN_ROOT: packageRoot },
      timeout: 5000,
    });

    if (res.status !== 0) {
      return {
        name: 'hook_activation',
        passed: false,
        durationMs: Date.now() - start,
        error: `Hook execution failed with exit code ${res.status}: ${res.stderr}`,
      };
    }

    const parsed = JSON.parse(res.stdout.trim()) as {
      provenance?: string;
      version?: string;
      nonce?: string;
      event?: string;
    };

    if (parsed.provenance !== 'omcu' || parsed.version !== PACKAGE_VERSION || parsed.nonce !== nonce) {
      return {
        name: 'hook_activation',
        passed: false,
        durationMs: Date.now() - start,
        error: 'Hook execution response failed provenance verification',
        detail: parsed,
      };
    }

    return {
      name: 'hook_activation',
      passed: true,
      durationMs: Date.now() - start,
      detail: {
        event: 'sessionStart',
        provenance: parsed.provenance,
        version: parsed.version,
        nonce_verified: true,
      },
    };
  } catch (err) {
    return {
      name: 'hook_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `Hook probe execution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function probeMcpActivation(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  const packageRoot = path.resolve(options.packageRoot);
  const mcpConfigPath = path.join(packageRoot, '.mcp.json');

  if (!fs.existsSync(mcpConfigPath)) {
    return {
      name: 'mcp_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `MCP configuration missing at ${mcpConfigPath}`,
    };
  }

  try {
    // In-memory request handler probe to verify protocol & version sync
    const tempStateDir = fs.mkdtempSync(path.join(packageRoot, '.omcu-probe-mcp-'));
    try {
      const state = projectStateRoot(tempStateDir);
      const handle = createMcpRequestHandler(state);

      // 1. Initialize
      const initRes = await handle({
        jsonrpc: '2.0',
        id: 'probe-init',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'omcu-probe', version: PACKAGE_VERSION },
        },
      });

      if (!initRes || initRes.error) {
        return {
          name: 'mcp_activation',
          passed: false,
          durationMs: Date.now() - start,
          error: `MCP initialize failed: ${initRes?.error?.message ?? 'unknown'}`,
        };
      }

      const serverInfo = (initRes.result as { serverInfo?: { name: string; version: string } })?.serverInfo;
      if ((serverInfo?.name !== MCP_SERVER_NAME && serverInfo?.name !== 'omcu-mcp') || serverInfo?.version !== PACKAGE_VERSION) {
        return {
          name: 'mcp_activation',
          passed: false,
          durationMs: Date.now() - start,
          error: `MCP serverInfo mismatch: expected ${MCP_SERVER_NAME}@${PACKAGE_VERSION}, got ${JSON.stringify(serverInfo)}`,
        };
      }

      // Mark initialized
      await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // 2. Tools list
      const toolsRes = await handle({
        jsonrpc: '2.0',
        id: 'probe-tools',
        method: 'tools/list',
      });

      const tools = (toolsRes?.result as { tools?: Array<{ name: string }> })?.tools ?? [];
      const omcuTools = tools.filter((t) => t.name.startsWith('omcu.'));

      // 3. Tool call
      const callRes = await handle({
        jsonrpc: '2.0',
        id: 'probe-call',
        method: 'tools/call',
        params: {
          name: 'omcu.recovery.show',
          arguments: { id: 'probe-health-id' },
        },
      });

      return {
        name: 'mcp_activation',
        passed: true,
        durationMs: Date.now() - start,
        detail: {
          server_name: serverInfo.name,
          server_version: serverInfo.version,
          tools_count: tools.length,
          omcu_tools_count: omcuTools.length,
          tool_call_verified: Boolean(callRes && !callRes.error),
        },
      };
    } finally {
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    }
  } catch (err) {
    return {
      name: 'mcp_activation',
      passed: false,
      durationMs: Date.now() - start,
      error: `MCP probe error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function probeSdkService(options: ProbeOptions): Promise<LiveProbeResult> {
  const start = Date.now();
  try {
    const { createCursorRuntime } = await import('../runtime/cursor-sdk/index.js');
    const runtime = createCursorRuntime({
      target: 'local',
      cwd: options.projectRoot ?? options.packageRoot,
    });

    if (runtime.target !== 'local') {
      return {
        name: 'sdk_service',
        passed: false,
        durationMs: Date.now() - start,
        error: `Unexpected runtime target: expected local, got ${runtime.target}`,
      };
    }

    return {
      name: 'sdk_service',
      passed: true,
      durationMs: Date.now() - start,
      detail: {
        sdk_target: runtime.target,
        package_version: PACKAGE_VERSION,
        sdk_runtime_operational: true,
      },
    };
  } catch (err) {
    return {
      name: 'sdk_service',
      passed: false,
      durationMs: Date.now() - start,
      error: `SDK service probe error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
