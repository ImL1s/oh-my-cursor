import path from 'node:path';

export interface SafetyEvaluation {
  readonly safe: boolean;
  readonly reason?: string | undefined;
  readonly violations: readonly string[];
  readonly errorCode?: string | undefined;
}

const DESTRUCTIVE_COMMAND_PATTERNS: readonly { readonly pattern: RegExp; readonly violation: string }[] = [
  {
    pattern: /\brm\s+.*(-[a-zA-Z]*[rf][a-zA-Z]*|-r|-f).*\s+(\/|~|\$HOME|\.\.|\$PWD|\$\{PWD\}|\.git(?:\/|\s|$)|(?:\.|\.\/|\*|\.\/\*|\.\*)(?:\s|$))/i,
    violation: 'Destructive recursive deletion of root, home, system, parent directory, workspace, or git repository',
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|-r|-f)*\s*(\/|~|\$HOME|\$PWD|\$\{PWD\}|\/\*|\.\.|\.git(?:\/|\s|$)|(?:\.|\.\/|\*|\.\/\*|\.\*)(?:\s|$))/i,
    violation: 'Destructive recursive deletion of root, home, system, parent directory, workspace, or git repository',
  },
  {
    pattern: /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/,
    violation: 'Disk partitioning or filesystem format command',
  },
  {
    pattern: /\bdd\s+.*of=\/dev\/(sd[a-z]|hd[a-z]|nvme[0-9]n[0-9]|disk[0-9]|null)\b/,
    violation: 'Raw block device overwrite with dd',
  },
  {
    pattern: /\bgit\s+push\s+.*(-f\b|--force\b)/,
    violation: 'Unsafe git force-push blocked by pre-step safety gate',
  },
  {
    pattern: /\bgit\s+push\s+.*--delete\s+(main|master|release)\b/,
    violation: 'Deletion of protected git branch',
  },
  {
    pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(777|a\+rwx)\s+(\/|~|\$HOME)(\s|$)/,
    violation: 'Permissive permission change on root or home directory',
  },
  {
    pattern: /\b(shutdown|reboot|poweroff|init\s+0)\b/,
    violation: 'System shutdown or reboot command',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    violation: 'Fork bomb pattern detected',
  },
  {
    pattern: /\bcat\s+.*(\.ssh\/|\.aws\/credentials|\.gnupg\/|\.netrc)/,
    violation: 'Unauthorized secret credential read',
  },
];

export function evaluatePreStepSafety(
  toolName: string,
  toolInput: unknown,
  cwd: string
): SafetyEvaluation {
  const violations: string[] = [];

  if (typeof toolInput === 'object' && toolInput !== null) {
    const inputObj = toolInput as Record<string, unknown>;

    // 1. Shell command checks
    const commandCandidates = [
      inputObj.command,
      inputObj.cmd,
      inputObj.CommandLine,
      inputObj.commandLine,
    ];
    for (const cmd of commandCandidates) {
      if (typeof cmd === 'string') {
        for (const { pattern, violation } of DESTRUCTIVE_COMMAND_PATTERNS) {
          if (pattern.test(cmd)) {
            violations.push(violation);
          }
        }
      }
    }

    // 2. File write path boundary checks
    const pathCandidates = [
      inputObj.path,
      inputObj.targetFile,
      inputObj.TargetFile,
      inputObj.filePath,
      inputObj.file,
      inputObj.AbsolutePath,
    ];
    for (const p of pathCandidates) {
      if (typeof p === 'string' && p.trim() !== '') {
        const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
        const relative = path.relative(cwd, resolved);
        // Disallow path escape
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || relative.startsWith('../') || (path.isAbsolute(p) && !resolved.startsWith(cwd + path.sep) && resolved !== cwd)) {
          violations.push(`File access outside workspace root is disallowed: ${p}`);
        }
        // Disallow direct writes to .git internal structures
        if (relative === '.git' || relative.startsWith('.git/') || relative.startsWith(`.git${path.sep}`)) {
          if (toolName.toLowerCase().includes('write') || toolName.toLowerCase().includes('edit')) {
            violations.push(`Direct modification of git internal directory is disallowed: ${p}`);
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    return {
      safe: false,
      reason: violations[0],
      violations,
      errorCode: 'E_SAFETY_DENY',
    };
  }

  return {
    safe: true,
    violations: [],
  };
}
