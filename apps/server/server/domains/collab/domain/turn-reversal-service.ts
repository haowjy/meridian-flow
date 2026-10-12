/** Turn reversal orchestration across live documents and work-draft branches. */
import { parseWriteHandle, type ReversalSelection } from "@meridian/agent-edit/integration";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
  targetDocumentId,
} from "../../file-policy/index.js";
import {
  ReverseThreadContextError,
  type ReverseThreadContextInput,
  type TurnReversalAccess,
} from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import {
  aggregateStatus,
  documentReversalOutcome,
  documentReversalResult,
  isSuccessfulReversal,
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
  live: {
    refreshDocumentProjection(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  };
  agentEdit: Pick<ThreadPeerAgentEditCore, "reverse">;
  turnInverse: Pick<import("./turn-inverse-service.js").TurnInverseService, "reverseTurn">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listEditedDocumentsForTurn(
    threadId: string,
    turnId: string,
  ): Promise<Array<{ documentId: string }>>;
  /** The writer's edit grant on each document, confirmed by the seams the reversal reaches. */
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurnAcrossScopes = input.turnInverse.reverseTurn;

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
        const denied = refused.map((denial) => targetDocumentId(denial.target));
        let reversed: ReversalOutcome = {
          status: aggregateStatus(command.direction, []),
          documents: [],
        };
        if (grants.length > 0) {
          const run = await runWithEditGrants(input.fileAccess, grants, () =>
            reverseTurnAcrossScopes({
              threadId: command.threadId,
              turnId: command.turnId,
              direction: command.direction,
              actor: { type: "user", userId: command.userId },
              documentIds: grants.map((grant) => targetDocumentId(grant.facts.target)),
            }),
          );
          // A seam refused under its locks (archived meanwhile): nothing was reversed.
          if (run.ok) reversed = run.value;
          else {
            denied.push(...run.refusal.refused.map((denial) => targetDocumentId(denial.target)));
            reversed = { status: "permission_denied", documents: [] };
          }
        }
        if (denied.length === 0) return reversed;
        const documents = [
          ...reversed.documents,
          ...(await Promise.all(
            denied.map(async (documentId) => ({
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
        input.agentEdit.reverse({
          docId: documentId,
          threadId: command.threadId,
          direction: command.direction,
          selection,
          actor: { type: "user", userId: command.userId },
        }),
      );
      if (!run.ok) {
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
