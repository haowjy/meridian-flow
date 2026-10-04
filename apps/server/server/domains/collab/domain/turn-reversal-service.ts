/** Turn reversal orchestration across live documents and work-draft branches. */
import { parseWriteHandle, type ReversalSelection } from "@meridian/agent-edit/integration";
import type { DocumentReversalResult, ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../file-policy/index.js";
import {
  ReverseThreadContextError,
  type ReverseThreadContextInput,
  type TurnReversalAccess,
} from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchStore } from "./branch-coordinator.js";
import type { BranchJournalReadStore, BranchReviewService } from "./branch-push-contracts.js";
import {
  aggregateStatus,
  documentReversalOutcome,
  documentReversalResult,
  isSuccessfulReversal,
  type ReverseTurnDeps,
  reverseTurn,
} from "./turn-reversal.js";

export type ThreadContextReversalResolver = {
  requireThreadOwner(input: {
    threadId: string;
    userId: string;
  }): Promise<{ projectId: ProjectId }>;
  resolveContextDocument(input: {
    threadId: string;
    userId: string;
    uri: string;
  }): Promise<{ documentId?: string | null; uri: string }>;
};

export type TurnReversalServiceDeps = {
  atomic?<T>(operation: () => Promise<T>): Promise<T>;
  live: Required<Omit<ReverseTurnDeps, "deferUntilCommit">> &
    Pick<ReverseTurnDeps, "deferUntilCommit">;
  agentEdit: Pick<ThreadPeerAgentEditCore, "reverse">;
  branchReview: BranchReviewService;
  branchJournal: Pick<BranchJournalReadStore, "listJournalRowsForTurn">;
  branches: Pick<BranchStore, "getBranch">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listEditedDocumentsForTurn(
    threadId: string,
    turnId: string,
  ): Promise<Array<{ documentId: string }>>;
  /** The writer's edit grant on each document, confirmed by the seams the reversal reaches. */
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** A seam refused a draft write because its Work stopped being active under the seam's lock. */
  isDraftWorkUnavailable(cause: unknown): boolean;
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurnAcrossScopes = async (
    command: Parameters<TurnReversalAccess["reverseTurn"]>[0],
  ): Promise<ReversalOutcome> => {
    const atomic = input.atomic ?? (async <T>(operation: () => Promise<T>) => operation());
    try {
      return await atomic(async () => {
        const statuses =
          command.direction === "undo" ? (["active"] as const) : (["discarded"] as const);
        const rows = await input.branchJournal.listJournalRowsForTurn({
          threadId: command.threadId,
          turnId: command.turnId,
          statuses,
        });
        const allowedDocumentIds = command.documentIds
          ? new Set<string>(command.documentIds)
          : undefined;
        const branches = [];
        for (const branchId of new Set(rows.map((row) => row.branchId))) {
          const branch = await input.branches.getBranch(branchId);
          if (branch && (!allowedDocumentIds || allowedDocumentIds.has(branch.documentId))) {
            branches.push(branch);
          }
        }
        const results = await input.branchReview.reverseBranchTurns({
          branchIds: branches.map((branch) => branch.branchId),
          threadId: command.threadId,
          turnId: command.turnId,
          direction: command.direction,
          reviewedByUserId:
            command.actor.type === "user" ? (command.actor.userId as UserId) : undefined,
        });
        const documentOfBranch = new Map(
          branches.map((branch) => [branch.branchId, branch.documentId]),
        );
        // An archived Work's draft is frozen (D30): that document's whole turn
        // stays as it is, live writes included, and the rest still reverses.
        const frozenDocumentIds = new Set<string>();
        const branchDocuments: Array<ReversalOutcome["documents"][number]> = [];
        for (const result of results) {
          const documentId = documentOfBranch.get(result.branchId) ?? result.branchId;
          if (result.status === "permission_denied") frozenDocumentIds.add(documentId);
          else
            branchDocuments.push({
              uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
              status: result.status,
            });
        }
        const frozenDocuments = await Promise.all(
          [...frozenDocumentIds].map(async (documentId) => ({
            uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
            status: "permission_denied" as const,
          })),
        );
        const branchOutcome = {
          status: aggregateStatus(command.direction, branchDocuments),
          documents: [...branchDocuments, ...frozenDocuments],
        } satisfies ReversalOutcome;
        if (branchOutcome.status === "partial" || branchOutcome.status === "cant_undo_dependent") {
          throw new CrossScopeReversalRefused(branchOutcome);
        }

        // Branch and live durable writes share the ambient transaction. Their
        // process-local projections and broadcasts publish only after commit.
        const liveDocumentIds =
          frozenDocumentIds.size === 0
            ? command.documentIds
            : (
                command.documentIds ??
                (await input.live.reversalStore.documentsForTurn(command.threadId, command.turnId))
              ).filter((documentId) => !frozenDocumentIds.has(documentId));
        const liveOutcome = await reverseTurn(input.live, {
          ...command,
          documentIds: liveDocumentIds,
        });
        const documents = mergeDocumentScopeResults(command.direction, [
          ...liveOutcome.documents,
          ...branchDocuments,
        ]);
        const outcome = {
          status: aggregateStatus(command.direction, documents),
          documents,
        } satisfies ReversalOutcome;
        if (outcome.status === "partial" || outcome.status === "cant_undo_dependent") {
          throw new CrossScopeReversalRefused(outcome);
        }
        if (frozenDocuments.length === 0) return outcome;
        const withFrozen = [...documents, ...frozenDocuments];
        return { status: aggregateStatus(command.direction, withFrozen), documents: withFrozen };
      });
    } catch (cause) {
      if (cause instanceof CrossScopeReversalRefused) return cause.outcome;
      throw cause;
    }
  };

  /**
   * A draft seam found the Work archived under its own lock, after the
   * writer's grant was confirmed: report it as refused, never as a failure.
   */
  const frozenAsRefused = async <T, R>(operation: Promise<T>, refused: () => R): Promise<T | R> => {
    try {
      return await operation;
    } catch (cause) {
      if (input.isDraftWorkUnavailable(cause)) return refused();
      throw cause;
    }
  };

  return {
    reverseTurn: reverseTurnAcrossScopes,

    async reverseThreadContext(command) {
      validateThreadContextSelection(command);
      if (!command.uri) {
        await input.threadContext.requireThreadOwner(command);
        const lineage = await input.listEditedDocumentsForTurn(command.threadId, command.turnId);
        const { grants, refused } = await writerGrants(input.fileAccess, command.userId, [
          ...new Set(lineage.map((entry) => entry.documentId)),
        ]);
        const grantedDocumentIds = grants.map((grant) => documentOf(grant));
        const run =
          grants.length === 0
            ? {
                ok: true as const,
                value: { status: aggregateStatus(command.direction, []), documents: [] },
              }
            : await runWithEditGrants(input.fileAccess, grants, () =>
                frozenAsRefused(
                  reverseTurnAcrossScopes({
                    threadId: command.threadId,
                    turnId: command.turnId,
                    direction: command.direction,
                    actor: { type: "user", userId: command.userId },
                    documentIds: grantedDocumentIds,
                  }),
                  () => null,
                ),
              );
        const deniedDocumentIds = refused.map(denialDocument);
        // A seam refused under its locks (archived meanwhile): nothing was reversed.
        if (!run.ok) deniedDocumentIds.push(...run.refusal.refused.map(denialDocument));
        else if (run.value === null) deniedDocumentIds.push(...grantedDocumentIds);
        const reversed =
          run.ok && run.value !== null
            ? run.value
            : { status: "permission_denied" as const, documents: [] };
        if (deniedDocumentIds.length === 0) return reversed;
        const documents = [
          ...reversed.documents,
          ...(await Promise.all(
            deniedDocumentIds.map(async (documentId) => ({
              uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
              status: "permission_denied" as const,
            })),
          )),
        ];
        return { status: aggregateStatus(command.direction, documents), documents };
      }

      const selection = reversalSelection(command);
      const document = await input.threadContext.resolveContextDocument({
        threadId: command.threadId,
        userId: command.userId,
        uri: command.uri,
      });
      if (!document.documentId) {
        throw new ReverseThreadContextError("document_not_found", "Document not found");
      }
      const documentId = document.documentId;
      const { grants, refused } = await writerGrants(input.fileAccess, command.userId, [
        documentId,
      ]);
      if (grants.length === 0) {
        if (refused.length === 0) {
          throw new ReverseThreadContextError("document_not_found", "Document not found");
        }
        const documents = [{ uri: document.uri, status: "permission_denied" as const }];
        return { status: aggregateStatus(command.direction, documents), documents };
      }
      const run = await runWithEditGrants(input.fileAccess, grants, () =>
        frozenAsRefused(
          input.agentEdit.reverse({
            docId: documentId,
            threadId: command.threadId,
            direction: command.direction,
            selection,
            actor: { type: "user", userId: command.userId },
          }),
          () => null,
        ),
      );
      if (!run.ok || run.value === null) {
        const documents = [{ uri: document.uri, status: "permission_denied" as const }];
        return { status: aggregateStatus(command.direction, documents), documents };
      }
      const outcome = run.value;
      if (isSuccessfulReversal(outcome)) {
        await input.live.refreshDocumentProjection({
          documentId: documentId as DocumentId,
          threadId: command.threadId,
        });
      }
      const documents = [
        await documentReversalResult({
          documentId,
          outcome: documentReversalOutcome(outcome),
          resolveDocumentUri: async () => document.uri,
        }),
      ];
      return { status: aggregateStatus(command.direction, documents), documents };
    },
  };
}

