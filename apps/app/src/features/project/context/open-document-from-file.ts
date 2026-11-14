/**
 * open-document-from-file — adapter from context-tree file metadata to OpenDocument.
 *
 * Keeps desktop and phone context navigation on the same tab construction path
 * so file classification, schema type, and viewer metadata cannot drift between
 * shells. Work-scoped tabs retain their owner row id, including No Work; a
 * chat's Scratch retains its lineage and the handle its URI spells.
 */
import { isWorkScopedScheme, parseContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogFileEntry,
  ContextOwner,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { OpenDocument, OpenDocumentOwner, ServerOpenDocument } from "@/client/stores";
import type { TreeFile } from "@/core/project-tree/tree-view";

/** The handle (`c15`) a chat's upload's URI spells. */
function chatRefOf(file: TreeFile): string {
  const parsed = parseContextUri(file.uri);
  if (!parsed.ok || parsed.value.authority.kind !== "chat")
    throw new Error("A chat's upload must have a chat authority");
  return parsed.value.authority.chatRef;
}

/** The handle (`c12`) a chat's Scratch file's URI spells. */
function lineageRefOf(file: TreeFile): string {
  const parsed = parseContextUri(file.uri);
  if (!parsed.ok || parsed.value.authority.kind !== "lineage")
    throw new Error("A chat's Scratch file must have a chat authority");
  return parsed.value.authority.rootThreadRef;
}

export function openDocumentFromFile(
  scheme: ProjectContextTreeScheme,
  file: TreeFile,
  owner: ContextOwner = {},
): ServerOpenDocument {
  if (scheme === "uploads" && !owner.chatThreadId)
    throw new Error("A chat's upload tab requires its chat");
  if (isWorkScopedScheme(scheme) && !owner.workId && !owner.rootThreadId)
    throw new Error("Scratch tabs require a Work row id or a lineage");
  const tabOwner: OpenDocumentOwner =
    scheme === "uploads" && owner.chatThreadId
      ? { chatId: owner.chatThreadId, chatRef: chatRefOf(file) }
      : scheme === "scratch" && owner.rootThreadId
        ? { rootThreadId: owner.rootThreadId, rootThreadRef: lineageRefOf(file) }
        : isWorkScopedScheme(scheme) && owner.workId
          ? { workId: owner.workId }
          : {};
  const base = {
    documentId: file.documentId,
    scheme,
    path: file.path,
    name: file.name,
    provisionalName: file.provisionalName,
    ...tabOwner,
  };
  return {
    ...base,
    ...(file.editable
      ? {
          kind: "tracked" as const,
          editable: true as const,
          filetype: file.filetype,
          schemaType: file.schemaType,
        }
      : {
          kind: "viewer" as const,
          editable: false as const,
          fileType: file.fileType,
          mimeType: file.mimeType,
        }),
  };
}

/** The server's answer for a document the list does not show, in the shape the screens read. */
export function treeFileFromCatalogEntry(entry: CatalogFileEntry): TreeFile {
  const base = {
    kind: "file" as const,
    entryId: entry.entryId,
    parentId: entry.parentId,
    documentId: entry.entryId,
    name: entry.name,
    extension: entry.extension,
    aliases: entry.aliases,
    path: `/${entry.path.join("/")}`,
    uri: entry.uri,
    provisionalName: entry.provisionalName,
    hasProperties: entry.hasProperties ?? false,
  };
  if (entry.editable)
    return { ...base, editable: true, filetype: entry.filetype, schemaType: entry.schemaType };
  return {
    ...base,
    editable: false,
    disposition: entry.disposition,
    fileType: entry.fileType,
    ...(entry.disposition === "custom" ? { filetype: entry.filetype } : {}),
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
  };
}

export const serverDocumentFromFile = openDocumentFromFile;

/** What a tab's document is in the list now: where it sits, or that it is gone. */
export type TabPlacement =
  | { kind: "none" }
  | { kind: "removed" }
  | { kind: "projected"; document: OpenDocument };

/**
 * A tab follows its document's node: a rename or a move shows here at once, and a node that
 * left the view (or a list that has synced without it) removes the tab. A draft-only document
 * is one live does not hold, so the list says nothing about it. While the list has not synced
 * a missing node is not a removal.
 */
export function placeTab(
  found: { scheme: ProjectContextTreeScheme; file: TreeFile; owner: ContextOwner } | null,
  listSynced: boolean,
  draftOnly: boolean,
): TabPlacement {
  if (draftOnly) return { kind: "none" };
  if (!found) return listSynced ? { kind: "removed" } : { kind: "none" };
  return {
    kind: "projected",
    document: openDocumentFromFile(found.scheme, found.file, found.owner),
  };
}
