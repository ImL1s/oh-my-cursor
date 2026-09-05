import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolError } from '../types.js';
import type { ResearchEvidenceArtifact, ResearchSourceCitation } from './types.js';

const KNOWN_PRIMARY_DOMAINS = new Set([
  'cursor.com',
  'cursor.sh',
  'github.com',
  'nodejs.org',
  'typescriptlang.org',
  'developer.mozilla.org',
  'react.dev',
  'python.org',
  'rust-lang.org',
  'go.dev',
  'modelcontextprotocol.io',
]);

export function assertSafeUrl(urlString: string, allowPrivate = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ToolError('E_UNSAFE_URL', `Invalid URL: '${urlString}'`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(
      'E_UNSAFE_URL',
      `Unsupported URL protocol '${parsed.protocol}'. Only http and https are permitted.`
    );
  }

  if (!allowPrivate) {
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      throw new ToolError(
        'E_UNSAFE_URL',
        `Access to private/local network address '${hostname}' is prohibited.`
      );
    }
  }

  return parsed;
}

export function isPrimarySource(domain: string): boolean {
  const cleanDomain = domain.toLowerCase().replace(/^www\./, '');
  if (KNOWN_PRIMARY_DOMAINS.has(cleanDomain)) return true;
  for (const primary of KNOWN_PRIMARY_DOMAINS) {
    if (cleanDomain.endsWith(`.${primary}`)) return true;
  }
  return false;
}

export function packageResearchEvidence(
  topic: string,
  citations: readonly ResearchSourceCitation[],
  summary: string,
  rawContent?: string,
  projectRoot: string = process.cwd()
): ResearchEvidenceArtifact & { readonly artifactPath: string } {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = new Date().toISOString();

  const artifact: ResearchEvidenceArtifact = {
    id,
    topic,
    citations,
    summary,
    rawContent,
    timestamp,
  };

  const artifactsDir = path.join(projectRoot, '.omcu', 'artifacts', 'research');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filename = `research-${id}.json`;
  const artifactPath = path.join(artifactsDir, filename);

  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

  return {
    ...artifact,
    artifactPath: path.relative(projectRoot, artifactPath),
  };
}
