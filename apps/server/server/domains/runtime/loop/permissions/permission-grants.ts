/** Project-scoped standing grants for action-policy decisions that would ask. */
import type { ProjectId } from "@meridian/contracts/runtime";
import type { AgentAction } from "./action-policy.js";

export interface PermissionGrantStore {
  has(projectId: ProjectId, action: AgentAction): Promise<boolean>;
  grant(projectId: ProjectId, action: AgentAction): Promise<void>;
}
