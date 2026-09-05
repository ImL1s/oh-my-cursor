import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanComponentCollisions, detectFileProvenance } from '../../src/plugin/collision.js';
import { detectActivationModes } from '../../src/plugin/activation-modes.js';
import { PACKAGE_VERSION } from '../../src/version.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');

describe('OMCU collision detection and non-destructive foreign isolation', () => {
  it('detects 0 collisions in a clean project and user environment', () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-clean-project-'));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-clean-home-'));
    try {
      const collisions = scanComponentCollisions({
        packageRoot,
        projectRoot: tempProject,
        homeDir: tempHome,
      });
      expect(collisions).toEqual([]);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('detects conflicting project-local same-named skill without modifying user file', () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-conflict-proj-'));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-conflict-home-'));
    try {
      const localSkillDir = path.join(tempProject, 'skills', 'autopilot');
      fs.mkdirSync(localSkillDir, { recursive: true });
      const userSkillFile = path.join(localSkillDir, 'SKILL.md');
      const userContent = '# Custom User Autopilot\nDo something completely different.\n';
      fs.writeFileSync(userSkillFile, userContent, 'utf8');

      const collisions = scanComponentCollisions({
        packageRoot,
        projectRoot: tempProject,
        homeDir: tempHome,
      });

      expect(collisions.length).toBeGreaterThanOrEqual(1);
      const collision = collisions.find((c) => c.componentName === 'autopilot');
      expect(collision).toBeDefined();
      expect(collision!.canonicalReplacement).toBe('omcu-autopilot');
      expect(collision!.type).toBe('skill');
      expect(collision!.sourcePaths).toContain(userSkillFile);
      expect(collision!.severity).toBe('warning');
      expect(collision!.message).toContain('omcu-autopilot');

      // Crucial requirement: OMCU NEVER deletes/renames/rewrites foreign or user assets!
      expect(fs.readFileSync(userSkillFile, 'utf8')).toBe(userContent);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('identifies foreign OMC/OMX/OMO roots and reports exact provenance and canonical replacement', () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-foreign-proj-'));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-foreign-home-'));
    try {
      // Simulate an old .omc directory with an autopilot skill
      const omcSkillDir = path.join(tempProject, '.omc', 'skills', 'autopilot');
      fs.mkdirSync(omcSkillDir, { recursive: true });
      const omcSkillFile = path.join(omcSkillDir, 'SKILL.md');
      fs.writeFileSync(omcSkillFile, '# Legacy OMC Autopilot\n', 'utf8');

      // Simulate an old .omx directory with an agent
      const omxAgentDir = path.join(tempProject, '.omx', 'agents');
      fs.mkdirSync(omxAgentDir, { recursive: true });
      const omxAgentFile = path.join(omxAgentDir, 'planner.md');
      fs.writeFileSync(omxAgentFile, '# Legacy OMX Planner\n', 'utf8');

      expect(detectFileProvenance(omcSkillFile)).toBe('foreign_omc');
      expect(detectFileProvenance(omxAgentFile)).toBe('foreign_omx');

      const collisions = scanComponentCollisions({
        packageRoot,
        projectRoot: tempProject,
        homeDir: tempHome,
      });

      expect(collisions.some((c) => c.provenance === 'foreign_omc')).toBe(true);
      expect(collisions.some((c) => c.provenance === 'foreign_omx')).toBe(true);

      // Verify non-destructive guarantee
      expect(fs.existsSync(omcSkillFile)).toBe(true);
      expect(fs.existsSync(omxAgentFile)).toBe(true);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('detects all active activation modes accurately', () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-modes-proj-'));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-modes-home-'));
    try {
      // Create project-local plugin
      fs.mkdirSync(path.join(tempProject, '.cursor-plugin'), { recursive: true });
      fs.writeFileSync(path.join(tempProject, '.cursor-plugin', 'plugin.json'), '{"name":"oh-my-cursor"}');

      // Create fake marketplace extension in home
      const extDir = path.join(tempHome, '.cursor', 'extensions', 'oh-my-cursor');
      fs.mkdirSync(path.join(extDir, '.cursor-plugin'), { recursive: true });
      fs.writeFileSync(path.join(extDir, '.cursor-plugin', 'plugin.json'), '{"name":"oh-my-cursor"}');

      const modes = detectActivationModes({
        packageRoot,
        projectRoot: tempProject,
        homeDir: tempHome,
      });

      const marketplaceMode = modes.find((m) => m.mode === 'marketplace');
      expect(marketplaceMode?.active).toBe(true);
      expect(marketplaceMode?.releasePath).toBe(extDir);

      const projectLocalMode = modes.find((m) => m.mode === 'project_local');
      expect(projectLocalMode?.active).toBe(true);
      expect(projectLocalMode?.releasePath).toBe(tempProject);

      const devMode = modes.find((m) => m.mode === 'developer_checkout');
      expect(devMode?.active).toBe(true);
      expect(devMode?.version).toBe(PACKAGE_VERSION);

      const sdkMode = modes.find((m) => m.mode === 'sdk_only');
      expect(sdkMode?.active).toBe(true);
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
