/**
 * The HTTP meaning of a draft publication's failures, shared by every route that applies
 * or discards a Work's draft: per-document Apply, Apply all, Discard, Discard all and D40's
 * write-mode switch. One mapping, so a batch handed to recovery reads the same everywhere.
 */
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { PublicationLeasesChangedError } from "../domains/collab/domain/branch-push-transition.js";
import {
  DraftApplyStaleError,
  DraftLinkRegistrationFailedError,
  DuplicateApplyItemError,
} from "../domains/collab/domain/draft-publication.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";

/** Throws the HTTP answer for a publication failure; returns for anything else. */
export function throwDraftPublicationHttpError(cause: unknown): void {
  if (cause instanceof DraftLinkRegistrationFailedError) {
    throw createError({ statusCode: 503, message: cause.message });
  }
  if (cause instanceof DuplicateApplyItemError) {
    throw createError({ statusCode: 400, message: cause.message });
  }
  // The draft kept growing past the call's bounded retries: the staged batch is with
  // recovery, which finishes it; nothing failed and nothing is done yet (F22).
  if (cause instanceof PublicationLeasesChangedError) {
    throw createError({
      statusCode: 503,
      message: "The draft kept changing while it was applied; it finishes in the background.",
    });
  }
  if (cause instanceof DraftApplyStaleError) {
    throwHttpInterrupt(meridianErrorFromSystem("draft_changed", cause.message, true), 409);
  }
}
