import type { EffectivePermissions, PermissionGate, PermissionProfile } from "./types.js";

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
