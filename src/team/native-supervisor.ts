import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '@cursor/sdk';
import { assertExclusivePathClaims } from '../modes/path-claims.js';
import { atomicWriteJson } from '../runtime/atomic.js';
import type { StateRoot } from '../runtime/state-root.js';
import type {
  NativeTeamManifest,
  NativeTeamStatus,
  NativeTeamWorkerManifest,
  TeamCollection,
  TeamWorkerSpec,
} from './types.js';

async function getSdkAgent(): Promise<typeof Agent> {
  const sdk = await import('@cursor/sdk');
  return sdk.Agent;
}

export class CursorNativeTeamSupervisor {
  private readonly dir: string;

  constructor(public readonly rootOrWorkspace: StateRoot | string) {
    const basePath = typeof rootOrWorkspace === 'string' ? rootOrWorkspace : rootOrWorkspace.path;
    this.dir = path.join(path.resolve(basePath), 'teams');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private manifestPath(teamId: string): string {
    const sanitized = teamId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `native-${sanitized}.json`);
  }

  saveManifest(manifest: NativeTeamManifest): void {
    atomicWriteJson(this.manifestPath(manifest.team_id), manifest);
  }

  loadManifest(teamId: string): NativeTeamManifest | null {
    const file = this.manifestPath(teamId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content) as NativeTeamManifest;
      if (parsed.schema_version !== 2 || !parsed.native_cursor_team) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async start(
    teamId: string,
    workers: readonly TeamWorkerSpec[],
    options?: { runtime?: 'local' | 'cloud' }
  ): Promise<NativeTeamManifest> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(teamId)) {
      throw new Error('E_TEAM_ID_INVALID: invalid team id');
    }
    if (workers.length < 1 || workers.length > 16) {
      throw new Error('E_TEAM_WORKER_COUNT_INVALID: worker count must be between 1 and 16');
    }

