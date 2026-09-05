import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition } from '../types.js';
import { CANONICAL_COMPONENT_DEFS } from '../../catalog/manifest.js';

export function createDomainTools(): ToolDefinition[] {
  const goalTool: ToolDefinition = {
    name: 'domain_workflow_goal',
    aliases: ['workflow_goal', 'omcu_goal'],
    description: 'Query or update the active workflow goal and state in .omcu/state/goal.json.',
    provider: 'domain',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'Get or set goal' },
        goal: { type: 'string', description: 'Goal description' },
        phase: { type: 'string', description: 'Associated workflow phase' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Goal tags',
        },
      },
      required: ['action'],
    },
    execute: async (args, _context, env) => {
      const action = String(args.action);
      const rootDir = env?.projectRoot ?? process.cwd();
      const stateDir = path.join(rootDir, '.omcu', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const goalFile = path.join(stateDir, 'goal.json');

      if (action === 'get') {
        if (!fs.existsSync(goalFile)) {
          return JSON.stringify({ active: false, goal: null }, null, 2);
        }
        const data = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
        return JSON.stringify({ active: true, ...data }, null, 2);
      }

      if (action === 'set') {
        const goal = String(args.goal ?? '');
        const phase = args.phase ? String(args.phase) : 'init';
        const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
        const payload = {
          goal,
          phase,
          tags,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(goalFile, JSON.stringify(payload, null, 2), 'utf8');
        return JSON.stringify({ active: true, ...payload }, null, 2);
      }

      throw new Error(`Unsupported goal action: ${action}`);
    },
  };

  const phaseTool: ToolDefinition = {
    name: 'domain_phase_update',
    aliases: ['phase_update', 'omcu_phase'],
    description: 'Update the active workflow phase in .omcu/state/phase.json.',
    provider: 'domain',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', description: 'Target workflow phase name' },
        notes: { type: 'string', description: 'Optional phase transition notes' },
      },
      required: ['phase'],
    },
    execute: async (args, _context, env) => {
      const phase = String(args.phase);
      const notes = args.notes ? String(args.notes) : undefined;
      const rootDir = env?.projectRoot ?? process.cwd();
      const stateDir = path.join(rootDir, '.omcu', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const phaseFile = path.join(stateDir, 'phase.json');

      const payload = {
        phase,
        notes,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(phaseFile, JSON.stringify(payload, null, 2), 'utf8');
      return JSON.stringify(payload, null, 2);
    },
  };

  const artifactRecordTool: ToolDefinition = {
    name: 'domain_artifact_record',
    aliases: ['artifact_record', 'omcu_record_artifact'],
    description: 'Record an evidence or execution artifact under .omcu/artifacts/<category>/<name>.',
    provider: 'domain',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Artifact category (e.g. tools, reviews, qa)' },
        name: { type: 'string', description: 'File name' },
        content: { type: 'string', description: 'Artifact content' },
        mimeType: { type: 'string', description: 'MIME type (default text/plain or application/json)' },
      },
      required: ['category', 'name', 'content'],
    },
    execute: async (args, _context, env) => {
      const category = String(args.category).replace(/[^a-zA-Z0-9_-]/g, '_');
      const name = String(args.name).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const content = String(args.content);
      const rootDir = env?.projectRoot ?? process.cwd();

      const targetDir = path.join(rootDir, '.omcu', 'artifacts', category);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, name);

      fs.writeFileSync(targetPath, content, 'utf8');

      const sizeBytes = Buffer.byteLength(content, 'utf8');
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);

      return JSON.stringify(
        {
          recorded: true,
          category,
          name,
          artifactPath: path.relative(rootDir, targetPath),
          sizeBytes,
          sha256Prefix: hash,
        },
        null,
        2
      );
    },
  };

  const sdkInspectTool: ToolDefinition = {
    name: 'domain_sdk_inspect',
    aliases: ['sdk_inspect', 'omcu_sdk_inspect'],
    description: 'Inspect Cursor SDK runs, agents, and local store documents.',
    provider: 'domain',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Optional agent ID filter' },
        runId: { type: 'string', description: 'Optional run ID filter' },
      },
    },
    execute: async (args, _context, env) => {
      const rootDir = env?.projectRoot ?? process.cwd();
      const storeDir = path.join(rootDir, '.omcu', 'agent-store');

      if (!fs.existsSync(storeDir)) {
        return JSON.stringify({ exists: false, runs: [], agents: [] }, null, 2);
      }

      // Check runs.jsonl or agents.jsonl
      const runsFile = path.join(storeDir, 'runs.jsonl');
      const agentsFile = path.join(storeDir, 'agents.jsonl');

      let runs: unknown[] = [];
      let agents: unknown[] = [];

      if (fs.existsSync(runsFile)) {
        runs = fs
          .readFileSync(runsFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }

      if (fs.existsSync(agentsFile)) {
        agents = fs
          .readFileSync(agentsFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }

      if (args.runId) {
        runs = runs.filter((r: unknown) => (r as { id?: string }).id === args.runId);
      }
      if (args.agentId) {
        agents = agents.filter((a: unknown) => (a as { id?: string }).id === args.agentId);
        runs = runs.filter((r: unknown) => (r as { agentId?: string }).agentId === args.agentId);
      }

      return JSON.stringify({ exists: true, runs, agents }, null, 2);
    },
  };

  const profileInspectTool: ToolDefinition = {
    name: 'domain_profile_inspect',
    aliases: ['catalog_inspect', 'omcu_profile_inspect'],
    description: 'Inspect catalog components, agent profiles, and skills registered in OMCU.',
    provider: 'domain',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional component name, alias, or skill query' },
        type: { type: 'string', enum: ['skill', 'role', 'command', 'hook'], description: 'Component type filter' },
      },
    },
    execute: async (args) => {
      const query = args.query ? String(args.query).toLowerCase() : undefined;
      const typeFilter = args.type ? String(args.type) : undefined;

      let components = CANONICAL_COMPONENT_DEFS.map((c) => ({
        id: c.id,
        type: c.type,
        canonicalName: c.canonicalName,
        aliases: c.aliases,
        supportTier: c.supportTier,
        description: c.description,
      }));

      if (typeFilter) {
        components = components.filter((c) => c.type === typeFilter);
      }

      if (query) {
        components = components.filter(
          (c) =>
            c.canonicalName.toLowerCase().includes(query) ||
            c.aliases.some((a) => a.toLowerCase().includes(query)) ||
            c.description.toLowerCase().includes(query)
        );
      }

      return JSON.stringify({ count: components.length, components }, null, 2);
    },
  };

  return [goalTool, phaseTool, artifactRecordTool, sdkInspectTool, profileInspectTool];
}
