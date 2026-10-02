/** Permission model types for Meridian-owned tool dispatch. */
import type { InvalidArgumentIssue } from "../../tools/invalid-arguments.js";

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; kind: "permission_denied"; reason: string }
  | {
      allowed: false;
      kind: "invalid_arguments";
      /** The rendered `invalid_arguments` message, identical to the executor's. */
      reason: string;
      issues: InvalidArgumentIssue[];
    };

export interface PermissionGate {
  check(toolName: string, input?: unknown): PermissionDecision;
}
