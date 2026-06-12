// @ts-nocheck
/**
 * Workbench authorization helper: requireWorkbenchOwner loads a workbench and asserts
 * the caller owns it, throwing an h3 error otherwise. Owns the workbench ownership
 * gate shared by route handlers; depends inward on the WorkbenchRepository port.
 */

import type { UserId } from "@meridian/contracts/runtime";
import type { Workbench } from "@meridian/contracts/workbenches";
import { createError } from "nitro/h3";
import type { WorkbenchRepository } from "./ports/workbench-repository.js";

export type RequireWorkbenchOwnerOptions = {
  /** When true, soft-deleted workbenches are returned (for idempotent DELETE). */
  includeSoftDeleted?: boolean;
};

export async function requireWorkbenchOwner(
  repos: { workbenches: WorkbenchRepository },
  workbenchId: string,
  userId: UserId,
  options?: RequireWorkbenchOwnerOptions,
): Promise<Workbench> {
  const workbench = await repos.workbenches.findById(workbenchId);
  if (!workbench) {
    throw createError({ statusCode: 404, message: "Workbench not found" });
  }
  if (workbench.userId !== userId) {
    throw createError({ statusCode: 404, message: "Workbench not found" });
  }
  if (!options?.includeSoftDeleted && workbench.deletedAt) {
    throw createError({ statusCode: 404, message: "Workbench not found" });
  }
  return workbench;
}
