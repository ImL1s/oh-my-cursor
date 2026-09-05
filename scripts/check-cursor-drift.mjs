import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/cursor/sdk.lock.json'), 'utf8'));
const plugins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/cursor/plugins.lock.json'), 'utf8'));
const cookbook = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/cursor/cookbook.lock.json'), 'utf8'));

function getRemoteHead(repoUrl) {
  try {
    const out = execFileSync('git', ['ls-remote', repoUrl, 'HEAD'], { encoding: 'utf8', timeout: 15000 });
    const [sha] = out.trim().split(/\s+/);
    if (!sha || sha.length < 40) throw new Error(`Invalid SHA returned for ${repoUrl}`);
    return sha;
  } catch (err) {
    throw new Error(`Failed to query remote HEAD for ${repoUrl}: ${err.message}`);
  }
}

function getLatestNpmVersion(pkg) {
  try {
    const out = execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', timeout: 15000 });
    return out.trim();
  } catch (err) {
    throw new Error(`Failed to query npm registry for ${pkg}: ${err.message}`);
  }
}

const results = [];
let driftCount = 0;

// 1. Check SDK version
try {
  const latestSdk = getLatestNpmVersion('@cursor/sdk');
  const drifted = latestSdk !== sdk.version;
  if (drifted) {
    console.warn(`::warning title=Cursor SDK Drift Detected::@cursor/sdk latest npm release is ${latestSdk} (pinned: ${sdk.version})`);
    driftCount++;
  } else {
    console.log(`[UP TO DATE] @cursor/sdk matches pinned version ${sdk.version}`);
  }
  results.push({ name: '@cursor/sdk (npm)', pinned: sdk.version, current: latestSdk, drifted });
} catch (err) {
  console.error(`[ERROR] @cursor/sdk probe failed:`, err.message);
  driftCount++;
  results.push({ name: '@cursor/sdk (npm)', pinned: sdk.version, current: 'ERROR: ' + err.message, drifted: true });
}

// 2. Check reference plugins and cookbook
const repos = [
  { name: 'cursor/plugins', url: 'https://github.com/cursor/plugins.git', pinned: plugins.commit },
  { name: 'cursor/cookbook', url: 'https://github.com/cursor/cookbook.git', pinned: cookbook.commit }
];

for (const r of repos) {
  try {
    const remoteHead = getRemoteHead(r.url);
    const drifted = remoteHead !== r.pinned;
    if (drifted) {
      console.warn(`::warning title=Cursor Reference Drift Detected::${r.name} remote HEAD has advanced to ${remoteHead} (pinned: ${r.pinned})`);
      driftCount++;
    } else {
      console.log(`[UP TO DATE] ${r.name} matches pinned ${r.pinned}`);
    }
    results.push({ name: r.name, pinned: r.pinned, current: remoteHead, drifted });
  } catch (err) {
    console.error(`[ERROR] ${r.name} probe failed:`, err.message);
    driftCount++;
    results.push({ name: r.name, pinned: r.pinned, current: 'ERROR: ' + err.message, drifted: true });
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  let summary = `## Cursor Target Baseline Drift Report\n\n| Mechanism / Reference | Pinned Version/Commit | Live Remote Version/HEAD | Status |\n|---|---|---|---|\n`;
  for (const r of results) {
    const statusText = r.drifted ? '⚠️ Drift Detected' : '✅ Up to Date';
    summary += `| ${r.name} | \`${r.pinned.slice(0, 10)}\` | \`${r.current.slice(0, 10)}\` | ${statusText} |\n`;
  }
  summary += `\n**Policy**: Cursor mechanisms must be deliberately evaluated before advancing capability locks.\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
}

if (driftCount > 0) {
  console.error(`\nDrift check failed: ${driftCount} Cursor target baseline(s) differ or failed query.`);
  console.error('NOTE: Cursor target mechanisms must be evaluated deliberately before advancing capability locks.');
  process.exit(1);
} else {
  console.log('\nAll Cursor target baselines are clean and aligned with pins.');
}
