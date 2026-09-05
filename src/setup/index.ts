export { copyPackableDirectory, digestDirectory, digestPackableDirectory, listPackableFiles, sha256, sha256File, verifySha256Sums } from './digest.js';
export { runSetupDoctor } from './doctor.js';
export type { DoctorInput, DoctorReport } from './doctor.js';
export {
  installOrUpdate,
  readCurrentInstall,
  uninstall,
  verifyCurrentInstall,
  inspectInstallStatus,
  listInstallations,
  verifyInstallations,
  rollbackInstallation,
  pruneInstallations,
  repairInstallation,
} from './lifecycle.js';
export type {
  InstallInput,
  InstallResult,
  UninstallInput,
  UninstallResult,
  InstallVerificationReport,
  InstallStatusResult,
  InstallListEntry,
  VerifyTargetReport,
  VerifyInstallationsResult,
  RollbackInput,
  RollbackResult,
  PruneInput,
  PrunedStageReport,
  PruneResult,
  RepairInput,
  RepairResult,
} from './lifecycle.js';
export { createInstallReceipt, readInstallReceipt, validateInstallReceipt, writeInstallReceipt } from './receipt.js';
export type { InstallReceipt, InstallSourceInfo, InstallSourceKind, OwnedInstallPath } from './receipt.js';
export { fetchGitHubRelease } from './github-release.js';
export type { FetchGitHubReleaseOptions, FetchedRelease } from './github-release.js';
export type { CommandResult, CommandRunner, SetupCheck, SetupCheckStatus } from './types.js';
export { withInstallLock, withInstallLockSync } from './lock.js';
export type { InstallLockOptions } from './lock.js';
export {
  extractReleaseArchive,
  validateArchiveListing,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_TOTAL_BYTES,
  MAX_ARCHIVE_FILE_BYTES,
} from './archive.js';
export type { ArchiveSafetyReport, ExtractedArchive } from './archive.js';
