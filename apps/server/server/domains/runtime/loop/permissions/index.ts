// @ts-nocheck
export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };

export interface PermissionGate {
  check(toolName: string, projectedCostMillicredits?: number): PermissionDecision;
}

export interface PermissionProfile {
  tools: { allow: string[]; deny?: string[] };
  maxCostMillicredits?: number;
}

export interface EffectivePermissions {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
  maxCostMillicredits?: number;
}

export function computeEffectivePermissions(profile: PermissionProfile): EffectivePermissions {
  return {
    allowedTools: new Set(profile.tools.allow),
    deniedTools: new Set(profile.tools.deny ?? []),
    maxCostMillicredits: profile.maxCostMillicredits,
  };
}

export function createPermissionGate(permissions: EffectivePermissions): PermissionGate {
  return {
    check(toolName, projectedCostMillicredits = 0) {
      if (permissions.deniedTools.has(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is disabled by policy.` };
      }
      const allowed = permissions.allowedTools.has("*") || permissions.allowedTools.has(toolName);
      if (!allowed) return { allowed: false, reason: `Tool "${toolName}" is not enabled.` };
      if (
        permissions.maxCostMillicredits !== undefined &&
        projectedCostMillicredits > permissions.maxCostMillicredits
      ) {
        return { allowed: false, reason: "Projected turn cost exceeds the configured cap." };
      }
      return { allowed: true };
    },
  };
}

export const DEFAULT_PROFILE: PermissionProfile = { tools: { allow: ["*"] } };
export function resolveProfile(_name = "default"): PermissionProfile {
  return DEFAULT_PROFILE;
}
