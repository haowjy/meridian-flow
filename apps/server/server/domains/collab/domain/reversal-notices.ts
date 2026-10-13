/** Notice construction for reversal and post-durability writer-awareness events. */
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
  recordFailedAfterDurability(input: {
    kind: string;
    threadId: string;
    documentIds: readonly string[];
    responseId?: string;
    cause: unknown;
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
    message:
      "Your changes are committed, but concurrent user content could not be verified. Re-read to confirm current state.",
    data: { documentIds: [...input.documentIds], documentNames },
  });
}

export type PostDurabilityNoticeService = {
  recordAwarenessDegraded(input: {
    threadId: string;
    responseId: string;
    documentIds: readonly string[];
  }): Promise<void>;
};

export function createPostDurabilityNoticeService(deps: {
  notices: NoticePort;
  documentUriResolver: DocumentUriResolver;
  diagnostics: ReversalNoticeDiagnostics;
}): PostDurabilityNoticeService {
  return {
    async recordAwarenessDegraded(input) {
      try {
        await recordAwarenessDegradedNotice({
          notices: deps.notices,
          resolveDocumentUri: deps.documentUriResolver,
          threadId: input.threadId,
          documentIds: input.documentIds,
        });
      } catch (cause) {
        deps.diagnostics.recordFailedAfterDurability({
          kind: "awareness_degraded",
          ...input,
          cause,
        });
      }
    },
  };
}

export interface TurnInverseNoticePort {
  record(input: {
    threadId: string;
    turnId: string;
    docId: string;
    direction: "undo" | "redo";
    sweptContent: boolean;
    beforeContentRef: number | null;
  }): Promise<void>;
}

export function createReversalNoticePort(deps: {
  notices: NoticePort;
  documentUriResolver: DocumentUriResolver;
  diagnostics: ReversalNoticeDiagnostics;
}): TurnInverseNoticePort {
  return {
    async record(input) {
      const uri = await deps.documentUriResolver(input.docId);
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
          direction: input.direction,
          sweptContent: input.sweptContent,
          beforeContentRef: input.beforeContentRef,
        },
      });
    },
  };
}
