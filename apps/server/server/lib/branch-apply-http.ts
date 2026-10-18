/**
 * The HTTP meaning of a draft Apply's failures, shared by every route that applies
 * or discards a Work's draft: per-document Apply, Apply all, Discard and Discard all.
 * One mapping, so a batch handed to recovery reads the same everywhere.
 */
import type { DraftApplyPending } from "@meridian/contracts/branches";
import { createError } from "nitro/h3";
import {
  BranchApplyPendingError,
  DuplicateApplyItemError,
} from "../domains/collab/domain/branch-apply.js";

/** Returns the accepted handoff, throws known failures, or leaves an unknown cause to its caller. */
export function branchApplyHttpAnswer(cause: unknown): DraftApplyPending | undefined {
  if (cause instanceof BranchApplyPendingError) {
    return { status: "pending", branchId: cause.branchId };
  }
  if (cause instanceof DuplicateApplyItemError) {
    throw createError({ statusCode: 400, message: cause.message });
  }
}