    const workerIds = new Set<string>();
    for (const w of workers) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(w.id)) {
        throw new Error(`E_TEAM_WORKER_ID_INVALID: '${w.id}'`);
      }
      if (workerIds.has(w.id)) {
        throw new Error(`E_TEAM_WORKER_ID_CONFLICT: duplicate worker id '${w.id}'`);
      }
      workerIds.add(w.id);
      if (!path.isAbsolute(w.cwd)) {
        throw new Error(`E_TEAM_WORKER_CWD_INVALID: '${w.cwd}' must be absolute`);
      }
      if (!Array.isArray(w.owned_paths) || w.owned_paths.length === 0) {
        throw new Error(`E_TEAM_WORKER_PATHS_INVALID: '${w.id}' must declare owned paths`);
      }
    }

    // Validate path claims per distinct working directory
    const cwdGroups = new Map<string, TeamWorkerSpec[]>();
    for (const w of workers) {
      const group = cwdGroups.get(w.cwd) ?? [];
      group.push(w);
      cwdGroups.set(w.cwd, group);
    }

    for (const group of cwdGroups.values()) {
      if (group.length > 1) {
        assertExclusivePathClaims(
          group.map((w) => ({ ownerId: w.id, paths: w.owned_paths })),
          {
            invalid: 'E_TEAM_PATH_INVALID',
            conflict: (owner, claimant) =>
              `E_TEAM_PATH_CONFLICT: worker '${claimant}' overlaps with worker '${owner}'`,
          }
        );
      }
    }

    const targetRuntime = options?.runtime ?? 'local';
    const now = new Date().toISOString();
    const nativeWorkers: NativeTeamWorkerManifest[] = [];

    const { createCursorRuntime } = await import('../runtime/cursor-sdk/runtime.js');
    for (const w of workers) {
      const runtime = createCursorRuntime({
        target: targetRuntime,
        cwd: w.cwd,
      });

      const agent = await runtime.createAgent();
      const prompt = [
        `Team Worker ${w.id} (Team: ${teamId})`,
        `Objective: ${w.objective}`,
        `Owned Paths: ${w.owned_paths.join(', ')}`,
        'Do not modify paths outside your declared scope.',
      ].join('\n\n');

      const runHandle = await agent.send(prompt);
      nativeWorkers.push({
        id: w.id,
        cwd: w.cwd,
        owned_paths: w.owned_paths,
        agent_id: runHandle.agentId,
        run_id: runHandle.runId,
        status: runHandle.status,
        runtime: targetRuntime,
      });
    }

    const manifest: NativeTeamManifest = {
      schema_version: 2,
      team_id: teamId,
      capability_tier: 'native-cursor-team',
      native_cursor_team: true,
      workers: nativeWorkers,
      created_at: now,
      updated_at: now,
      stopped_at: null,
    };

    this.saveManifest(manifest);
    return manifest;
  }

  async status(teamId: string): Promise<NativeTeamStatus> {
    const manifest = this.loadManifest(teamId);
    if (!manifest) {
      throw new Error(`E_TEAM_MANIFEST_ABSENT: native team '${teamId}' not found`);
    }

    const agentClass = await getSdkAgent();
    const workerStatuses = await Promise.all(
      manifest.workers.map(async (w) => {
        let currentStatus = w.status;
        try {
          const run = await agentClass.getRun(w.run_id);
          if (run && run.status) {
            currentStatus = run.status;
          }
        } catch {
          // If query fails, retain last known status
        }
        return {
          id: w.id,
          agent_id: w.agent_id,
          run_id: w.run_id,
          status: currentStatus,
          runtime: w.runtime,
        };
      })
    );

    const anyActive = workerStatuses.some(
      (w) => w.status === 'running' || w.status === 'created' || w.status === 'in_progress'
    );

    return {
      team_id: manifest.team_id,
      capability_tier: 'native-cursor-team',
      native_cursor_team: true,
      active: anyActive && manifest.stopped_at === null,
      workers: workerStatuses,
    };
  }

  async monitor(teamId: string): Promise<string> {
    const stat = await this.status(teamId);
    const lines = [
      `Team: ${stat.team_id} (native_cursor_team: true, tier: ${stat.capability_tier})`,
      `Active: ${stat.active}`,
      'Workers:',
      ...stat.workers.map(
        (w) => `  - ${w.id}: status=${w.status} agent=${w.agent_id} run=${w.run_id} runtime=${w.runtime}`
      ),
    ];
    return lines.join('\n');
  }

  async resume(teamId: string): Promise<NativeTeamManifest> {
    const manifest = this.loadManifest(teamId);
    if (!manifest) {
      throw new Error(`E_TEAM_MANIFEST_ABSENT: native team '${teamId}' not found`);
    }

    const { createCursorRuntime } = await import('../runtime/cursor-sdk/runtime.js');
    const updatedWorkers: NativeTeamWorkerManifest[] = [];
    for (const w of manifest.workers) {
      const runtime = createCursorRuntime({
        target: w.runtime,
        cwd: w.cwd,
      });
      try {
        const agent = await runtime.resumeAgent(w.agent_id);
        const runHandle = await agent.send(`Resume execution for worker ${w.id}`);
        updatedWorkers.push({
          ...w,
          run_id: runHandle.runId,
          status: runHandle.status,
        });
      } catch {
        updatedWorkers.push(w);
      }
    }

    const updatedManifest: NativeTeamManifest = {
      ...manifest,
      workers: updatedWorkers,
      updated_at: new Date().toISOString(),
      stopped_at: null,
    };

    this.saveManifest(updatedManifest);
    return updatedManifest;
  }

  async shutdown(teamId: string): Promise<NativeTeamManifest> {
    const manifest = this.loadManifest(teamId);
    if (!manifest) {
      throw new Error(`E_TEAM_MANIFEST_ABSENT: native team '${teamId}' not found`);
    }

    const agentClass = await getSdkAgent();
    for (const w of manifest.workers) {
      try {
        await agentClass.cancelRun(w.run_id);
      } catch {
        // Best effort
      }
    }

    const now = new Date().toISOString();
    const updatedWorkers = manifest.workers.map((w) => ({
      ...w,
      status: 'cancelled',
    }));

    const updatedManifest: NativeTeamManifest = {
      ...manifest,
      workers: updatedWorkers,
      updated_at: now,
      stopped_at: now,
    };

    this.saveManifest(updatedManifest);
    return updatedManifest;
  }

  async collect(teamId: string): Promise<TeamCollection> {
    const manifest = this.loadManifest(teamId);
    if (!manifest) {
      throw new Error(`E_TEAM_MANIFEST_ABSENT: native team '${teamId}' not found`);
    }

    const agentClass = await getSdkAgent();
    const outputs: Record<string, string> = {};
    for (const w of manifest.workers) {
      try {
        const run = await agentClass.getRun(w.run_id);
        const resultText = (run as unknown as { result?: { result?: string } })?.result?.result
          ?? (run as unknown as { result?: string })?.result
          ?? '';
        outputs[w.id] = resultText;
      } catch {
        outputs[w.id] = '';
      }
    }

    return {
      team_id: teamId,
      outputs,
      collected_at: new Date().toISOString(),
      verified: false,
      verification_authority: 'omcu-cli-only',
    };
  }
}
