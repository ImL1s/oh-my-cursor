/**
 * Component catalog and provenance types for OMCU's native Cursor plugin surfaces.
 * Issue #1.
 */

export type ComponentType =
  | 'skill'
  | 'agent'
  | 'rule'
  | 'hook'
  | 'mcp'
  | 'sdk-service';

export type SupportTier =
  | 'native'
  | 'composed'
  | 'thin-extension'
  | 'fallback'
  | 'unsupported';

export interface CatalogComponent {
  readonly id: string;
  readonly type: ComponentType;
  readonly canonicalName: string;
  readonly nativeCursorPath: string;
  readonly aliases: readonly string[];
  readonly version: string;
  readonly contentSha256: string;
  readonly pluginManifestEntry?: string | undefined;
  readonly sdkServiceEntry?: string | undefined;
  readonly supportTier: SupportTier;
  readonly description: string;
  readonly provenanceMarker: string;
}

export interface CatalogManifest {
  readonly schema_version: 1;
  readonly omcu_version: string;
  readonly generated_at: string;
  readonly components: readonly CatalogComponent[];
}

export interface ComponentResolution {
  readonly id: string;
  readonly canonicalName: string;
  readonly type: ComponentType;
  readonly nativeCursorPath: string;
  readonly aliases: readonly string[];
  readonly version: string;
  readonly contentSha256: string;
  readonly resolvedPath: string | null;
  readonly supportTier: SupportTier;
  readonly provenanceMarker: string;
  readonly status: 'resolved' | 'missing' | 'colliding';
  readonly collisionRoot?: string | undefined;
}

export interface CollisionRecord {
  readonly componentName: string;
  readonly type: ComponentType;
  readonly sourcePaths: readonly string[];
  readonly provenance: string;
  readonly expectedHash?: string | undefined;
  readonly observedHash?: string | undefined;
  readonly resolutionSupport: string;
  readonly canonicalReplacement: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export type ActivationModeKind =
  | 'marketplace'
  | 'installed_stage'
  | 'project_local'
  | 'sdk_only'
  | 'developer_checkout'
  | 'cursor_cli';

export interface ActivationModeReport {
  readonly mode: ActivationModeKind;
  readonly active: boolean;
  readonly releasePath: string | null;
  readonly version: string | null;
  readonly hash: string | null;
  readonly visibleComponents: readonly string[];
}

export interface SupportTierMatrix {
  readonly interactive: 'native' | 'composed' | 'fallback' | 'unsupported';
  readonly cli: 'native' | 'composed' | 'fallback' | 'unsupported';
  readonly sdk: 'native' | 'composed' | 'fallback' | 'unsupported';
}

export interface PluginStatusReport {
  readonly ok: boolean;
  readonly package_present: boolean;
  readonly manifest_valid: boolean;
  readonly host_accepted: boolean;
  readonly registry_visible: boolean;
  readonly activation_proven: boolean;
  readonly sdk_service_proven: boolean;
  readonly collisions: readonly CollisionRecord[];
  readonly resolved: {
    readonly release_path: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly support_tier: SupportTierMatrix;
  readonly activation_modes: readonly ActivationModeReport[];
  readonly components?: readonly ComponentResolution[] | undefined;
}

export interface LiveProbeResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly detail?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
}

export interface PluginDoctorReport extends PluginStatusReport {
  readonly live_probes: {
    readonly plugin_discovery: LiveProbeResult;
    readonly skill_activation: LiveProbeResult;
    readonly agent_activation: LiveProbeResult;
    readonly hook_activation: LiveProbeResult;
    readonly mcp_activation: LiveProbeResult;
    readonly sdk_service: LiveProbeResult;
  };
}

export interface ComponentsListReport {
  readonly ok: boolean;
  readonly total: number;
  readonly resolved_count: number;
  readonly colliding_count: number;
  readonly missing_count: number;
  readonly components: readonly ComponentResolution[];
}

export interface AliasExplainReport {
  readonly query: string;
  readonly found: boolean;
  readonly is_canonical: boolean;
  readonly canonical_id: string | null;
  readonly canonical_name: string | null;
  readonly type: ComponentType | null;
  readonly aliases: readonly string[];
  readonly canonical_replacement: string | null;
  readonly collisions: readonly CollisionRecord[];
  readonly support_tier: string | null;
  readonly target_mechanism: string | null;
  readonly guidance: string;
}

export interface CursorComponentsCapabilityReport {
  readonly ok: boolean;
  readonly host: 'cursor-agent';
  readonly host_version: string | null;
  readonly components: {
    readonly plugin_manifest: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly skills: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly agents: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly rules: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly hooks: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly mcp: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
    readonly sdk: { readonly supported: boolean; readonly status: 'native' | 'composed' | 'unsupported'; readonly detail: string };
  };
  readonly live_proven: boolean;
}
