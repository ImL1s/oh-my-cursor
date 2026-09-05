export type CursorRuntimeErrorCode =
  | 'E_RUNTIME_STARTUP'
  | 'E_RUNTIME_TERMINAL'
  | 'E_UNSUPPORTED_OPERATION'
  | 'E_RUNTIME_DISPOSED'
  | 'E_INVALID_TARGET'
  | 'E_AGENT_NOT_FOUND'
  | 'E_PERMISSION_DENIED';

export class CursorRuntimeError extends Error {
  public readonly code: CursorRuntimeErrorCode;
  public readonly details?: unknown;

  constructor(code: CursorRuntimeErrorCode, message: string, details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'CursorRuntimeError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isCursorRuntimeError(error: unknown): error is CursorRuntimeError {
  return error instanceof CursorRuntimeError;
}
