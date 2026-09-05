import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractReleaseArchive } from './archive.js';
import { verifySha256Sums } from './digest.js';

export const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export interface FetchGitHubReleaseOptions {
  readonly tag?: string | undefined;
  readonly latest?: boolean | undefined;
  readonly repo?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly allowInsecureProto?: boolean | undefined;
  readonly workDir?: string | undefined;
}

export interface FetchedRelease {
  readonly tag: string;
  readonly version: string;
  readonly archivePath: string;
  readonly checksumsPath: string;
  readonly archiveSha256: string;
  readonly extractedRoot: string;
  readonly cleanup: () => void;
}

function assertProtocolSafe(url: string, allowInsecure: boolean): void {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return;
  if (allowInsecure && (parsed.protocol === 'http:' || parsed.protocol === 'file:')) return;
  throw new Error(`E_INSECURE_PROTOCOL: protocol ${parsed.protocol} is forbidden (https required)`);
}

export async function fetchGitHubRelease(options: FetchGitHubReleaseOptions): Promise<FetchedRelease> {
  const repo = options.repo ?? process.env.OMCU_REPO ?? 'ImL1s/oh-my-cursor';
  const apiUrl = options.apiUrl ?? process.env.OMCU_API_URL ?? `https://api.github.com/repos/${repo}/releases`;
  const allowInsecure = options.allowInsecureProto ?? (process.env.OMCU_ALLOW_INSECURE_PROTO !== undefined);

  let tag: string;
  if (options.tag !== undefined && options.tag.trim() !== '') {
    tag = options.tag.trim();
    if (!RELEASE_TAG_PATTERN.test(tag)) {
      throw new Error(`E_RELEASE_TAG_INVALID: invalid release tag format '${tag}'`);
    }
  } else if (options.latest === true) {
    const latestUrl = `${apiUrl}/latest`;
    assertProtocolSafe(latestUrl, allowInsecure);
    let response: Response;
    try {
      response = await fetch(latestUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'omcu-updater',
        },
      });
    } catch (error) {
      throw new Error(`E_GITHUB_RELEASE_FETCH_FAILED: failed to connect to releases API: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`E_GITHUB_RELEASE_FETCH_FAILED: GitHub API returned status ${response.status}`);
    }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data !== 'object' || data === null) {
      throw new Error('E_GITHUB_RELEASE_FETCH_FAILED: invalid JSON payload from GitHub API');
    }
    if (typeof data.message === 'string') {
      throw new Error(`E_GITHUB_RELEASE_FETCH_FAILED: GitHub API error: ${data.message}`);
    }
    if (typeof data.tag_name !== 'string' || !RELEASE_TAG_PATTERN.test(data.tag_name)) {
      throw new Error(`E_RELEASE_TAG_INVALID: API returned invalid tag '${String(data.tag_name)}'`);
    }
    tag = data.tag_name;
  } else {
    throw new Error('E_RELEASE_TARGET_REQUIRED: must specify tag or latest');
  }

  const version = tag.replace(/^v/, '');
  const archiveName = `iml1s-oh-my-cursor-${version}.tgz`;
  const checksumsName = 'SHA256SUMS';

  const defaultBaseUrl = `https://github.com/${repo}/releases/download/${tag}`;
  const baseUrl = options.baseUrl ?? process.env.OMCU_BASE_URL ?? defaultBaseUrl;

  const archiveUrl = `${baseUrl}/${archiveName}`;
  const checksumsUrl = `${baseUrl}/${checksumsName}`;

  assertProtocolSafe(archiveUrl, allowInsecure);
  assertProtocolSafe(checksumsUrl, allowInsecure);

  const tempDownloadDir = fs.mkdtempSync(path.join(options.workDir ?? os.tmpdir(), 'omcu-update-dl-'));
  fs.chmodSync(tempDownloadDir, 0o700);

  const archiveFile = path.join(tempDownloadDir, archiveName);
  const checksumsFile = path.join(tempDownloadDir, checksumsName);

  try {
    const [archiveResp, checksumsResp] = await Promise.all([
      fetch(archiveUrl, { headers: { 'User-Agent': 'omcu-updater' } }),
      fetch(checksumsUrl, { headers: { 'User-Agent': 'omcu-updater' } }),
    ]);

    if (!archiveResp.ok) {
      throw new Error(`E_RELEASE_DOWNLOAD_FAILED: failed to download archive (${archiveResp.status})`);
    }
    if (!checksumsResp.ok) {
      throw new Error(`E_RELEASE_DOWNLOAD_FAILED: failed to download checksums (${checksumsResp.status})`);
    }

    const archiveBuffer = Buffer.from(await archiveResp.arrayBuffer());
    const checksumsBuffer = Buffer.from(await checksumsResp.arrayBuffer());

    fs.writeFileSync(archiveFile, archiveBuffer, { mode: 0o600 });
    fs.writeFileSync(checksumsFile, checksumsBuffer, { mode: 0o600 });

    const archiveSha256 = verifySha256Sums(archiveFile, checksumsFile);
    const extracted = extractReleaseArchive(archiveFile, checksumsFile);

    return {
      tag,
      version,
      archivePath: archiveFile,
      checksumsPath: checksumsFile,
      archiveSha256,
      extractedRoot: extracted.root,
      cleanup: () => {
        try { extracted.cleanup(); } catch { /* best effort */ }
        try { fs.rmSync(tempDownloadDir, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  } catch (error) {
    try { fs.rmSync(tempDownloadDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}
