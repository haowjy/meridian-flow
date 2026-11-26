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
export type OpenDocumentOwner =
  | (WorkOwnerRef & { workId?: string })
  | (LineageOwnerRef & { rootThreadRef: string })
  | ChatOwnerRef;

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

export function isEditorScheme(scheme: ProjectContextTreeScheme): boolean {
  return scheme !== "uploads";
}

export function isEditorOpenDocument(tab: OpenDocument): boolean {
  return tab.kind === "new" || isEditorScheme(tab.scheme);
}
