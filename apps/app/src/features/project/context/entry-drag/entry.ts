/**
 * What a drag knows of a row: its identity, never where it sits. Placement is
 * read from the replica when a drop is planned, so a row that moved (or that a
 * peer moved) is still the same row.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogNode } from "@/client/query/context-catalog-projection";
import type { LinkNoteSubject } from "../rename-operation-lifecycle";

/** A document by its ID, or a folder by its entry ID. */
export type EntryRef = LinkNoteSubject;

/** A row's selection key. It has no scheme, so it survives a move. */
export const entryKey = (ref: EntryRef): string => `${ref.kind}:${ref.id}`;

/** A mounted row as a drag sees it: identity, what the preview and payload show, and whether its surface grants Move. */
export type DragEntry = { ref: EntryRef; name: string; uri: string; movable: boolean };

export function dragEntry(node: CatalogNode, movable: boolean): DragEntry {
  return {
    ref:
      node.kind === "file"
        ? { kind: "file", id: node.documentId }
        : { kind: "folder", id: node.entryId },
    name: node.name,
    uri: node.uri,
    movable,
  };
}

/**
 * Rows move freely within one system: the project's own areas are one, User
 * (the writer's, in every project) is one, and each owner's Scratch or Uploads
 * is its own. Crossing systems is a choice (Move or Copy), not a drop.
 */
export function entrySystem(
  scheme: ProjectContextTreeScheme,
  owner: { workId?: string | null; rootThreadId?: string | null },
): string {
  if (scheme === "user") return "user";
  if (isProjectScopedScheme(scheme)) return "project";
  return `${scheme}:${owner.rootThreadId ?? owner.workId ?? ""}`;
}
