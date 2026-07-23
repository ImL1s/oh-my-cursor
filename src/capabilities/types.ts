export interface CapabilityClaim {
  readonly verified: boolean;
  readonly argv?: readonly string[];
  readonly reason?: string;
}

export interface CapabilityLock {
  readonly schema_version: 1;
  readonly host: 'cursor-agent';
  readonly host_version: string;
  readonly observed_at: string;
  readonly capabilities: Readonly<Record<string, CapabilityClaim>>;
}

export interface CapabilityDiscovery {
  readonly schema_version: 1;
  readonly host: 'cursor-agent';
  readonly expected_version: string;
  readonly observed_version: string | null;
  readonly version_matches: boolean;
  readonly help_matches: boolean;
  readonly verified: boolean;
  readonly diagnostics: readonly string[];
  readonly capabilities: Readonly<Record<string, CapabilityClaim>>;
}
