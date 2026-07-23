import fs from 'node:fs';
import { installOrUpdate } from '../../src/setup/lifecycle.js';
import type { CommandRunner } from '../../src/setup/types.js';

const input = JSON.parse(process.env.OMCU_CRASH_INPUT ?? '{}') as {
  sourceRoot: string;
  homeDir: string;
  stateRoot: string;
  projectRoot: string;
  transactionId: string;
  action: 'install' | 'update';
  marker: string;
};

const runner: CommandRunner = {
  async run() {
    fs.writeFileSync(input.marker, 'doctor-entered\n');
    await new Promise<void>(() => {
      setInterval(() => undefined, 1000);
    });
    return { code: 0, stdout: '', stderr: '' };
  },
};

await installOrUpdate({ ...input, runner });
