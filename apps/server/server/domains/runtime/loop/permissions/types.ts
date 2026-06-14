/** Permission model types for Meridian-owned tool dispatch. */
export interface PermissionProfile {
  tools: { allow: string[]; deny?: string[] };
  maxCostMillicredits?: number;
}

export interface EffectivePermissions {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
  maxCostMillicredits?: number;
}

export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };

export interface PermissionGate {
  check(toolName: string, projectedCostMillicredits?: number): PermissionDecision;
}