/**
 * The writer's edit grant on each document a reversal would change. A file
 * the writer can't see is left out, as before; one they can't edit (its Work
 * is archived) is reported as refused.
 */
async function writerGrants(
  fileAccess: Pick<FileAccess, "authorize">,
  userId: string,
  documentIds: readonly string[],
): Promise<{ grants: FileGrant<"edit">[]; refused: FileAccessDenied[] }> {
  const grants: FileGrant<"edit">[] = [];
  const refused: FileAccessDenied[] = [];
  for (const documentId of documentIds) {
    const grant = await fileAccess.authorize(
      { accountId: userId as UserId },
      { kind: "document", documentId: documentId as DocumentId },
      "edit",
    );
    if (!isFileAccessDenied(grant)) grants.push(grant);
    else if (grant.reason !== "not_found") refused.push(grant);
  }
  return { grants, refused };
}

function documentOf(grant: FileGrant): DocumentId {
  if (grant.target.kind === "container") throw new Error("A reversal grant names a document");
  return grant.target.documentId;
}

function denialDocument(denial: FileAccessDenied): DocumentId {
  if (denial.target.kind === "container") throw new Error("A reversal denial names a document");
  return denial.target.documentId;
}

class CrossScopeReversalRefused extends Error {
  constructor(readonly outcome: ReversalOutcome) {
    super(`Cross-scope reversal refused with status ${outcome.status}`);
    this.name = "CrossScopeReversalRefused";
  }
}

