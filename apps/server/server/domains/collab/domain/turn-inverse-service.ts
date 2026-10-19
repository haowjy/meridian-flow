/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import {
  type ComputedInverse,
  type InversePart,
  type InverseSelection,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import type { DocumentId, EditOrigin, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type {
  DocumentRemovalRecord,
  ReversalOutcome,
  TurnInverseSkip,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { PartDisposition } from "./draft-disposition.js";
import type { DraftSnapshot } from "./draft-store.js";
import { effectiveActionIndex, isRolledBack, partKey } from "./inverse-actions.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  editScopeId: string | null;
  consumes: string[];
  actor: "agent" | "human" | "system";
  wId: number | null;
  origin: EditOrigin;
  disposition: PartDisposition;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ModelResponseIdentity;
  model?: boolean;
  draftId?: string | null;
  documentIds?: DocumentId[];
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  live: Y.Doc;
  /** Set when the document is removed: its inverse is skipped with this record, never planned. */
  removal: DocumentRemovalRecord | null;
  history: StoredInversePart[];
  drafts: ReadonlyMap<
    string,
    { documentDraft: DraftSnapshot; doc: Y.Doc; name: string; frozen: boolean }
  >;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  draftId: string | null;
  computed: ComputedInverse;
  consumes: string[];
  skips: TurnInverseSkip[];
};
export interface TurnInverseStore {
  /**
   * The inverse's attempts: `run` plans on a lock-free capture and commits through `commit`;
   * a commit that finds the capture moved reruns `run` on a new capture. After the last
   * attempt `run` sees one more capture on which `commit` throws `ReversalConflictError`.
   */
  withCapturedDocuments<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T>;
  commit(input: {
    plans: PreparedDocumentInverse[];
    kind: "undo" | "redo" | "revert" | "rollback";
    userId?: UserId;
    query: TurnInverseQuery;
  }): Promise<string[]>;
  describePart(
    document: InverseDocument,
    part: StoredInversePart,
  ): { before: string; after: string };
}
const reversible = (part: StoredInversePart) => part.disposition === "pending";
const targetsTurn = (part: StoredInversePart, query: TurnInverseQuery) =>
  (query.responseIdentity
    ? part.actor === "agent" && part.kind !== "rollback"
    : part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  (!query.responseIdentity || part.editScopeId === query.responseIdentity.editScopeId);

/** One selection and one destination per document, for both command and dry run. */
function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  direction: "undo" | "redo",
  actionId: string,
): PreparedDocumentInverse[] {
  const originals = documents.flatMap((document) =>
    document.history.filter((part) => targetsTurn(part, query)),
  );
  const keys = new Set(originals.map(partKey));
  const all = documents.flatMap((document) => document.history).sort((a, b) => a.id - b.id);
  const selected =
    direction === "redo"
      ? effectiveActionIndex(all, keys, reversible).actions.find((action) =>
          action.parts.some(reversible),
        )
      : undefined;
  const selectedAction = selected?.id;
  const accepted = selected?.targets ?? new Set<string>();
  return documents.map((document) => {
    const targets = document.history.filter(
      (part) => targetsTurn(part, query) && (direction === "undo" || accepted.has(partKey(part))),
    );
    const rolledBack = (part: StoredInversePart) => isRolledBack(document.history, part);
    const destinations =
      direction === "undo"
        ? targets.filter((part) => !rolledBack(part))
        : document.history.filter((part) => part.actionId === selectedAction && !rolledBack(part));
    const pending = destinations.find((part) => part.origin.kind === "pending");
    const draftId = pending?.origin.kind === "pending" ? pending.origin.draftId : null;
    const draft = draftId ? document.drafts.get(draftId) : undefined;
    const liveIndex = prepareEditRoots(document.live, document.history);
    const index = draft ? liveIndex.forView(draft.doc) : liveIndex;
    const skips: TurnInverseSkip[] = [];
    const selection: InverseSelection[] = [];
    const skip = (part: StoredInversePart, reason: string) =>
      skips.push({
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        reason,
      });
    for (const part of targets.sort((a, b) => (direction === "undo" ? b.id - a.id : a.id - b.id))) {
      if (rolledBack(part)) {
        skip(part, "Rolled back");
        continue;
      }
      if (document.removal) {
        skip(
          part,
          `This file was ${document.removal.reason === "discarded" ? "discarded" : "deleted"}`,
        );
        continue;
      }
      const inverse =
        direction === "redo"
          ? destinations.find((candidate) =>
              candidate.targets.some((target) => partKey(target) === partKey(part)),
            )
          : undefined;
      const disposition = (inverse ?? part).disposition;
      if (disposition !== "pending") {
        skip(part, disposition === "applied" ? "Applied to the manuscript" : "discarded");
        continue;
      }
      if (draft?.frozen) {
        skip(part, "This draft is archived");
        continue;
      }
      const originDraftId = part.origin.kind === "pending" ? part.origin.draftId : null;
      if (originDraftId !== draftId || (originDraftId && !draft)) {
        skip(part, originDraftId === draftId ? "discarded" : "This part is in another draft");
        continue;
      }
      selection.push({ part, direction: direction === "undo" ? "invert" : "reapply" });
    }
    const computed = index.compute(selection, {
      actionId,
      allocateClient: allocateDocumentClient,
    });
    for (const classified of computed.skipped) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part)
        skip(
          part,
          classified.reasons.includes("inaccessible ancestor")
            ? "Its paragraph was removed"
            : classified.state === "undone"
              ? "Already undone"
              : "Stayed as you edited it",
        );
    }
    return {
      document,
      draftId,
      computed,
      consumes: selectedAction ? [selectedAction] : [],
      skips,
    };
  });
}
const countAccepted = (plans: PreparedDocumentInverse[]) =>
  plans.reduce(
    (count, plan) => count + plan.computed.edits.reduce((n, edit) => n + edit.parts.length, 0),
    0,
  );

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    ...createModelInversePolicy(store),
    async getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null> {
      const query = { threadId, turnId };
      return store.withCapturedDocuments(query, async (documents) => {
        if (!documents.length) return null;
        const redo = prepare(store, documents, query, "redo", randomUUID());
        if (countAccepted(redo))
          return {
            state: "live-reversed",
            control: "redo",
            skips: redo.flatMap((plan) => plan.skips),
          };
        const undo = prepare(store, documents, query, "undo", randomUUID());
        if (countAccepted(undo))
          return {
            state: "live-active",
            control: "undo",
            skips: undo.flatMap((plan) => plan.skips),
          };
        return {
          state: "expired",
          control: "view_change",
          skips: undo.flatMap((plan) => plan.skips),
        };
      });
    },
    async reverseTurn(
      query: TurnInverseQuery & {
        direction: "undo" | "redo";
        actor: { type: "user"; userId: string } | { type: "agent" };
      },
    ): Promise<ReversalOutcome> {
      return store.withCapturedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, query.direction, randomUUID());
        const accepted = countAccepted(plans);
        if (accepted)
          await store.commit({
            plans,
            kind: query.direction,
            query,
            userId: query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
          });
        const skips = plans.flatMap((plan) => plan.skips);
        return {
          status: accepted
            ? skips.length
              ? "partial"
              : "reversed"
            : plans.length &&
                plans.every(
                  (plan) =>
                    plan.skips.length &&
                    plan.skips.every((skip) => skip.reason === "This draft is archived"),
                )
              ? "permission_denied"
              : "expired",
          documents: plans.map((plan) => ({
            uri: plan.document.uri,
            ...(plan.computed.edits.length
              ? {
                  destination: plan.draftId
                    ? { kind: "draft" as const, draftId: plan.draftId }
                    : { kind: "live" as const },
                }
              : {}),
            status: plan.computed.edits.length
              ? "reversed"
              : plan.skips.length &&
                  plan.skips.every((skip) => skip.reason === "This draft is archived")
                ? "permission_denied"
                : "expired",
          })),
          skips,
          acceptedParts: accepted,
        };
      });
    },
    async rollbackResponse(
      query: TurnInverseQuery & {
        responseIdentity: import("@meridian/contracts").ModelResponseIdentity;
      },
    ): Promise<void> {
      await store.withCapturedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, "undo", randomUUID());
        // The store also marks only this response's remaining pending target rows.
        await store.commit({ plans, kind: "rollback", query });
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
