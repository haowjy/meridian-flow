/** Permission model types for Meridian-owned tool dispatch. */
export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; kind: "permission_denied" | "invalid_arguments"; reason: string };

export interface PermissionGate {
  check(toolName: string, input?: unknown): PermissionDecision;
}
