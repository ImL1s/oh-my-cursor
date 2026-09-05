import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_VERSION } from '../version.js';
import { fileSha256 } from '../catalog/manifest.js';
import type { ActivationModeReport } from '../catalog/types.js';

export interface ActivationModesOptions {
  readonly packageRoot: string;
  readonly projectRoot?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly stateRoot?: string | undefined;
}

export function detectActivationModes(options: ActivationModesOptions): ActivationModeReport[] {
  const packageRoot = path.resolve(options.packageRoot);
  const projectRoot = path.resolve(options.projectRoot ?? packageRoot);
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? '');
  const stateRoot = path.resolve(options.stateRoot ?? (homeDir ? path.join(homeDir, '.omcu') : path.join(projectRoot, '.omcu')));
  const reports: ActivationModeReport[] = [];

  // 1. Marketplace install
  const marketplacePluginDir = homeDir ? path.join(homeDir, '.cursor', 'extensions', 'oh-my-cursor') : '';
  const isMarketplace = Boolean(marketplacePluginDir && fs.existsSync(marketplacePluginDir));
  reports.push({
    mode: 'marketplace',
    active: isMarketplace,
    releasePath: isMarketplace ? marketplacePluginDir : null,
    version: isMarketplace ? PACKAGE_VERSION : null,
    hash: isMarketplace && fs.existsSync(path.join(marketplacePluginDir, '.cursor-plugin', 'plugin.json'))
      ? fileSha256(path.join(marketplacePluginDir, '.cursor-plugin', 'plugin.json'))
      : null,
    visibleComponents: isMarketplace ? ['skills', 'agents', 'rules', 'hooks', 'mcp'] : [],
  });

  // 2. Installed immutable stage
  let stageActive = false;
  let stagePath: string | null = null;
  let stageHash: string | null = null;
  try {
    const currentJson = path.join(stateRoot, 'install', 'current.json');
    if (fs.existsSync(currentJson)) {
      const parsed = JSON.parse(fs.readFileSync(currentJson, 'utf8')) as { stage?: string; stage_sha256?: string; version?: string };
      if (parsed.stage && fs.existsSync(parsed.stage)) {
        stageActive = true;
        stagePath = parsed.stage;
        stageHash = parsed.stage_sha256 ?? null;
      }
    }
  } catch {
    // Ignore stage read errors
  }
  reports.push({
    mode: 'installed_stage',
    active: stageActive,
    releasePath: stagePath,
    version: stageActive ? PACKAGE_VERSION : null,
    hash: stageHash,
    visibleComponents: stageActive ? ['skills', 'agents', 'rules', 'hooks', 'mcp', 'sdk-service'] : [],
  });

  // 3. Project-local explicit fallback
  const localPlugin = path.join(projectRoot, '.cursor-plugin', 'plugin.json');
  const isProjectLocal = fs.existsSync(localPlugin);
  reports.push({
    mode: 'project_local',
    active: isProjectLocal,
    releasePath: isProjectLocal ? projectRoot : null,
    version: isProjectLocal ? PACKAGE_VERSION : null,
    hash: isProjectLocal ? fileSha256(localPlugin) : null,
    visibleComponents: isProjectLocal ? ['skills', 'agents', 'rules', 'hooks', 'mcp'] : [],
  });

  // 4. SDK-only automation package
  let isSdkAvailable = false;
  try {
    const pkgJson = path.join(packageRoot, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const data = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { dependencies?: Record<string, string> };
      isSdkAvailable = Boolean(data.dependencies?.['@cursor/sdk']);
    }
  } catch {
    isSdkAvailable = false;
  }
  reports.push({
    mode: 'sdk_only',
    active: isSdkAvailable,
    releasePath: packageRoot,
    version: PACKAGE_VERSION,
    hash: null,
    visibleComponents: isSdkAvailable ? ['sdk-service'] : [],
  });

  // 5. Developer checkout
  const isDevCheckout = fs.existsSync(path.join(packageRoot, '.git')) || fs.existsSync(path.join(packageRoot, 'src'));
  reports.push({
    mode: 'developer_checkout',
    active: isDevCheckout,
    releasePath: isDevCheckout ? packageRoot : null,
    version: isDevCheckout ? PACKAGE_VERSION : null,
    hash: isDevCheckout && fs.existsSync(path.join(packageRoot, '.cursor-plugin', 'plugin.json'))
      ? fileSha256(path.join(packageRoot, '.cursor-plugin', 'plugin.json'))
      : null,
    visibleComponents: isDevCheckout ? ['skills', 'agents', 'rules', 'hooks', 'mcp', 'sdk-service'] : [],
  });

  // 6. Cursor CLI interactive/print
  reports.push({
    mode: 'cursor_cli',
    active: true, // CLI surface is active
    releasePath: packageRoot,
    version: PACKAGE_VERSION,
    hash: null,
    visibleComponents: ['skills', 'commands', 'hooks'],
  });

  return reports;
}
