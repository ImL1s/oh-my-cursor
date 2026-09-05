/**
 * Parity and contract matrix types for OMC/OMX/OMO to Cursor-native mapping.
 * Issue #25.
 */

export type LicenseProvenanceClass = 'mit' | 'license_restricted' | 'clean_room_required';

export type SurfaceFamily =
  | 'skill'
  | 'agent'
  | 'workflow'
  | 'hook'
  | 'tool'
  | 'config'
  | 'state'
  | 'artifact'
  | 'mcp'
  | 'team'
  | 'permissions';

export interface SourceItem {
  readonly id: string;
  readonly source_project: string;
  readonly commit: string;
  readonly path: string;
  readonly hash_sha256: string;
  readonly license_class: LicenseProvenanceClass;
  readonly surface_family: SurfaceFamily;
  readonly source_name: string;
  readonly aliases: readonly string[];
  readonly invocation_grammar: string;
  readonly agents_models_tools_hooks: readonly string[];
  readonly state_lifecycle: string;
  readonly parallel_team_behavior: string;
  readonly permission_requirements: readonly string[];
  readonly artifacts_verification: string;
  readonly cancel_resume_recovery: string;
  readonly upstream_evidence: string;
}

export interface UpstreamLock {
  readonly schema_version: 1;
  readonly upstream_id: 'omc' | 'omx' | 'omo';
  readonly repository: string;
  readonly commit: string;
  readonly default_license: string;
  readonly observed_at: string;
  readonly total_items: number;
  readonly items: readonly SourceItem[];
}

export type CursorSurface =
  | 'sdk'
  | 'plugin'
  | 'cli'
  | 'cloud'
  | 'worktree'
  | 'canvas'
  | 'automation'
  | 'permissions'
  | 'router';

export type MechanismSupportStatus = 'live' | 'static' | 'not_run';

export interface CursorMechanism {
  readonly mechanism_id: string;
  readonly surface: CursorSurface;
  readonly name: string;
  readonly version_or_commit: string;
  readonly source_evidence: string;
  readonly requirements: {
    readonly local_or_cloud: 'local' | 'cloud' | 'both';
    readonly platform: readonly string[];
    readonly account_tier?: string;
  };
  readonly contract: {
    readonly input: string;
    readonly output: string;
    readonly lifecycle: string;
  };
  readonly persistence_and_identity: string;
  readonly permissions_and_tools: string;
  readonly known_limitations: readonly string[];
  readonly status: MechanismSupportStatus;
}

export interface CursorSdkLock {
  readonly schema_version: 1;
  readonly package_name: '@cursor/sdk';
  readonly version: string;
  readonly integrity: string;
  readonly tarball_url: string;
  readonly published_at: string;
  readonly dependencies: Record<string, string>;
  readonly capabilities: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly api_signature: string;
    readonly persistence_backend?: string;
    readonly verification_status: 'verified' | 'unverified';
  }[];
}

export interface CursorPluginsLock {
  readonly schema_version: 1;
  readonly repository: 'cursor/plugins';
  readonly commit: string;
  readonly observed_at: string;
  readonly reference_plugins: readonly {
    readonly id: string;
    readonly path: string;
    readonly description: string;
    readonly components: readonly {
      readonly type: 'skill' | 'agent' | 'rule' | 'hook' | 'mcp';
      readonly name: string;
      readonly path: string;
    }[];
  }[];
}

export interface CursorCookbookLock {
  readonly schema_version: 1;
  readonly repository: 'cursor/cookbook';
  readonly commit: string;
  readonly observed_at: string;
  readonly reference_patterns: readonly {
    readonly id: string;
    readonly path: string;
    readonly description: string;
    readonly pattern_type: 'dag_task_runner' | 'coding_agent_cli' | 'hooks' | 'custom_tools';
    readonly source_files: readonly string[];
  }[];
}

export interface CursorHostCapabilitiesLock {
  readonly schema_version: 2;
  readonly host: string;
  readonly host_version: string;
  readonly observed_at: string;
  readonly mechanisms: readonly CursorMechanism[];
}

export type ContractDisposition =
  | 'native'
  | 'composed'
  | 'thin-extension'
  | 'fallback'
  | 'unsupported';

export type ContractStatus =
  | 'pass'
  | 'partial'
  | 'blocked'
  | 'unsupported'
  | 'not_run'
  | 'drifted'
  | 'license_review_required';

export interface OmcuContractItem {
  readonly canonical_id: string;
  readonly name: string;
  readonly surface_family: SurfaceFamily;
  readonly source_analogs: {
    readonly omc?: string;
    readonly omx?: string;
    readonly omx_doctor?: string;
    readonly omo?: string;
    readonly [key: string]: string | undefined;
  };
  readonly selected_cursor_mechanisms: readonly string[];
  readonly omcu_domain_behavior: string;
  readonly disposition: ContractDisposition;
  readonly implementation_issue: string;
  readonly test_ids: readonly string[];
  readonly intentional_differences: string;
  readonly license_strategy: 'mit_attribution' | 'clean_room_spec' | 'apache_2' | 'omcu_original';
  readonly status: ContractStatus;
}

export interface OmcuContractLock {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly target_cursor_sdk_version: string;
  readonly total_contracts: number;
  readonly disposition_counts: Record<ContractDisposition, number>;
  readonly status_counts: Record<ContractStatus, number>;
  readonly contracts: readonly OmcuContractItem[];
}

export interface ParityLocks {
  readonly omc: UpstreamLock;
  readonly omx: UpstreamLock;
  readonly omo: UpstreamLock;
  readonly sdk: CursorSdkLock;
  readonly plugins: CursorPluginsLock;
  readonly cookbook: CursorCookbookLock;
  readonly hostCapabilities: CursorHostCapabilitiesLock;
  readonly contract: OmcuContractLock;
}

export interface ParityValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly totalUpstreamItems: number;
  readonly mappedUpstreamItems: number;
  readonly totalContracts: number;
  readonly cleanRoomPassed: boolean;
  readonly mechanismsValidated: number;
}

