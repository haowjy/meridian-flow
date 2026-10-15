/**
 * The HTTP meaning of a draft publication's failures, shared by every route that applies
 * or discards a Work's draft: per-document Apply, Apply all, Discard and Discard all.
 * One mapping, so a batch handed to recovery reads the same everywhere.
 */
import type { DraftApplyPending } from "@meridian/contracts/drafts";
import { createError } from "nitro/h3";
import {
  DraftApplyPendingError,
  DuplicateApplyItemError,
} from "../domains/collab/domain/draft-publication.js";

/** Returns the accepted handoff, throws known failures, or leaves an unknown cause to its caller. */
export function draftPublicationHttpAnswer(cause: unknown): DraftApplyPending | undefined {
  if (cause instanceof DraftApplyPendingError) {
    return { status: "pending", draftId: cause.draftId };
  }
  if (cause instanceof DuplicateApplyItemError) {
    throw createError({ statusCode: 400, message: cause.message });
  }
}
