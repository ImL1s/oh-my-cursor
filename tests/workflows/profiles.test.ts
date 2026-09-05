import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_PROFILES,
  getNextProfilePhase,
  getSourceProfile,
  listSourceProfiles,
  validateProfileTransition,
} from '../../src/workflows/profiles/index.js';

describe('Workflow Profiles Catalog', () => {
  it('contains all 17 canonical profiles across OMC, OMX, and OMO', () => {
    expect(WORKFLOW_PROFILES).toHaveLength(17);

    const omcProfiles = listSourceProfiles('omc');
    expect(omcProfiles.map((p) => p.id)).toEqual([
      'omc-autopilot',
      'omc-ralph',
      'omc-ultrawork',
      'omc-ultraqa',
      'omc-pipeline',
      'omc-persistent-todo',
    ]);

    const omxProfiles = listSourceProfiles('omx');
    expect(omxProfiles.map((p) => p.id)).toEqual([
      'omx-goal',
      'omx-ultragoal',
      'omx-ralplan',
      'omx-ralph',
      'omx-team',
      'omx-research-goal',
    ]);

    const omoProfiles = listSourceProfiles('omo');
    expect(omoProfiles.map((p) => p.id)).toEqual([
      'omo-boulder',
      'omo-ulw-loop',
      'omo-atlas-todo',
      'omo-steering',
      'omo-closing-briefing',
    ]);
  });

  it('retrieves profiles by both prefixed and short IDs, and canonical aliases', () => {
    const p1 = getSourceProfile('omc-autopilot');
    const p2 = getSourceProfile('autopilot');
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1?.id).toBe(p2?.id);

    const b1 = getSourceProfile('omo-boulder');
    const b2 = getSourceProfile('boulder');
    expect(b1?.canonicalName).toBe('OMO Boulder');
    expect(b2?.id).toBe('omo-boulder');

    // Canonical aliases from prompt requirements
    expect(getSourceProfile('boulder/start-work')?.id).toBe('omo-boulder');
    expect(getSourceProfile('start-work')?.id).toBe('omo-boulder');
    expect(getSourceProfile('ralplan/prometheus handoff')?.id).toBe('omx-ralplan');
    expect(getSourceProfile('prometheus')?.id).toBe('omx-ralplan');
    expect(getSourceProfile('persistent todo continuation')?.id).toBe('omc-persistent-todo');
    expect(getSourceProfile('team story execution')?.id).toBe('omx-team');
    expect(getSourceProfile('research goals')?.id).toBe('omx-research-goal');
    expect(getSourceProfile('Atlas-style todo discipline')?.id).toBe('omo-atlas-todo');
    expect(getSourceProfile('ultrawork/ulw-loop')?.id).toBe('omo-ulw-loop');
    expect(getSourceProfile('bounded steering excursions')?.id).toBe('omo-steering');
    expect(getSourceProfile('closing briefing')?.id).toBe('omo-closing-briefing');
  });

  it('validates phase transitions accurately', () => {
    // Autopilot transitions
    expect(validateProfileTransition('omc-autopilot', 'interview', 'plan')).toBe(true);
    expect(validateProfileTransition('omc-autopilot', 'plan', 'execute')).toBe(true);
    expect(validateProfileTransition('omc-autopilot', 'execute', 'review')).toBe(true);
    expect(validateProfileTransition('omc-autopilot', 'review', 'qa')).toBe(true);
    expect(validateProfileTransition('omc-autopilot', 'qa', 'completed')).toBe(true);
    // Invalid jump
    expect(validateProfileTransition('omc-autopilot', 'interview', 'completed')).toBe(false);

    // Ralplan FSM transitions
    expect(validateProfileTransition('omx-ralplan', 'propose', 'critic')).toBe(true);
    expect(validateProfileTransition('omx-ralplan', 'critic', 'revise')).toBe(true);
    expect(validateProfileTransition('omx-ralplan', 'revise', 'verifier_handoff')).toBe(true);
    expect(validateProfileTransition('omx-ralplan', 'verifier_handoff', 'approved')).toBe(true);

    // Boulder momentum loop
    expect(validateProfileTransition('omo-boulder', 'start_work', 'momentum_loop')).toBe(true);
    expect(validateProfileTransition('omo-boulder', 'momentum_loop', 'checkpoint')).toBe(true);
    expect(validateProfileTransition('omo-boulder', 'checkpoint', 'momentum_loop')).toBe(true);
    expect(validateProfileTransition('omo-boulder', 'checkpoint', 'completed')).toBe(true);
  });

  it('computes next profile phase for progression', () => {
    expect(getNextProfilePhase('omc-autopilot', 'interview')).toBe('plan');
    expect(getNextProfilePhase('omc-autopilot', 'plan')).toBe('execute');
    expect(getNextProfilePhase('omx-ralplan', 'propose')).toBe('critic');
    expect(getNextProfilePhase('omo-boulder', 'start_work')).toBe('momentum_loop');
  });

  it('defines valid failure routing for all profiles', () => {
    for (const profile of WORKFLOW_PROFILES) {
      expect(profile.failureRouting).toBeDefined();
      expect(profile.failureRouting.maxConsecutiveFailures).toBeGreaterThanOrEqual(1);
      expect([
        'rework',
        'replan',
        'specialist',
        'human_blocker',
        'terminal_failure',
      ]).toContain(profile.failureRouting.onRepeatedFailure);

      if (profile.failureRouting.onRepeatedFailure === 'specialist') {
        expect(profile.failureRouting.specialistRole).toBeDefined();
      }
    }
  });
});
