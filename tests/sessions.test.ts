import { describe, expect, it } from 'vitest';
import { routeSessionCommand } from '../src/sessions/router.js';

describe('session routing', () => {
  it('routes create and list to pinned host commands', () => {
    expect(routeSessionCommand({ kind: 'create' }, '/repo')).toEqual({ argv: ['create-chat'], cwd: '/repo', interactive: false });
    expect(routeSessionCommand({ kind: 'list' }, '/repo')).toEqual({ argv: ['ls'], cwd: '/repo', interactive: true });
  });
  it('routes exact resume and continue in interactive or print mode', () => {
    expect(routeSessionCommand({ kind: 'resume', sessionId: 'abc-123' }, '/repo').argv).toEqual(['--resume', 'abc-123']);
    expect(routeSessionCommand({ kind: 'continue', prompt: 'finish' }, '/repo').argv).toEqual(['--print', '--output-format', 'json', '--continue', 'finish']);
    expect(() => routeSessionCommand({ kind: 'resume', sessionId: '../escape' }, '/repo')).toThrow('E_SESSION_ID_INVALID');
  });
});
