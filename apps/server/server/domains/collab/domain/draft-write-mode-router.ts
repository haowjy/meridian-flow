/** Routes response-scoped agent edits between live writes and draft review sessions. */
import type { AgentEditCore } from "@meridian/agent-edit";
import type {
  DocumentId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import {
  isDraftClosedForAppendError,
  isDraftUnderReviewForAppendError,
} from "../adapters/drizzle-draft-agent-edit.js";
import type {
  ResponseWriteCommitFinalizeResult,
  ResponseWriteRollbackFinalizeResult,
  WriteMode,
} from "../index.js";

export type ThreadModeRepository = {
  findById(
    id: ThreadId,
  ): Promise<{ userId: UserId; projectId: ProjectId; aiWriteMode: WriteMode } | null>;
};

type ResponseSession = {
  mode: WriteMode;
  core: AgentEditCore;
  threadId: ThreadId;
  documentIds: Set<DocumentId>;
  capturedEpochs: Map<DocumentId, number>;
  stale?: boolean;
  underReview?: boolean;
  workId: WorkId | null;
};

type PendingResponseSession = {
  threadId: ThreadId;
  documentIds: Set<DocumentId>;
  capturedEpochs: Map<DocumentId, number>;
  promise: Promise<ResponseSession>;
  stale?: boolean;
  underReview?: boolean;
  workId?: WorkId | null;
};

type ResponseSessionEntry = ResponseSession | PendingResponseSession;

type DraftUnderReviewCommitResult = {
  responseId: string;
  status: "draft_under_review";
  mode: "draft";
  documentCount: 0;
  updateCount: 0;
  documents: [];
  stagedCreates: { committed: []; discarded: [] };
};

type DraftClosedCommitResult = {
  responseId: string;
  status: "draft_closed";
  mode: "draft";
  documentCount: 0;
  updateCount: 0;
  documents: [];
  stagedCreates: { committed: []; discarded: [] };
};

type ResponseSessionRegistry = {
  sessionMode(responseId: string): WriteMode | undefined;
  coreFor(responseId: string, threadId: ThreadId): Promise<ResponseSession>;
  trackDocument(responseId: string, threadId: ThreadId, documentId: DocumentId): void;
  isDraftClosed(responseId: string): boolean;
  isDraftUnderReview(responseId: string, documentId: DocumentId): Promise<boolean>;
  markDraftUnderReview(responseId: string): void;
  commitResponse(responseId: string): Promise<Awaited<ReturnType<AgentEditCore["commitResponse"]>>>;
  rollbackResponse(
    responseId: string,
  ): Promise<Awaited<ReturnType<AgentEditCore["rollbackResponse"]>>>;
  invalidateDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
};

export type DraftWriteModeRouterDeps = {
  liveUtilityCore: AgentEditCore;
  createDraftCore(input: { threadId: ThreadId }): AgentEditCore;
  resolveThreadWorkId(threadId: ThreadId): Promise<WorkId | null>;
  threads: ThreadModeRepository;
  refreshLiveProjection(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  isDraftUnderReview?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<boolean>;
};

export type DraftWriteModeRouter = {
  agentEditCore: AgentEditCore;
  resolveThreadWriteMode(threadId: ThreadId): Promise<WriteMode>;
  invalidateDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  finalizeResponseCommit(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteCommitFinalizeResult>;
  finalizeResponseRollback(responseId: string): Promise<ResponseWriteRollbackFinalizeResult>;
};

export function createDraftWriteModeRouter(deps: DraftWriteModeRouterDeps): DraftWriteModeRouter {
  const responseRegistry = createResponseSessionRegistry({
    liveUtilityCore: deps.liveUtilityCore,
    createDraftCore: deps.createDraftCore,
    resolveMode: (threadId) => resolveThreadWriteMode(deps, threadId),
    resolveThreadWorkId: deps.resolveThreadWorkId,
    isDraftUnderReview: deps.isDraftUnderReview,
  });
  const agentEditCore = createAgentEditProxy({
    liveUtilityCore: deps.liveUtilityCore,
    registry: responseRegistry,
  });

  return {
    agentEditCore,
    resolveThreadWriteMode: (threadId) => resolveThreadWriteMode(deps, threadId),
    invalidateDraft: responseRegistry.invalidateDraft,
    finalizeResponseCommit,
    finalizeResponseRollback,
  };

  async function finalizeResponseCommit(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteCommitFinalizeResult> {
    const mode = responseRegistry.sessionMode(responseId) ?? "direct";
    const result = await agentEditCore.commitResponse(responseId);
    if ("status" in result && result.status === "draft_under_review") {
      return {
        status: "draft_under_review",
        responseId,
        mode: "draft",
        documents: [],
        stagedCreates: { committed: [], discarded: [] },
      };
    }
    if ("status" in result && result.status === "draft_closed") {
      return {
        status: "draft_closed",
        responseId,
        mode: "draft",
        documents: [],
        stagedCreates: { committed: [], discarded: [] },
      };
    }
    if (mode === "draft") {
      return {
        status: "committed",
        documents: result.documents.map((document) => ({
          documentId: document.documentId as DocumentId,
          updateCount: document.updateCount,
        })),
        stagedCreates: {
          committed: [],
          discarded: result.stagedCreates.discarded as DocumentId[],
        },
      };
    }
    await Promise.all(
      result.documents.map((document) =>
        deps.refreshLiveProjection({
          documentId: document.documentId as DocumentId,
          threadId: ctx.threadId,
        }),
      ),
    );
    return {
      documents: result.documents.map((document) => ({
        documentId: document.documentId as DocumentId,
        updateCount: document.updateCount,
        ...(document.concurrentEdits ? { concurrentEdits: document.concurrentEdits } : {}),
      })),
      stagedCreates: {
        committed: result.stagedCreates.committed as DocumentId[],
        discarded: result.stagedCreates.discarded as DocumentId[],
      },
    };
  }

  async function finalizeResponseRollback(
    responseId: string,
  ): Promise<ResponseWriteRollbackFinalizeResult> {
    const result = await agentEditCore.rollbackResponse(responseId);
    return {
      stagedCreates: {
        committed: result.stagedCreates.committed as DocumentId[],
        discarded: result.stagedCreates.discarded as DocumentId[],
      },
    };
  }
}

function createResponseSessionRegistry(deps: {
  liveUtilityCore: AgentEditCore;
  createDraftCore(input: { threadId: ThreadId }): AgentEditCore;
  resolveMode(threadId: ThreadId): Promise<WriteMode>;
  resolveThreadWorkId(threadId: ThreadId): Promise<WorkId | null>;
  isDraftUnderReview?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<boolean>;
}): ResponseSessionRegistry {
  const sessions = new Map<string, ResponseSessionEntry>();
  const invalidationEpochs = new Map<string, number>();

  return {
    sessionMode(responseId) {
      const session = sessions.get(responseId);
      return session && "mode" in session ? session.mode : undefined;
    },

    async coreFor(responseId, threadId) {
      const existing = sessions.get(responseId);
      if (existing) return "promise" in existing ? existing.promise : existing;

      const pending: PendingResponseSession = {
        threadId,
        documentIds: new Set(),
        capturedEpochs: new Map(),
        promise: Promise.resolve().then(async () => {
          const [mode, workId] = await Promise.all([
            deps.resolveMode(threadId),
            deps.resolveThreadWorkId(threadId),
          ]);
          recaptureEpochsForWork(workId, pending.documentIds, pending.capturedEpochs);
          const resolved: ResponseSession = {
            mode,
            core: mode === "draft" ? deps.createDraftCore({ threadId }) : deps.liveUtilityCore,
            threadId,
            documentIds: pending.documentIds,
            capturedEpochs: pending.capturedEpochs,
            stale: pending.stale,
            underReview: pending.underReview,
            workId,
          };
          sessions.set(responseId, resolved);
          return resolved;
        }),
      };
      sessions.set(responseId, pending);
      return pending.promise;
    },

    trackDocument(responseId, threadId, documentId) {
      const existing = sessions.get(responseId);
      const entry: ResponseSessionEntry =
        existing ??
        ({
          threadId,
          documentIds: new Set(),
          capturedEpochs: new Map(),
          promise: Promise.resolve().then(async () => {
            const [mode, workId] = await Promise.all([
              deps.resolveMode(threadId),
              deps.resolveThreadWorkId(threadId),
            ]);
            const current = sessions.get(responseId);
            const base = current && "promise" in current ? current : entry;
            recaptureEpochsForWork(workId, base.documentIds, base.capturedEpochs);
            const resolved: ResponseSession = {
              mode,
              core: mode === "draft" ? deps.createDraftCore({ threadId }) : deps.liveUtilityCore,
              threadId,
              documentIds: base.documentIds,
              capturedEpochs: base.capturedEpochs,
              stale: base.stale,
              underReview: base.underReview,
              workId,
            };
            sessions.set(responseId, resolved);
            return resolved;
          }),
        } satisfies PendingResponseSession);
      entry.documentIds.add(documentId);
      if (!entry.capturedEpochs.has(documentId)) {
        entry.capturedEpochs.set(documentId, currentEpoch(threadId, documentId));
      }
      if (!existing) sessions.set(responseId, entry);
    },

    isDraftClosed(responseId) {
      const entry = sessions.get(responseId);
      if (!entry || !("mode" in entry) || entry.mode !== "draft") return false;
      return shouldCloseDraftSession(entry);
    },

    async isDraftUnderReview(responseId, documentId) {
      const entry = sessions.get(responseId);
      const session = entry && "promise" in entry ? await entry.promise : entry;
      if (session?.mode !== "draft") return false;
      return deps.isDraftUnderReview?.({ documentId, threadId: session.threadId }) ?? false;
    },

    markDraftUnderReview(responseId) {
      const entry = sessions.get(responseId);
      if (entry) entry.underReview = true;
    },

    async commitResponse(responseId) {
      const entry = sessions.get(responseId);
      const session = entry && "promise" in entry ? await entry.promise : entry;
      if (!session) return deps.liveUtilityCore.commitResponse(responseId);
      try {
        if (session.mode === "draft" && session.underReview === true) {
          await session.core.rollbackResponse(responseId);
          return draftUnderReviewCommitResult(responseId);
        }
        if (shouldCloseDraftSession(session)) {
          await session.core.rollbackResponse(responseId);
          return draftClosedCommitResult(responseId);
        }
        try {
          return await session.core.commitResponse(responseId);
        } catch (cause) {
          if (session.mode !== "draft") throw cause;
          if (isDraftUnderReviewForAppendError(cause)) {
            await session.core.rollbackResponse(responseId);
            return draftUnderReviewCommitResult(responseId);
          }
          if (!isDraftClosedForAppendError(cause)) throw cause;
          await session.core.rollbackResponse(responseId);
          return draftClosedCommitResult(responseId);
        }
      } finally {
        sessions.delete(responseId);
      }
    },

    async rollbackResponse(responseId) {
      const entry = sessions.get(responseId);
      const session = entry && "promise" in entry ? await entry.promise : entry;
      try {
        return await (session?.core ?? deps.liveUtilityCore).rollbackResponse(responseId);
      } finally {
        sessions.delete(responseId);
      }
    },

    async invalidateDraft({ documentId, threadId }) {
      const workId = await deps.resolveThreadWorkId(threadId);
      const keyOwner = workId ?? threadId;
      invalidationEpochs.set(
        epochKey(keyOwner, documentId),
        currentEpoch(keyOwner, documentId) + 1,
      );
      for (const session of sessions.values()) {
        const sessionWorkId =
          session.workId !== undefined
            ? session.workId
            : await deps.resolveThreadWorkId(session.threadId);
        if (session.threadId === threadId || sessionWorkId === workId) session.stale = true;
      }
    },
  };

  function shouldCloseDraftSession(session: ResponseSession): boolean {
    return session.mode === "draft" && (session.stale === true || hasAdvancedEpoch(session));
  }

  function hasAdvancedEpoch(session: ResponseSession): boolean {
    for (const documentId of session.documentIds) {
      if (
        currentEpoch(session.workId ?? session.threadId, documentId) >
        (session.capturedEpochs.get(documentId) ?? 0)
      ) {
        return true;
      }
    }
    return false;
  }

  function recaptureEpochsForWork(
    workId: WorkId | null,
    documentIds: ReadonlySet<DocumentId>,
    capturedEpochs: Map<DocumentId, number>,
  ): void {
    if (!workId) return;
    for (const documentId of documentIds) {
      capturedEpochs.set(documentId, currentEpoch(workId, documentId));
    }
  }

  function currentEpoch(ownerId: ThreadId | WorkId, documentId: DocumentId): number {
    return invalidationEpochs.get(epochKey(ownerId, documentId)) ?? 0;
  }

  function epochKey(ownerId: ThreadId | WorkId, documentId: DocumentId): string {
    return `${ownerId}:${documentId}`;
  }
}

function createAgentEditProxy(deps: {
  liveUtilityCore: AgentEditCore;
  registry: ResponseSessionRegistry;
}): AgentEditCore {
  return {
    async write(command, context) {
      const responseId = context?.responseId;
      if (!responseId) return deps.liveUtilityCore.write(command, context);
      const threadId = context.threadId as ThreadId | undefined;
      if (!threadId) return deps.liveUtilityCore.write(command, context);
      if ("documentId" in command && command.documentId) {
        deps.registry.trackDocument(responseId, threadId, command.documentId as DocumentId);
      }
      const session = await deps.registry.coreFor(responseId, threadId);
      if (deps.registry.isDraftClosed(responseId)) {
        await session.core.rollbackResponse(responseId);
        return {
          command: command.command,
          status: "internal_error",
          isError: true,
          text: "Draft review was closed before this response could write. Stop writing and wait for the next turn.",
        } as Awaited<ReturnType<AgentEditCore["write"]>>;
      }
      if (isMutatingDraftWrite(command) && "documentId" in command && command.documentId) {
        const underReview = await deps.registry.isDraftUnderReview(
          responseId,
          command.documentId as DocumentId,
        );
        if (underReview) {
          deps.registry.markDraftUnderReview(responseId);
          await session.core.rollbackResponse(responseId);
          return draftUnderReviewWriteResult(command.command) as Awaited<
            ReturnType<AgentEditCore["write"]>
          >;
        }
      }
      return session.core.write(command, context);
    },
    recover: deps.liveUtilityCore.recover,
    commitResponse: deps.registry.commitResponse,
    rollbackResponse: deps.registry.rollbackResponse,
    getAvailability: deps.liveUtilityCore.getAvailability,
    undo: deps.liveUtilityCore.undo,
    redo: deps.liveUtilityCore.redo,
    reverse: deps.liveUtilityCore.reverse,
    undoTurn: deps.liveUtilityCore.undoTurn,
    redoTurn: deps.liveUtilityCore.redoTurn,
    invalidateThread: deps.liveUtilityCore.invalidateThread,
  };
}

async function resolveThreadWriteMode(
  deps: Pick<DraftWriteModeRouterDeps, "threads">,
  threadId: ThreadId,
): Promise<WriteMode> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return "direct";
  return thread.aiWriteMode;
}

function draftClosedCommitResult(responseId: string): DraftClosedCommitResult {
  return {
    responseId,
    status: "draft_closed",
    mode: "draft",
    documentCount: 0,
    updateCount: 0,
    documents: [],
    stagedCreates: { committed: [], discarded: [] },
  };
}

function draftUnderReviewCommitResult(responseId: string): DraftUnderReviewCommitResult {
  return {
    responseId,
    status: "draft_under_review",
    mode: "draft",
    documentCount: 0,
    updateCount: 0,
    documents: [],
    stagedCreates: { committed: [], discarded: [] },
  };
}

function isMutatingDraftWrite(command: { command: string }): boolean {
  return (
    command.command === "insert" || command.command === "replace" || command.command === "create"
  );
}

function draftUnderReviewWriteResult(command: string) {
  return {
    command,
    status: "draft_under_review",
    isError: true,
    text: "status: draft_under_review\n\nThe writer is reviewing this draft. Do not write to it right now; wait for review to finish or address the writer in chat.",
  };
}
