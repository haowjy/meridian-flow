/** Project-scoped standing grants for action-policy decisions that would ask. */
import type { ProjectId } from "@meridian/contracts/runtime";
import type { AskableAction } from "./action-policy.js";

export interface PermissionGrantStore {
  has(projectId: ProjectId, action: AskableAction): Promise<boolean>;
  grant(projectId: ProjectId, action: AskableAction): Promise<void>;
}
