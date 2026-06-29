/**
 * useThreadDocumentResolver — single lookup from a thread `documentId` to the
 * underlying upload/recent DTO, used by the popover→rail handoff so both
 * popover sites (dock and center chat) share one resolution path.
 */
import type {
  ThreadRecentDocumentItem,
  ThreadUploadDocumentItem,
} from "@meridian/contracts/protocol";
import { useCallback } from "react";

import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { useThreadUploads } from "@/client/query/useThreadUploads";

export type ResolvedThreadDocument =
  | { kind: "upload"; upload: ThreadUploadDocumentItem }
  | { kind: "recent"; recent: ThreadRecentDocumentItem };

export type ThreadDocumentResolver = (documentId: string) => ResolvedThreadDocument | null;

export function useThreadDocumentResolver(threadId: string | null): ThreadDocumentResolver {
  const uploads = useThreadUploads(threadId);
  const recent = useThreadRecentDocuments(threadId);

  // Uploads take precedence when an id collides — uploads carry the
  // `editable`/`schemaType` provenance needed for the rail viewer's
  // tracked-vs-binary dispatch, and the upload list is the more specific
  // source for "files the user dropped in this chat".
  return useCallback(
    (documentId: string) => {
      const upload = uploads.uploads?.find((row) => row.documentId === documentId);
      if (upload) return { kind: "upload", upload };
      const r = recent.documents?.find((row) => row.documentId === documentId);
      if (r) return { kind: "recent", recent: r };
      return null;
    },
    [uploads.uploads, recent.documents],
  );
}
