import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const omc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/upstreams/omc.lock.json'), 'utf8'));
const omx = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/upstreams/omx.lock.json'), 'utf8'));
const omo = JSON.parse(fs.readFileSync(path.join(repoRoot, 'parity/upstreams/omo.lock.json'), 'utf8'));

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

const upstreams = [
  { name: 'OMC (oh-my-claudecode)', url: 'https://github.com/Yeachan-Heo/oh-my-claudecode.git', pinned: omc.commit },
  { name: 'OMX (oh-my-codex)', url: 'https://github.com/Yeachan-Heo/oh-my-codex.git', pinned: omx.commit },
  { name: 'OMO (oh-my-openagent)', url: 'https://github.com/code-yeongyu/oh-my-openagent.git', pinned: omo.commit }
];

const results = [];
let driftCount = 0;

for (const u of upstreams) {
  try {
    const remoteHead = getRemoteHead(u.url);
    const drifted = remoteHead !== u.pinned;
    if (drifted) {
      console.warn(`::warning title=Upstream Drift Detected::${u.name} remote HEAD has advanced to ${remoteHead} (pinned: ${u.pinned})`);
      driftCount++;
    } else {
      console.log(`[UP TO DATE] ${u.name} matches pinned ${u.pinned}`);
    }
    results.push({ name: u.name, pinned: u.pinned, remote: remoteHead, drifted });
  } catch (err) {
    console.error(`[ERROR] ${u.name} query failed:`, err.message);
    driftCount++;
    results.push({ name: u.name, pinned: u.pinned, remote: 'ERROR: ' + err.message, drifted: true });
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  let summary = `## Upstream Baseline Drift Report\n\n| Upstream | Pinned Commit | Remote HEAD | Status |\n|---|---|---|---|\n`;
  for (const r of results) {
    const statusText = r.drifted ? '⚠️ Drift Detected' : '✅ Up to Date';
    summary += `| ${r.name} | \`${r.pinned.slice(0, 10)}\` | \`${r.remote.slice(0, 10)}\` | ${statusText} |\n`;
  }
  summary += `\n**Policy**: Upstream pins must never be advanced automatically without independent review and clean-room verification.\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
}

if (driftCount > 0) {
  console.error(`\nDrift check failed: ${driftCount} upstream baseline(s) differ or failed query.`);
  console.error('NOTE: Upstream pins must never be advanced automatically without thorough clean-room review.');
  process.exit(1);
} else {
  console.log('\nAll upstream baselines are clean and aligned with pins.');
}
