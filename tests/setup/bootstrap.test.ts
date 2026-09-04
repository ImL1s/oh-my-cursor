import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '../../src/setup/digest.js';

/** Async spawn wrapper that doesn't block the event loop — required for tests
 *  that run an in-process HTTP server the child process must reach via curl. */
function runBootstrap(
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.resolve('scripts/bootstrap.sh')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bootstrap timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTarGz(sourceDir: string, outputFile: string, entries: string[]): void {
  const result = spawnSync('tar', ['-czf', outputFile, '-C', sourceDir, ...entries], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr}`);
  }
}

function startStaticServer(files: Record<string, { body: Buffer | string; contentType?: string }>): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] ?? '/';
      const match = files[urlPath];
      if (match) {
        res.writeHead(200, { 'Content-Type': match.contentType ?? 'application/octet-stream' });
        res.end(match.body);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('scripts/bootstrap.sh', () => {
  const bootstrapScript = path.resolve('scripts/bootstrap.sh');

  it('rejects execution when Node version is < 20 with actionable error', () => {
    const work = makeTempDir('omcu-boot-node-old-');
    const fakeBin = path.join(work, 'bin');
    fs.mkdirSync(fakeBin);
    const fakeNode = path.join(fakeBin, 'node');
    fs.writeFileSync(
      fakeNode,
      `#!/usr/bin/env bash
if [[ "$*" == *"versions.node"* ]]; then
  printf '18.20.0'
  exit 1
fi
exec "${process.execPath}" "$@"
`,
      { mode: 0o755 },
    );

    const result = spawnSync('bash', [bootstrapScript], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node >= 20 is required; current version: 18.20.0');
  });

  it('rejects execution when node is missing from PATH', () => {
    const work = makeTempDir('omcu-boot-node-missing-');
    const fakeBin = path.join(work, 'bin');
    fs.mkdirSync(fakeBin);

    // Provide bash, curl, tar, shasum but no node
    for (const cmd of ['bash', 'curl', 'tar', 'shasum']) {
      const p = spawnSync('which', [cmd], { encoding: 'utf8' }).stdout.trim();
      if (p) {
        fs.symlinkSync(p, path.join(fakeBin, cmd));
      }
    }

    const result = spawnSync('bash', [bootstrapScript], {
      env: {
        ...process.env,
        PATH: fakeBin,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node >= 20 is required, but node is not installed or not on PATH');
  });

  it('rejects invalid OMCU_TAG values', () => {
    const invalidTags = ['invalid', 'v1', 'v1.0', '../v1.0.0', 'v1.0.0/evil', '1.0.0', 'v1.0.0;rm -rf'];

    for (const tag of invalidTags) {
      const result = spawnSync('bash', [bootstrapScript], {
        env: {
          ...process.env,
          OMCU_TAG: tag,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`invalid release tag format: '${tag}'`);
    }
  });

  it('detects GitHub API rate limit errors in structured parsing', async () => {
    const { url } = await startStaticServer({
      '/latest': {
        body: JSON.stringify({
          message: 'API rate limit exceeded for 127.0.0.1. (But here\'s the good news: Authenticated requests get a higher rate limit.)',
          documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
        }),
        contentType: 'application/json',
      },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: '',
      OMCU_API_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub API error: API rate limit exceeded');
  });

  it('detects GitHub API error payloads', async () => {
    const { url } = await startStaticServer({
      '/latest': {
        body: JSON.stringify({ message: 'Not Found' }),
        contentType: 'application/json',
      },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: '',
      OMCU_API_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub API error: Not Found');
  });

  it('rejects an archive with escaping symlink before extraction', async () => {
    const work = makeTempDir('omcu-boot-esc-symlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.symlinkSync('../../etc/passwd', path.join(pkg, 'evil-link'));

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release archive failed safety preflight validation');
    expect(result.stderr).toContain('symlink escapes package/ root');
  });

  it('rejects an archive with absolute symlink before extraction', async () => {
    const work = makeTempDir('omcu-boot-abs-symlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.symlinkSync('/etc/passwd', path.join(pkg, 'abs-link'));

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release archive failed safety preflight validation');
    expect(result.stderr).toContain('absolute symlink forbidden');
  });

  it('rejects an archive with hardlink before extraction', async () => {
    const work = makeTempDir('omcu-boot-hardlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'file.txt'), 'hello');
    fs.linkSync(path.join(pkg, 'file.txt'), path.join(pkg, 'hardlink.txt'));

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release archive failed safety preflight validation');
    expect(result.stderr).toContain('hardlinks forbidden');
  });

  it('rejects an archive with non-package root', async () => {
    const work = makeTempDir('omcu-boot-wrong-root-');
    const wrong = path.join(work, 'other-root');
    fs.mkdirSync(wrong);
    fs.writeFileSync(path.join(wrong, 'package.json'), '{}');

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['other-root']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release archive failed safety preflight validation');
    expect(result.stderr).toContain('entry outside package/ root');
  });

  it('rejects installer exit code 2 when no valid receipt was created', async () => {
    const work = makeTempDir('omcu-boot-exit2-no-receipt-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test","version":"0.3.0"}');
    // Fake installer that exits 2 without valid receipt
    fs.writeFileSync(
      path.join(pkg, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash
echo '{"status": "warning"}'
exit 2
`,
      { mode: 0o755 },
    );

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('install verification failed: invalid or missing install receipt');
  });

  it('rejects installer failure (exit code 1)', async () => {
    const work = makeTempDir('omcu-boot-exit1-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test","version":"0.3.0"}');
    fs.writeFileSync(
      path.join(pkg, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash
echo "fatal error" >&2
exit 1
`,
      { mode: 0o755 },
    );

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: path.join(work, 'home'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installer failed (exit 1)');
  });

  it('rejects install when readback version does not match target version', async () => {
    const work = makeTempDir('omcu-boot-mismatch-');
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    const receiptsDir = path.join(work, 'receipts');
    fs.mkdirSync(receiptsDir, { recursive: true });
    const receiptFile = path.join(receiptsDir, 'receipt.json');
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        store_kind: 'omcu_install_receipt',
        schema_version: 1,
        transaction_id: 'tx1',
        action: 'install',
        version: '0.3.0',
      }),
    );

    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test","version":"0.3.0"}');

    // Fake installer that creates a binary reporting wrong version (0.2.0 instead of 0.3.0)
    fs.writeFileSync(
      path.join(pkg, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash
mkdir -p "${home}/.local/bin"
cat << 'EOF' > "${home}/.local/bin/omcu"
#!/usr/bin/env bash
echo "0.2.0"
EOF
chmod 755 "${home}/.local/bin/omcu"
cat << EOF
{
  "receiptPath": "${receiptFile}",
  "receipt": {
    "store_kind": "omcu_install_receipt",
    "schema_version": 1,
    "version": "0.3.0"
  }
}
EOF
exit 0
`,
      { mode: 0o755 },
    );

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: home,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("readback version mismatch: expected '0.3.0', got '0.2.0'");
  });

  it('completes successful install with verified receipt and readback verification', async () => {
    const work = makeTempDir('omcu-boot-success-');
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    const receiptsDir = path.join(work, 'receipts');
    fs.mkdirSync(receiptsDir, { recursive: true });
    const receiptFile = path.join(receiptsDir, 'receipt.json');
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        store_kind: 'omcu_install_receipt',
        schema_version: 1,
        transaction_id: 'tx-good',
        action: 'install',
        version: '0.3.0',
      }),
    );

    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test","version":"0.3.0"}');

    fs.writeFileSync(
      path.join(pkg, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash
mkdir -p "${home}/.local/bin"
cat << 'EOF' > "${home}/.local/bin/omcu"
#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "0.3.0"
  exit 0
fi
echo "omcu cli"
EOF
chmod 755 "${home}/.local/bin/omcu"
cat << EOF
{
  "receiptPath": "${receiptFile}",
  "receipt": {
    "store_kind": "omcu_install_receipt",
    "schema_version": 1,
    "version": "0.3.0"
  }
}
EOF
exit 0
`,
      { mode: 0o755 },
    );

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: home,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('verified omcu 0.3.0 at');
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(true);

    const checkVersion = spawnSync(path.join(home, '.local', 'bin', 'omcu'), ['--version'], { encoding: 'utf8' });
    expect(checkVersion.stdout.trim()).toBe('0.3.0');
  });

  it('accepts exit code 2 when valid receipt is present and readback succeeds', async () => {
    const work = makeTempDir('omcu-boot-exit2-ok-');
    const home = path.join(work, 'home');
    fs.mkdirSync(home);
    const receiptsDir = path.join(work, 'receipts');
    fs.mkdirSync(receiptsDir, { recursive: true });
    const receiptFile = path.join(receiptsDir, 'receipt.json');
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({
        store_kind: 'omcu_install_receipt',
        schema_version: 1,
        transaction_id: 'tx-warn',
        action: 'install',
        version: '0.3.0',
      }),
    );

    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test","version":"0.3.0"}');

    fs.writeFileSync(
      path.join(pkg, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash
mkdir -p "${home}/.local/bin"
cat << 'EOF' > "${home}/.local/bin/omcu"
#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "0.3.0"
  exit 0
fi
EOF
chmod 755 "${home}/.local/bin/omcu"
cat << EOF
{
  "receiptPath": "${receiptFile}",
  "receipt": {
    "store_kind": "omcu_install_receipt",
    "schema_version": 1,
    "version": "0.3.0"
  }
}
EOF
exit 2
`,
      { mode: 0o755 },
    );

    const archive = path.join(work, 'iml1s-oh-my-cursor-0.3.0.tgz');
    createTarGz(work, archive, ['package']);
    const digest = sha256File(archive);
    const checksums = `${digest}  iml1s-oh-my-cursor-0.3.0.tgz\n`;

    const { url } = await startStaticServer({
      '/iml1s-oh-my-cursor-0.3.0.tgz': { body: fs.readFileSync(archive) },
      '/SHA256SUMS': { body: checksums },
    });

    const result = await runBootstrap({
      ...process.env,
      OMCU_TAG: 'v0.3.0',
      OMCU_BASE_URL: url,
      OMCU_ALLOW_INSECURE_PROTO: '1',
      OMCU_HOME: home,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('installer reported doctor warnings (exit 2); install receipt was verified');
    expect(result.stderr).toContain('verified omcu 0.3.0 at');
  });
});
