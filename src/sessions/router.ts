import { buildPrintArgv, validateSessionId, type CursorInvocation, type CursorOutputFormat } from '../host/cursor-agent.js';

export type SessionCommand =
  | { readonly kind: 'create' }
  | { readonly kind: 'list' }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly prompt?: string; readonly format?: CursorOutputFormat }
  | { readonly kind: 'continue'; readonly prompt?: string; readonly format?: CursorOutputFormat };

export function routeSessionCommand(command: SessionCommand, cwd: string): CursorInvocation {
  switch (command.kind) {
    case 'create':
      return { argv: ['create-chat'], cwd, interactive: false };
    case 'list':
      return { argv: ['ls'], cwd, interactive: true };
    case 'resume': {
      const sessionId = validateSessionId(command.sessionId);
      if (command.prompt === undefined) return { argv: ['--resume', sessionId], cwd, interactive: true };
      return { argv: buildPrintArgv(command.prompt, { format: command.format ?? 'json', resume: sessionId }), cwd, interactive: false };
    }
    case 'continue':
      if (command.prompt === undefined) return { argv: ['--continue'], cwd, interactive: true };
      return { argv: buildPrintArgv(command.prompt, { format: command.format ?? 'json', continue: true }), cwd, interactive: false };
  }
}
