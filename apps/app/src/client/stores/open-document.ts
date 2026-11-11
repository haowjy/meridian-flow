/**
 * The descriptor a document host paints from: identity, owner and kind, derived per view from
 * the catalog, a draft row or the replica. Nothing stores it.
 */
import type {
  ContextOwner,
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
/**
 * A tab's owner, exclusive by type: a Work row id (Scratch), a No Work chat's
 * lineage, or a chat (uploads), each with the handle its URI spells. Project
 * schemes have none.
 */
export type TabOwner =
  | {
      workId?: string;
      rootThreadId?: undefined;
      rootThreadRef?: undefined;
      chatId?: undefined;
      chatRef?: undefined;
    }
  | {
      workId?: undefined;
      rootThreadId: string;
      rootThreadRef: string;
      chatId?: undefined;
      chatRef?: undefined;
    }
  | {
      workId?: undefined;
      rootThreadId?: undefined;
      rootThreadRef?: undefined;
      chatId: string;
      chatRef: string;
    };

/** A patch's owner, with the absent arm spelled out so a spread replaces the old owner. */
export function replaceOwner(owner: TabOwner): TabOwner {
  const absent = { chatId: undefined, chatRef: undefined } as const;
  if (owner.chatId !== undefined)
    return {
      workId: undefined,
      rootThreadId: undefined,
      rootThreadRef: undefined,
      chatId: owner.chatId,
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
export function tabContextOwner(owner: TabOwner): ContextOwner {
  if (owner.chatId !== undefined) return { chatThreadId: owner.chatId, chatRef: owner.chatRef };
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
      schemaType: YjsTrackedSchemaType;
      provisionalName?: boolean;
      /** Stable resource identity retained when a local document gains a server location. */
      resourceHandle?: string;
      /** Device provenance retained after a local document materializes. */
      origin?: "local-resource";
      /**
       * The replica knows the server holds no row for this document yet. A working-set route
       * names only held documents: one for this tab makes the server refuse the whole snapshot.
       */
      localOnly?: true;
    } & TabOwner)
  | ({
      kind: "viewer";
      documentId: string;
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
      /** Stable resource identity for namespace operations and local cache lookup. */
      resourceHandle?: string;
    } & TabOwner)
  | {
      kind: "new";
      documentId: string;
      name: string;
      resourceHandle: string;
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
