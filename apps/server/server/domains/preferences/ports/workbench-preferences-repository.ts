// @ts-nocheck
/**
 * Workbench preferences persistence port: stores the authenticated user's UI defaults for one workbench.
 * The boundary is intentionally small: reads return the contract default when absent, and upserts merge partial updates into the current/default value.
 */
import type {
  UpdateWorkbenchPreferencesRequest,
  WorkbenchPreferences,
} from "@meridian/contracts/preferences";
import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";

export interface WorkbenchPreferencesRepository {
  read(userId: UserId, workbenchId: WorkbenchId): Promise<WorkbenchPreferences>;
  upsert(
    userId: UserId,
    workbenchId: WorkbenchId,
    input: UpdateWorkbenchPreferencesRequest,
  ): Promise<WorkbenchPreferences>;
}
