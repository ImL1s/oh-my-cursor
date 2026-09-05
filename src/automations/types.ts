export type AutomationTriggerKind = 'cron' | 'event' | 'schedule';

export interface AutomationTrigger {
  readonly kind: AutomationTriggerKind;
  readonly cron?: string | undefined;
  readonly event?: string | undefined;
}

export interface AutomationAction {
  readonly role: string;
  readonly profile?: string | undefined;
  readonly prompt: string;
  readonly runtime?: 'local' | 'cloud' | undefined;
  readonly workflowId?: string | undefined;
}

export interface AutomationManifest {
  readonly schema_version: 1;
  readonly automationId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly status: 'planned' | 'installed' | 'disabled';
  readonly target: 'cursor-native' | 'fallback-local';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly installedAt?: string | undefined;
}

export interface CreateAutomationInput {
  readonly automationId?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
}

export interface AutomationStatus {
  readonly automationsAvailable: boolean;
  readonly targetRuntime: 'cursor-native' | 'fallback-local';
  readonly fallbackSchedulerEnabled: boolean;
  readonly automations: readonly AutomationManifest[];
}
