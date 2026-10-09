/**
 * draft-dock-files — what the composer strip shows of each draft file, for one
 * chat. Pure data, no React.
 *
 * A change is this chat's when the chat wrote any of its visible operations
 * (`ReviewChange.threadIds`); the writer's own edits inside it ride with it,
 * and other chats' separate changes and the writer's separate changes are in
 * no chat's strip. A file stays a candidate until its preview lands: only then
 * is it known whether the chat still has a change in it.
 */
import type { DraftPreviewEntry } from "@/client/query/useDraftPreview";
import { listablePreview } from "@/features/draft-review/draft-changes";
import { type ReviewChange, reviewChangesOfPreview } from "@/features/draft-review/review-changes";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";

/** Another chat that wrote into one of this chat's changes. */
export type TiedChat = { threadId: string; title: string | null };

export type DockFile = {
  row: ReviewFileTarget;
  name: string;
  status: "loading" | "error" | "ready";
  /** Present when the preview failed to read. */
  retry: (() => void) | null;
  /** The draft proposes a document not yet in the project: Review-only on the strip. */
  newDocument: boolean;
  /** This chat's changes in the file, in document order (empty until the preview lands). */
  changes: readonly ReviewChange[];
  /** The ones Apply and Discard take: every change of the chat the server lets us act on, none for a new document. */
  actionable: readonly ReviewChange[];
  /** Changes only Apply draft or Discard draft can handle. */
  needsDraftCommand: number;
  /** Actionable changes that also hold an edit of another chat, which Apply and Discard take along. */
  tiedChanges: number;
  /** The other chats in those changes, latest first. */
  tiedChats: readonly TiedChat[];
};

const NO_CHANGES: readonly ReviewChange[] = [];

/**
 * One candidate file as the strip shows it. The entry's preview is already
 * without the operations the command records hide (a batch's queued selections,
 * a claim in flight), so a sent change has left the strip.
 */
export function dockFile(
  row: ReviewFileTarget,
  name: string,
  entry: DraftPreviewEntry | undefined,
  threadId: string,
): DockFile {
  const base = {
    row,
    name,
    retry: null,
    newDocument: row.isNewDocument,
    changes: NO_CHANGES,
    actionable: NO_CHANGES,
    needsDraftCommand: 0,
    tiedChanges: 0,
    tiedChats: [],
  } satisfies Omit<DockFile, "status">;
  if (entry?.status === "error") return { ...base, status: "error", retry: entry.retry };
  if (entry?.status !== "ready") return { ...base, status: "loading" };
  // A draft that is gone has no change of the chat's left to show.
  if (entry.preview.status === "gone") return { ...base, status: "ready" };
  const active = listablePreview(entry.preview);
  if (!active) return { ...base, status: "loading" };

  const newDocument = row.isNewDocument || active.isNewDocument === true;
  const changes = reviewChangesOfPreview(active).filter((change) =>
    change.threadIds.includes(threadId),
  );
  const actionable = newDocument ? NO_CHANGES : changes.filter((change) => change.actionable);
  const tiedChats = new Map<string, TiedChat>();
  let tiedChanges = 0;
  for (const change of actionable) {
    const others = change.threadIds.filter((id) => id !== threadId);
    if (others.length === 0) continue;
    tiedChanges += 1;
    if (change.attribution.kind !== "chats") continue;
    for (const chat of change.attribution.chats) {
      if (chat.threadId !== threadId && !tiedChats.has(chat.threadId)) {
        tiedChats.set(chat.threadId, { threadId: chat.threadId, title: chat.title });
      }
    }
  }
  return {
    ...base,
    status: "ready",
    newDocument,
    changes,
    actionable,
    needsDraftCommand: newDocument ? 0 : changes.length - actionable.length,
    tiedChanges,
    tiedChats: [...tiedChats.values()],
  };
}

/** On the strip while its preview is unread, and once read only if the chat has a change in it. */
export function isOnStrip(file: DockFile): boolean {
  return file.status !== "ready" || file.changes.length > 0;
}

/** The notes the writer reads before any click, for one file or for all of them. */
export type DockNotes = {
  tiedChanges: number;
  tiedChats: readonly TiedChat[];
  needsDraftCommand: number;
  newDocuments: readonly string[];
};

export function dockNotes(files: readonly DockFile[]): DockNotes {
  const tiedChats = new Map<string, TiedChat>();
  for (const file of files) for (const chat of file.tiedChats) tiedChats.set(chat.threadId, chat);
  return {
    tiedChanges: files.reduce((sum, file) => sum + file.tiedChanges, 0),
    tiedChats: [...tiedChats.values()],
    needsDraftCommand: files.reduce((sum, file) => sum + file.needsDraftCommand, 0),
    newDocuments: files.filter((file) => file.newDocument).map((file) => file.name),
  };
}

export function hasNotes(notes: DockNotes): boolean {
  return notes.tiedChanges > 0 || notes.needsDraftCommand > 0 || notes.newDocuments.length > 0;
}

/** The changes across files, or null while any preview is unread: a count is never read from a partial answer. */
export function totalChanges(files: readonly DockFile[]): number | null {
  if (files.some((file) => file.status !== "ready")) return null;
  return files.reduce((sum, file) => sum + file.changes.length, 0);
}
