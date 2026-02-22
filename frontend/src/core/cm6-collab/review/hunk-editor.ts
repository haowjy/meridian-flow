import type { ReviewHunk } from "./types";

export interface HunkEditSession {
  proposalId: string;
  hunkId: string;
  originalInsertedText: string;
  draftInsertedText: string;
}

export interface HunkEditCommit {
  proposalId: string;
  hunkId: string;
  originalInsertedText: string;
  insertedText: string;
  wasEdited: boolean;
}

export function startHunkEditSession(hunk: ReviewHunk): HunkEditSession {
  return {
    proposalId: hunk.proposalId,
    hunkId: hunk.id,
    originalInsertedText: hunk.insertedText ?? "",
    draftInsertedText: hunk.insertedText ?? "",
  };
}

export function updateHunkEditSession(
  session: HunkEditSession,
  draftInsertedText: string,
): HunkEditSession {
  return {
    ...session,
    draftInsertedText,
  };
}

export function resetHunkEditSession(
  session: HunkEditSession,
): HunkEditSession {
  return {
    ...session,
    draftInsertedText: session.originalInsertedText,
  };
}

export function commitHunkEditSession(
  session: HunkEditSession,
): HunkEditCommit {
  return {
    proposalId: session.proposalId,
    hunkId: session.hunkId,
    originalInsertedText: session.originalInsertedText,
    insertedText: session.draftInsertedText,
    wasEdited: session.draftInsertedText !== session.originalInsertedText,
  };
}

export function cancelHunkEditSession(): null {
  return null;
}
