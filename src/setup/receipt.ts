import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { sha256 } from './digest.js';

export interface OwnedInstallPath {
  readonly path: string;
  readonly kind: 'release_stage' | 'cli_symlink' | 'project_state';
  readonly identity: string;
}

export interface InstallReceipt {
  readonly store_kind: 'omcu_install_receipt';
  readonly schema_version: 1;
  readonly transaction_id: string;
  readonly action: 'install' | 'update';
  readonly version: string;
  readonly source: { readonly kind: 'source' | 'archive'; readonly realpath: string; readonly sha256: string };
  readonly installed: { readonly stage: string; readonly sha256: string; readonly cli: string };
  readonly previous_cli_target: string | null;
  readonly owned_inventory: readonly OwnedInstallPath[];
  readonly created_at: string;
  readonly receipt_sha256: string;
}

type ReceiptMaterial = Omit<InstallReceipt, 'receipt_sha256'>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createInstallReceipt(material: ReceiptMaterial): InstallReceipt {
  return { ...material, receipt_sha256: sha256(canonical(material)) };
}

export function validateInstallReceipt(value: unknown): InstallReceipt {
  if (value === null || typeof value !== 'object') throw new Error('E_INSTALL_RECEIPT_INVALID');
  const receipt = value as InstallReceipt;
  if (receipt.store_kind !== 'omcu_install_receipt' || receipt.schema_version !== 1
    || !['install', 'update'].includes(receipt.action)
    || !/^[a-f0-9]{64}$/.test(receipt.source?.sha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(receipt.installed?.sha256 ?? '')
    || !Array.isArray(receipt.owned_inventory)) throw new Error('E_INSTALL_RECEIPT_INVALID');
  const { receipt_sha256, ...material } = receipt;
  if (receipt_sha256 !== sha256(canonical(material))) throw new Error('E_INSTALL_RECEIPT_TAMPERED');
  return receipt;
}

export function writeInstallReceipt(file: string, receipt: InstallReceipt): string {
  validateInstallReceipt(receipt);
  const target = path.resolve(file);
  if (fs.existsSync(target)) throw new Error('E_INSTALL_RECEIPT_EXISTS');
  atomicWriteJson(target, receipt);
  fs.chmodSync(target, 0o400);
  return target;
}

export function readInstallReceipt(file: string): InstallReceipt {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) {
    throw new Error('E_INSTALL_RECEIPT_NOT_IMMUTABLE');
  }
  return validateInstallReceipt(JSON.parse(fs.readFileSync(file, 'utf8')));
}
