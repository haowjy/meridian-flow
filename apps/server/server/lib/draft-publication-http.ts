/**
 * The HTTP meaning of a draft publication's failures, shared by every route that applies
 * or discards a Work's draft: per-document Apply, Apply all, Discard and Discard all.
 * One mapping, so a known failure reads the same everywhere.
 */
import { createError } from "nitro/h3";
import { DuplicateApplyItemError } from "../domains/collab/domain/draft-publication.js";

/** Throws the HTTP error of a known failure, or leaves an unknown cause to its caller. */
export function throwKnownPublicationFailure(cause: unknown): void {
  if (cause instanceof DuplicateApplyItemError) {
    throw createError({ statusCode: 400, message: cause.message });
  }
}
