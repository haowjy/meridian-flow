/** Notice construction for reversal and writer-awareness events. */

import type { DraftId } from "@meridian/contracts";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { DocumentUriResolver } from "../../context/document-uri-resolver.js";
import type { NoticePort } from "../../notices/index.js";

export { documentTitleFromUri } from "@meridian/contracts/context-uri";

export type ReversalNoticeDiagnostics = {
  documentUriMissing(input: {
    docId: string;
    threadId: string;
    representativeTurnId?: string | null;
  }): void;
};

export function createDocumentPresentationResolver(resolveDocumentUri: DocumentUriResolver) {
  return {
    async resolveTitle(documentId: string): Promise<string | null> {
      return documentTitleFromUri(await resolveDocumentUri(documentId));
    },
  };
}

export async function recordAwarenessDegradedNotice(input: {
  notices: NoticePort;
  resolveDocumentUri: DocumentUriResolver;
  threadId: string;
  documentIds: readonly string[];
}): Promise<void> {
  const documentNames = await Promise.all(
    input.documentIds.map(async (documentId) => {
      const uri = await input.resolveDocumentUri(documentId);
      return documentTitleFromUri(uri) ?? documentId;
    }),
  );
  await input.notices.record({
    kind: "awareness_degraded",
    scope: { kind: "thread", threadId: input.threadId },
    message: "Your changes are committed, but concurrent user content could not be verified.",
    data: { documentIds: [...input.documentIds], documentNames },
  });
}

export interface TurnInverseNoticePort {
  record(input: {
    threadId: string;
    turnId: string;
    docId: string;
    /** The Work's draft whose draft took the reversal, when it landed in one. */
    draftId?: DraftId;
    sweptContent: boolean;
    beforeContentRef: number | null;
  }): Promise<void>;
}

export function createReversalNoticePort(deps: {
  notices: NoticePort;
  /** A trashed document is named where it last was: its notice lands all the same. */
  resolveLastDocumentUri: (documentId: string, draftId?: DraftId) => Promise<string | null>;
  diagnostics: ReversalNoticeDiagnostics;
}): TurnInverseNoticePort {
  return {
    async record(input) {
      const uri = await deps.resolveLastDocumentUri(input.docId, input.draftId);
      if (!uri) {
        deps.diagnostics.documentUriMissing({
          docId: input.docId,
          threadId: input.threadId,
          representativeTurnId: input.turnId,
        });
        return;
      }
      await deps.notices.record({
        kind: "undo",
        scope: { kind: "thread", threadId: input.threadId },
        message: "",
        data: {
          threadId: input.threadId,
          turnId: input.turnId,
          documentId: input.docId,
          uri,
          sweptContent: input.sweptContent,
          beforeContentRef: input.beforeContentRef,
        },
      });
    },
  };
}
