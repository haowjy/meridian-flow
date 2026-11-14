/**
 * What a drag knows of a row: its identity, never where it sits. Placement is
 * read from the replay when a drop is planned, so a row that moved (or that a
 * peer moved) is still the same row.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type {
  CopyContextEntryView,
  ProjectContextTreeScheme,
  TrashEntry,
} from "@meridian/contracts/protocol";
import type { TreeEntry } from "@/core/project-tree/tree-view";

/** A document or a folder, by its node id. */
export type EntryRef = { kind: "file" | "folder"; id: string };

/** A row's selection key. It has no scheme, so it survives a move. */
export const entryKey = (ref: EntryRef): string => `${ref.kind}:${ref.id}`;

/**
 * A dragged entry: identity, the name the preview shows, and what a Copy of it reads: the live
 * document (a tree row), or the draft the source shows (a draft tab).
 */
export type DragEntry = { ref: EntryRef; name: string; view: CopyContextEntryView };

/**
 * A list row dragged in its list's selection, or any other source naming a document or folder (a
 * chip, tab, crumb, Recent row, receipt or Uploads entry). Only a list row within one system moves
 * at once; a reference always asks. A `trash` row is a Trash entry (a document or a folder): dropped
 * on the tree it is restored there (`restore-drop.ts`), never moved or copied.
 */
export type DragSource = "list-row" | "reference" | "trash";

/** The entries being dragged and where they came from. */
export type EntryDrag = { entries: readonly DragEntry[]; source: DragSource };

/** A Trash entry as a drag carries it: its identity and name. Its removal is read from Trash at the drop. */
export function trashDragEntry(entry: Pick<TrashEntry, "nodeId" | "kind" | "name">): DragEntry {
  return { ref: trashRef(entry), name: entry.name, view: LIVE_VIEW };
}

/** The node a Trash entry names, as a row or a restore names it. */
export function trashRef(entry: Pick<TrashEntry, "nodeId" | "kind">): EntryRef {
  return { kind: entry.kind === "folder" ? "folder" : "file", id: entry.nodeId };
}

export const LIVE_VIEW: CopyContextEntryView = { kind: "live" };

export function dragEntry(node: TreeEntry): DragEntry {
  return {
    ref:
      node.kind === "file"
        ? { kind: "file", id: node.documentId }
        : { kind: "folder", id: node.entryId },
    name: node.name,
    view: LIVE_VIEW,
  };
}

/**
 * Rows move freely within one system: the project's own areas are one, User
 * (the writer's, in every project) is one, and each owner's Scratch or Uploads
 * is its own. Crossing systems is a choice (Move or Copy), not a drop.
 */
export function entrySystem(
  scheme: ProjectContextTreeScheme,
  owner: { workId?: string | null; rootThreadId?: string | null; chatId?: string | null },
): string {
  if (scheme === "user") return "user";
  if (isProjectScopedScheme(scheme)) return "project";
  return `${scheme}:${owner.chatId ?? owner.rootThreadId ?? owner.workId ?? ""}`;
}
