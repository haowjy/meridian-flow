/**
 * What a drag knows of a row: its identity, never where it sits. Placement is
 * read from the replay when a drop is planned, so a row that moved (or that a
 * peer moved) is still the same row.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextOwner,
  CopyContextEntryView,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { TrashEntry } from "@/client/query/useDocumentTrash";
import type { TreeEntry } from "@/core/project-tree/tree-view";

export type EntryRef = { kind: "file" | "folder"; id: string };

export const entryKey = (ref: EntryRef): string => `${ref.kind}:${ref.id}`;

export type DragEntry = { ref: EntryRef; name: string; view: CopyContextEntryView };

export type DragSource = "list-row" | "reference" | "trash";

export type EntryDrag = { entries: readonly DragEntry[]; source: DragSource };

export function trashDragEntry(entry: Pick<TrashEntry, "nodeId" | "kind" | "name">): DragEntry {
  return { ref: trashRef(entry), name: entry.name, view: LIVE_VIEW };
}

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

export function entrySystem(scheme: ProjectContextTreeScheme, owner: ContextOwner): string {
  if (scheme === "user") return "user";
  if (isProjectScopedScheme(scheme)) return "project";
  return `${scheme}:${owner.chatThreadId ?? owner.rootThreadId ?? owner.workId ?? ""}`;
}
