/** Notice construction for reversal and post-durability writer-awareness events. */
import type { DestructiveSweepReport, ReversalNoticePort } from "@meridian/agent-edit/integration";
import type { DocumentUriResolver } from "../../context/document-uri-resolver.js";
import type { NoticePort } from "../../notices/index.js";

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
    affectedBlockHashes?: readonly string[];
    cause: unknown;
  }): void;
  degradedRecordFailedAfterDurability(input: {
    threadId: string;
    documentIds: readonly string[];
    responseId?: string;
    cause: unknown;
  }): void;
};

export function documentTitleFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const segment = uri.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  return segment.replace(/\.[^.]+$/, "");
}

export function createDocumentPresentationResolver(resolveDocumentUri: DocumentUriResolver) {
  return {
    resolveUri: resolveDocumentUri,
    async resolveTitle(documentId: string): Promise<string | null> {
      return documentTitleFromUri(await resolveDocumentUri(documentId));
    },
    async resolveTitleOrUntitled(documentId: string): Promise<string> {
      return documentTitleFromUri(await resolveDocumentUri(documentId)) ?? "Untitled document";
    },
  };
}

export async function recordLateSweepNotice(input: {
  notices: NoticePort;
  resolveDocumentUri: DocumentUriResolver;
  threadId: string;
  documentId: string;
  lateSweep: DestructiveSweepReport;
}): Promise<void> {
  const uri = await input.resolveDocumentUri(input.documentId);
  await input.notices.record({
    kind: "late_sweep",
    scope: { kind: "thread", threadId: input.threadId },
    message: "Content was modified — View change",
    data: {
      documentId: input.documentId,
      documentName: documentTitleFromUri(uri) ?? input.documentId,
      uri,
      affectedBlockHashes: input.lateSweep.affectedBlockHashes,
      capturedDeletedBodies: input.lateSweep.capturedDeletedBodies ?? [],
      beforeContentRef: input.lateSweep.beforeContentRef,
    },
    writerVisible: true,
  });
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
      "Your changes are committed, but concurrent writer content could not be verified. Re-read to confirm current state.",
    data: { documentIds: [...input.documentIds], documentNames },
    writerVisible: false,
  });
}

export async function recordNoticeAfterDurability(
  input: {
    notices: NoticePort;
    diagnostics: ReversalNoticeDiagnostics;
    threadId: string;
    documentIds: readonly string[];
    kind: string;
    responseId?: string;
    affectedBlockHashes?: readonly string[];
    recordDegraded?: () => Promise<void>;
  },
  record: () => Promise<void>,
): Promise<void> {
  try {
    await record();
  } catch (cause) {
    input.diagnostics.recordFailedAfterDurability({ ...input, cause });
    try {
      await input.recordDegraded?.();
    } catch (degradedCause) {
      input.diagnostics.degradedRecordFailedAfterDurability({
        threadId: input.threadId,
        documentIds: input.documentIds,
        responseId: input.responseId,
        cause: degradedCause,
      });
    }
  }
}

export type PostDurabilityNoticeService = {
  recordAwarenessDegraded(input: {
    threadId: string;
    responseId: string;
    documentIds: readonly string[];
  }): Promise<void>;
  recordLateSweep(input: {
    threadId: string;
    responseId: string;
    documentId: string;
    lateSweep: DestructiveSweepReport;
  }): Promise<void>;
};

export function createPostDurabilityNoticeService(deps: {
  notices: NoticePort;
  documentUriResolver: DocumentUriResolver;
  diagnostics: ReversalNoticeDiagnostics;
}): PostDurabilityNoticeService {
  return {
    recordAwarenessDegraded(input) {
      return recordNoticeAfterDurability(
        {
          notices: deps.notices,
          diagnostics: deps.diagnostics,
          threadId: input.threadId,
          documentIds: input.documentIds,
          kind: "awareness_degraded",
          responseId: input.responseId,
        },
        () =>
          recordAwarenessDegradedNotice({
            notices: deps.notices,
            resolveDocumentUri: deps.documentUriResolver,
            threadId: input.threadId,
            documentIds: input.documentIds,
          }),
      );
    },
    recordLateSweep(input) {
      return recordNoticeAfterDurability(
        {
          notices: deps.notices,
          diagnostics: deps.diagnostics,
          threadId: input.threadId,
          documentIds: [input.documentId],
          kind: "late_sweep",
          responseId: input.responseId,
          affectedBlockHashes: input.lateSweep.affectedBlockHashes,
          recordDegraded: () =>
            recordAwarenessDegradedNotice({
              notices: deps.notices,
              resolveDocumentUri: deps.documentUriResolver,
              threadId: input.threadId,
              documentIds: [input.documentId],
            }),
        },
        () =>
          recordLateSweepNotice({
            notices: deps.notices,
            resolveDocumentUri: deps.documentUriResolver,
            threadId: input.threadId,
            documentId: input.documentId,
            lateSweep: input.lateSweep,
          }),
      );
    },
  };
}

export function createReversalNoticePort(deps: {
  notices: NoticePort;
  documentUriResolver: DocumentUriResolver;
  diagnostics: ReversalNoticeDiagnostics;
}): ReversalNoticePort {
  return {
    async record(input) {
      const uri = await deps.documentUriResolver(input.docId);
      if (!uri) {
        deps.diagnostics.documentUriMissing({
          docId: input.docId,
          threadId: input.threadId,
          representativeTurnId: input.writeHandleTurns[0]?.turnId,
        });
        return;
      }
      const writeHandleTurns = input.writeHandleTurns.filter(
        (entry): entry is { writeHandle: string; turnId: string } => entry.turnId !== null,
      );
      if (writeHandleTurns.length === 0) return;
      await deps.notices.record({
        kind: "undo",
        scope: { kind: "thread", threadId: input.threadId },
        message: "",
        data: {
          threadId: input.threadId,
          writeHandles: input.writeHandles,
          writeHandleTurns,
          documentId: input.docId,
          uri,
          direction: input.direction,
          sweptContent: input.sweptContent,
          beforeContentRef: input.beforeContentRef,
        },
        writerVisible: false,
      });
    },
    async recordLateSweep(input) {
      await recordLateSweepNotice({
        notices: deps.notices,
        resolveDocumentUri: deps.documentUriResolver,
        threadId: input.threadId,
        documentId: input.docId,
        lateSweep: input.report,
      });
    },
  };
}
