/**
 * The descriptor a document host paints from: identity, owner and kind, derived per view from
 * the project's tree, a draft row or the sources. Nothing stores it.
 */
import type {
  ChatOwnerRef,
  ContextOwner,
  DocumentFileType,
  Filetype,
  LineageOwnerRef,
  ProjectContextTreeScheme,
  TrackedSchemaType,
  WorkOwnerRef,
} from "@meridian/contracts/protocol";
/**
 * A tab's owner, a `ContextOwner`: a Work row id (Scratch), a No Work chat's lineage with the
 * handle its URI spells, or a chat (uploads), whose handle it has once the chat does. Project
 * schemes have none.
 */
export type OpenDocumentOwner =
  | (WorkOwnerRef & { workId?: string })
  | (LineageOwnerRef & { rootThreadRef: string })
  | ChatOwnerRef;

/** A patch's owner, with the absent arm spelled out so a spread replaces the old owner. */
export function replaceOwner(owner: OpenDocumentOwner): OpenDocumentOwner {
  const absent = { chatThreadId: undefined, chatRef: undefined } as const;
  if (owner.chatThreadId !== undefined)
    return {
      workId: undefined,
      rootThreadId: undefined,
      rootThreadRef: undefined,
      chatThreadId: owner.chatThreadId,
      chatRef: owner.chatRef,
    };
  return owner.rootThreadId !== undefined
    ? {
        workId: undefined,
        rootThreadId: owner.rootThreadId,
        rootThreadRef: owner.rootThreadRef,
        ...absent,
      }
    : { workId: owner.workId, rootThreadId: undefined, rootThreadRef: undefined, ...absent };
}

/** The owner a tab names, for catalog and request lookups. */
export function documentContextOwner(owner: OpenDocumentOwner): ContextOwner {
  if (owner.chatThreadId !== undefined)
    return { chatThreadId: owner.chatThreadId, chatRef: owner.chatRef };
  return owner.rootThreadId !== undefined
    ? { rootThreadId: owner.rootThreadId, rootThreadRef: owner.rootThreadRef }
    : { workId: owner.workId ?? null };
}

export type OpenDocument =
  | ({
      kind: "tracked";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      editable: true;
      filetype: Filetype;
      schemaType: TrackedSchemaType;
      provisionalName?: boolean;
    } & OpenDocumentOwner)
  | ({
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    } & OpenDocumentOwner)
  | {
      kind: "new";
      documentId: string;
      name: string;
    };

export type ServerOpenDocument = Extract<OpenDocument, { kind: "tracked" | "viewer" }>;

/**
 * The one scheme the Editor never opens: uploads belong to a chat and open in
 * their resource view.
 */
export function isEditorScheme(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads";
}

/** Whether a main view can hold the document: every kind but an upload. */
export function isEditorOpenDocument(tab: OpenDocument): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}
