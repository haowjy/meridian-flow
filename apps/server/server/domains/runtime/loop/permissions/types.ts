/** Permission model types for Meridian-owned tool dispatch. */
export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };

export interface PermissionGate {
  check(toolName: string, input?: unknown): PermissionDecision;
}
