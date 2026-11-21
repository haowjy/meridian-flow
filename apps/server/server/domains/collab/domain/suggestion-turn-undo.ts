/**
 * The card's Undo of a turn whose edits are still suggestions rejects them, as a
 * client of the document would, under the Live edit grant the Live inverse asks the presser for.
 * Text the writer typed beside them is untouched. The documents where the turn left no suggestion
 * (it wrote Live there, or they were applied or discarded) go to the Live inverse. The card offers
 * Undo while any of the turn's documents still holds its suggestions, whatever the writer edited
 * since.
 */
import { resolveStored, storedPendingTurns } from "@meridian/agent-edit/integration";
import type { ReversalOutcome, TurnReceiptChip } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Schema } from "prosemirror-model";
import type * as Y from "yjs";
import {
  type FileAccess,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../file-policy/index.js";
import type { DocumentWriteOrigin, HeldLiveDocument } from "../contracts.js";
import type { TurnInverseQuery } from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { actor: { type: "user"; userId: string } | { type: "agent" } };

export function createSuggestionTurnUndo(deps: {
  schema: Schema;
  listTurnDocuments(
    threadId: ThreadId,
    turnId: TurnId,
  ): Promise<readonly { documentId: DocumentId }[]>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  changeLiveDocument(input: {
    documentId: DocumentId;
    origin: DocumentWriteOrigin;
    mutate(doc: Y.Doc): void;
  }): Promise<void>;
  reverseLiveTurn(query: Query): Promise<ReversalOutcome>;
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  /** Confirms the bound grants under their Works' locks, before any list or document key. */
  confirmGrants(): Promise<void>;
  /** The seam a Live write enters first: the grants' Works, their confirmation, the document's lock. */
  enterLiveSeam(documentId: DocumentId): Promise<void>;
  withLiveDocument<T>(
    documentId: string,
    operation: (held: HeldLiveDocument) => Promise<T>,
  ): Promise<T>;
  liveTurnChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
}) {
  const holds = (documentId: DocumentId, turn: TurnId) =>
    deps.withLiveDocument(documentId, async ({ doc }) =>
      storedPendingTurns(doc, deps.schema).has(turn),
    );

  async function documentsOf(threadId: ThreadId, turn: TurnId): Promise<DocumentId[]> {
    const targets = await deps.listTurnDocuments(threadId, turn);
    return [...new Set(targets.map((target) => target.documentId))];
  }

  async function chip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null> {
    const live = await deps.liveTurnChip(threadId, turnId);
    if (live?.control === "undo") return live;
    // Every card of a long thread asks after each pause in typing: one read per document state.
    for (const documentId of await documentsOf(threadId, turnId))
      if (await holds(documentId, turnId)) return { drafts: live?.drafts, control: "undo" };
    return live;
  }

  const reverseTurn = async (query: Query): Promise<ReversalOutcome> => {
    const turn = query.turnId;
    if (!turn) return { status: "nothing_to_undo", documents: [] };
    const documentIds = await documentsOf(query.threadId, turn);
    const pending: DocumentId[] = [];
    for (const documentId of documentIds)
      if (await holds(documentId, turn)) pending.push(documentId);
    if (pending.length === 0) return deps.reverseLiveTurn(query);
    pending.sort();
    // Rejecting edits Live: the presser needs the Live edit grant the Live inverse asks for,
    // confirmed under the seam's locks as every Live write's is.
    const principal =
      query.principal ??
      (query.actor.type === "user" ? { accountId: query.actor.userId } : undefined);
    if (!principal) throw new Error("A card Undo names who pressed it");
    const grants: FileGrant<"edit">[] = [];
    for (const documentId of pending) {
      const grant = await deps.fileAccess.authorizeAt(
        principal,
        { kind: "document", documentId },
        { kind: "live" },
        "edit",
      );
      if (isFileAccessDenied(grant)) throw new FileEditRefusedError([grant]);
      grants.push(grant);
    }
    const origin: DocumentWriteOrigin =
      query.actor.type === "user"
        ? { type: "user", actorUserId: query.actor.userId as UserId }
        : { type: "agent", actorTurnId: turn };
    const rest = documentIds.filter((documentId) => !pending.includes(documentId));
    const confirmed = await runWithEditGrants(deps.fileAccess, grants, async () => {
      // Confirmed before anything is written, so a refusal leaves the whole press undone.
      await deps.confirmGrants();
      // The Live inverse first, for the other documents and the reply's tree changes: its commit
      // takes the tree list keys and then every document key, these included, in one order, and
      // the rejects below run under them.
      const live = await deps.reverseLiveTurn({ ...query, documentIds: rest, alsoLock: pending });
      const rejected: DocumentId[] = [];
      for (const documentId of pending) {
        await deps.enterLiveSeam(documentId);
        let changed = false;
        await deps.changeLiveDocument({
          documentId,
          origin,
          mutate: (doc) => {
            changed = resolveStored(doc, deps.schema, "reject", { turn }).size > 0;
          },
        });
        if (changed) rejected.push(documentId);
      }
      return { live, rejected };
    });
    if (!confirmed.ok) throw confirmed.refusal;
    const { live, rejected } = confirmed.value;
    const documents = await Promise.all(
      rejected.map(async (documentId) => ({
        documentId,
        uri: (await deps.resolveDocumentUri(documentId)) ?? documentId,
        destination: { kind: "live" as const },
        status: "reversed" as const,
      })),
    );
    if (!documents.length) return live;
    return { ...live, status: "reversed", documents: [...live.documents, ...documents] };
  };
  return { reverseTurn, chip };
}
