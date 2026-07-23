import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = (relative: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Record<string, unknown>;
const workflowNames = ['setup', 'doctor', 'resume', 'recover', 'workflow', 'ralplan', 'ralph', 'ulw', 'autopilot', 'team', 'review', 'qa', 'accept'] as const;

const pluginAllowed = new Set([
  'name', 'displayName', 'description', 'version', 'author', 'publisher', 'homepage', 'repository', 'license', 'logo',
  'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules', 'hooks', 'mcpServers',
]);
const marketplaceAllowed = new Set(['name', 'owner', 'metadata', 'plugins']);

function componentPath(value: unknown): string {
  expect(typeof value).toBe('string');
  return path.resolve(root, value as string);
}

function filesUnder(relative: string): string[] {
  const start = path.join(root, relative);
  const output: string[] = [];
  const visit = (entry: string): void => {
    for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
      const target = path.join(entry, child.name);
      if (child.isDirectory()) visit(target);
      else output.push(target);
    }
  };
  visit(start);
  return output;
}

describe('Cursor plugin surfaces', () => {
  it('uses only fields accepted by the official Cursor manifest schemas', () => {
    const plugin = readJson('.cursor-plugin/plugin.json');
    expect(plugin.name).toBe('oh-my-cursor');
    expect(Object.keys(plugin).every((key) => pluginAllowed.has(key))).toBe(true);
    for (const field of ['commands', 'agents', 'skills', 'rules', 'hooks', 'mcpServers']) {
      expect(fs.existsSync(componentPath(plugin[field]))).toBe(true);
    }

    const marketplace = readJson('.cursor-plugin/marketplace.json');
    expect(Object.keys(marketplace).every((key) => marketplaceAllowed.has(key))).toBe(true);
    expect(marketplace.plugins).toEqual([
      { name: 'oh-my-cursor', source: '.', description: plugin.description },
    ]);
    expect(readJson('.mcp.json')).toEqual({ mcpServers: {} });
  });

  it('ships matching slash commands and Agent Skills for every workflow surface', () => {
    for (const name of workflowNames) {
      const command = fs.readFileSync(path.join(root, 'commands', `${name}.md`), 'utf8');
      const skill = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
      expect(command).toContain(`\`${name}\` skill`);
      expect(skill).toContain(`name: ${name}`);
      expect(skill).toContain('## Guardrails');
    }
  });

  it('ships loadable custom agent definitions with one-level delegation boundaries', () => {
    const agentFiles = filesUnder('agents');
    expect(agentFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of agentFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toMatch(/^---\nname: [a-z0-9-]+\ndescription: .+\nmodel: inherit\n/m);
      expect(content).toContain('Do not spawn nested subagents.');
    }
  });

  it('contains no stale platform names or foreign-agent default worker instructions', () => {
    const files = [
      '.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json', '.mcp.json',
      ...filesUnder('commands').map((file) => path.relative(root, file)),
      ...filesUnder('skills').map((file) => path.relative(root, file)),
      ...filesUnder('agents').map((file) => path.relative(root, file)),
      ...filesUnder('hooks').map((file) => path.relative(root, file)),
      ...filesUnder('templates').map((file) => path.relative(root, file)),
      ...filesUnder('.cursor').map((file) => path.relative(root, file)),
    ];
    const combined = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    expect(combined).not.toMatch(/\b(?:OMG|OMA|Grok|Antigravity)\b/i);
    expect(combined).not.toMatch(/(?:spawn|launch|invoke|run)\s+(?:the\s+)?(?:claude|codex|gemini|grok)\b/i);
  });

  it('keeps the AGENTS fragment bounded and state ownership explicit', () => {
    const fragment = fs.readFileSync(path.join(root, 'templates/AGENTS.md.fragment'), 'utf8');
    expect(fragment.match(/<!-- OMCU:AGENTS:START -->/g)).toHaveLength(1);
    expect(fragment.match(/<!-- OMCU:AGENTS:END -->/g)).toHaveLength(1);
    expect(fragment).toContain('CLI-owned state');
  });
});
