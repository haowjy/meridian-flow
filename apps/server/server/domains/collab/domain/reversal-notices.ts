import type { DraftId } from "@meridian/contracts";
import type { NoticePort } from "../../notices/index.js";

export type ReversalNoticeDiagnostics = {
  documentUriMissing(input: {
    docId: string;
    threadId: string;
    representativeTurnId?: string | null;
  }): void;
};

export interface TurnInverseNoticePort {
  record(input: {
    threadId: string;
    turnId: string;
    docId: string;
    draftId?: DraftId;
    sweptContent: boolean;
    beforeContentRef: number | null;
  }): Promise<void>;
}

export function createReversalNoticePort(deps: {
  notices: NoticePort;
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
