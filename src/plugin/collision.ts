import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_COMPONENT_DEFS, fileSha256 } from '../catalog/manifest.js';
import type { CollisionRecord, ComponentType } from '../catalog/types.js';

export interface CollisionScanOptions {
  readonly packageRoot: string;
  readonly projectRoot?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly stateRoot?: string | undefined;
}

function safeStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function findFilesInDir(dir: string, matcher: (fileName: string, fullPath: string) => boolean): string[] {
  const matches: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        matches.push(...findFilesInDir(full, matcher));
      } else if (matcher(entry.name, full)) {
        matches.push(full);
      }
    }
  } catch {
    // Ignore unreadable directories
  }
  return matches;
}

export function detectFileProvenance(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/.omc/') || normalized.endsWith('/.omc')) return 'foreign_omc';
  if (normalized.includes('/.omx/') || normalized.endsWith('/.omx')) return 'foreign_omx';
  if (normalized.includes('/.omg/') || normalized.endsWith('/.omg')) return 'foreign_omg';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('provenance: omcu') || content.includes('[omcu:')) {
      return 'omcu_native';
    }
  } catch {
    // Ignore read errors
  }
  return 'foreign_unrecognized';
}

export function scanComponentCollisions(options: CollisionScanOptions): CollisionRecord[] {
  const packageRoot = path.resolve(options.packageRoot);
  const projectRoot = path.resolve(options.projectRoot ?? packageRoot);
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? '');
  const collisions: CollisionRecord[] = [];

  // Discovery roots to inspect
  const candidateRoots: { readonly path: string; readonly label: string }[] = [];

  // Project roots
  if (projectRoot !== packageRoot) {
    candidateRoots.push(
      { path: path.join(projectRoot, 'skills'), label: 'project:skills' },
      { path: path.join(projectRoot, '.cursor', 'skills'), label: 'project:.cursor/skills' },
      { path: path.join(projectRoot, 'agents'), label: 'project:agents' },
      { path: path.join(projectRoot, '.cursor', 'agents'), label: 'project:.cursor/agents' },
      { path: path.join(projectRoot, '.cursor', 'rules'), label: 'project:.cursor/rules' },
      { path: path.join(projectRoot, '.omc'), label: 'foreign:.omc' },
      { path: path.join(projectRoot, '.omc', 'skills'), label: 'foreign:.omc/skills' },
      { path: path.join(projectRoot, '.omc', 'agents'), label: 'foreign:.omc/agents' },
      { path: path.join(projectRoot, '.omx'), label: 'foreign:.omx' },
      { path: path.join(projectRoot, '.omx', 'skills'), label: 'foreign:.omx/skills' },
      { path: path.join(projectRoot, '.omx', 'agents'), label: 'foreign:.omx/agents' },
      { path: path.join(projectRoot, '.omg'), label: 'foreign:.omg' },
      { path: path.join(projectRoot, '.omg', 'skills'), label: 'foreign:.omg/skills' },
      { path: path.join(projectRoot, '.omg', 'agents'), label: 'foreign:.omg/agents' },
    );
  }

  // User roots
  if (homeDir) {
    candidateRoots.push(
      { path: path.join(homeDir, '.cursor', 'skills'), label: 'user:.cursor/skills' },
      { path: path.join(homeDir, '.cursor', 'agents'), label: 'user:.cursor/agents' },
      { path: path.join(homeDir, '.cursor', 'rules'), label: 'user:.cursor/rules' },
      { path: path.join(homeDir, '.omc'), label: 'user:foreign:.omc' },
      { path: path.join(homeDir, '.omc', 'skills'), label: 'user:foreign:.omc/skills' },
      { path: path.join(homeDir, '.omc', 'agents'), label: 'user:foreign:.omc/agents' },
      { path: path.join(homeDir, '.omx'), label: 'user:foreign:.omx' },
      { path: path.join(homeDir, '.omx', 'skills'), label: 'user:foreign:.omx/skills' },
      { path: path.join(homeDir, '.omx', 'agents'), label: 'user:foreign:.omx/agents' },
      { path: path.join(homeDir, '.omg'), label: 'user:foreign:.omg' },
      { path: path.join(homeDir, '.omg', 'skills'), label: 'user:foreign:.omg/skills' },
      { path: path.join(homeDir, '.omg', 'agents'), label: 'user:foreign:.omg/agents' },
    );
  }

  // For each component definition
  for (const def of CANONICAL_COMPONENT_DEFS) {
    const namesToScan = new Set([def.canonicalName, ...def.aliases]);
    const foundPaths: { path: string; provenance: string; hash: string }[] = [];

    for (const root of candidateRoots) {
      if (!safeStat(root.path)) continue;

      for (const name of namesToScan) {
        // Skill check: <root>/<name>/SKILL.md or <root>/<name>.md
        if (def.type === 'skill') {
          const skillFile = path.join(root.path, name, 'SKILL.md');
          if (safeStat(skillFile)?.isFile()) {
            foundPaths.push({
              path: skillFile,
              provenance: detectFileProvenance(skillFile),
              hash: fileSha256(skillFile),
            });
          }
          const flatSkill = path.join(root.path, `${name}.md`);
          if (safeStat(flatSkill)?.isFile()) {
            foundPaths.push({
              path: flatSkill,
              provenance: detectFileProvenance(flatSkill),
              hash: fileSha256(flatSkill),
            });
          }
        }

        // Agent check: <root>/<name>.md
        if (def.type === 'agent') {
          const agentFile = path.join(root.path, `${name}.md`);
          if (safeStat(agentFile)?.isFile()) {
            foundPaths.push({
              path: agentFile,
              provenance: detectFileProvenance(agentFile),
              hash: fileSha256(agentFile),
            });
          }
        }

        // Rule check: <root>/<name>.mdc
        if (def.type === 'rule') {
          const ruleFile = path.join(root.path, `${name}.mdc`);
          if (safeStat(ruleFile)?.isFile()) {
            foundPaths.push({
              path: ruleFile,
              provenance: detectFileProvenance(ruleFile),
              hash: fileSha256(ruleFile),
            });
          }
        }
      }
    }

    // Filter out identical paths
    const uniquePaths = Array.from(new Map(foundPaths.map((p) => [p.path, p])).values());

    // If foreign or external paths exist that match aliases or canonical names
    for (const found of uniquePaths) {
      if (found.provenance !== 'omcu_native') {
        const expectedFile = path.join(packageRoot, def.nativeCursorPath);
        const expectedHash = safeStat(expectedFile) ? fileSha256(expectedFile) : undefined;
        const compName = path.basename(found.path).toLowerCase() === 'skill.md'
          ? path.basename(path.dirname(found.path))
          : path.basename(found.path, path.extname(found.path));
        const isCanonicalCollision = compName === def.canonicalName;

        collisions.push({
          componentName: compName,
          type: def.type,
          sourcePaths: [found.path],
          provenance: found.provenance,
          ...(expectedHash !== undefined ? { expectedHash } : {}),
          observedHash: found.hash,
          resolutionSupport: 'Undocumented path precedence: foreign or project-local file may silently shadow plugin component',
          canonicalReplacement: def.canonicalName,
          severity: isCanonicalCollision ? 'error' : 'warning',
          message: `Collision detected for ${def.type} "${def.canonicalName}" at "${found.path}" (${found.provenance}). Use canonical "${def.canonicalName}" to ensure deterministic resolution.`,
        });
      }
    }
  }

  return collisions;
}