function validateThreadContextSelection(input: ReverseThreadContextInput): void {
  if (input.scope === "write" && !input.uri) {
    throw new ReverseThreadContextError("invalid_scope", "uri required for write scope");
  }
  if (input.scope === "thread" && !input.uri) {
    throw new ReverseThreadContextError("invalid_scope", "uri required for thread scope");
  }
  if (input.scope === "turn" && !input.selection) {
    throw new ReverseThreadContextError("invalid_scope", "target is required for turn scope");
  }
  if (input.scope === "thread" && input.selection !== undefined) {
    throw new ReverseThreadContextError("invalid_scope", "thread scope does not accept target");
  }
}

function reversalSelection(input: ReverseThreadContextInput): ReversalSelection {
  if (input.scope === "write") {
    if (input.selection === undefined) return { kind: "latest" };
    if (parseWriteHandle(input.selection) === undefined) {
      throw new ReverseThreadContextError("invalid_write", "invalid_write");
    }
    return { kind: "single", to: input.selection };
  }
  if (input.scope === "turn") return { kind: "turn", turnId: input.selection ?? "" };
  return { kind: "all" };
}

function mergeDocumentScopeResults(
  direction: "undo" | "redo",
  documents: readonly DocumentReversalResult[],
): DocumentReversalResult[] {
  const grouped = new Map<string, DocumentReversalResult[]>();
  for (const document of documents) {
    const group = grouped.get(document.uri) ?? [];
    group.push(document);
    grouped.set(document.uri, group);
  }
  return [...grouped.entries()].map(([uri, results]) => {
    const status = aggregateSameDocumentScopeStatus(direction, results);
    const text = results.find((result) => result.text)?.text;
    return { uri, status, ...(text ? { text } : {}) };
  });
}

function aggregateSameDocumentScopeStatus(
  direction: "undo" | "redo",
  results: readonly DocumentReversalResult[],
): DocumentReversalResult["status"] {
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const statuses = results.map((result) => result.status);
  if (
    statuses.every(
      (status) => status === "reversed" || status === "reconciled" || status === noOp,
    ) &&
    statuses.some((status) => status === "reversed" || status === "reconciled")
  ) {
    return statuses.includes("reconciled") ? "reconciled" : "reversed";
  }
  return aggregateStatus(direction, results);
}
