/** Model revert and failed-response rollback over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import type {
  ComputedInverse,
  InversePart,
  InverseSelection,
} from "@meridian/agent-edit/integration";
import type {
  DocumentId,
  EditOrigin,
  EditPlacement,
  ModelResponseIdentity,
  ThreadId,
  TurnId,
} from "@meridian/contracts";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { isRolledBack } from "./inverse-actions.js";
import { prepareHolds } from "./inverse-holds.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  editScopeId: string | null;
  actor: "agent" | "human" | "system";
  wId: number | null;
  origin: EditOrigin;
  placement: EditPlacement;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: ModelResponseIdentity;
  model?: boolean;
  branchId?: string | null;
  documentIds?: DocumentId[];
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  live: Y.Doc;
  history: StoredInversePart[];
  drafts: ReadonlyMap<
    string,
    { branch: BranchSnapshot; doc: Y.Doc; name: string; frozen: boolean }
  >;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  branchId: string | null;
  computed: ComputedInverse;
  heldDraftIds: string[];
};
export interface TurnInverseStore {
  markBlocking(branchIds: string[]): Promise<void>;
  /** Transition locks, all process locks, Work rows, then admission locks. */
  withLockedDocuments<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T>;
  commit(input: {
    plans: PreparedDocumentInverse[];
    kind: "revert" | "rollback";
    query: TurnInverseQuery;
  }): Promise<string[]>;
  describePart(
    document: InverseDocument,
    part: StoredInversePart,
  ): { before: string; after: string };
}
const eligiblePlacement = (part: StoredInversePart) =>
  part.placement.kind === "pending" || part.placement.kind === "live";
const targetsResponse = (
  part: StoredInversePart,
  query: TurnInverseQuery & { responseIdentity: ModelResponseIdentity },
) =>
  part.actor === "agent" &&
  part.kind !== "rollback" &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  part.editScopeId === query.responseIdentity.editScopeId;

/** One selection and one destination per document: invert every part the response left. */
function prepare(
  documents: InverseDocument[],
  query: TurnInverseQuery & { responseIdentity: ModelResponseIdentity },
  actionId: string,
  contexts: ReturnType<typeof prepareHolds>,
): PreparedDocumentInverse[] {
  return documents.map((document) => {
    const targets = document.history.filter((part) => targetsResponse(part, query));
    const rolledBack = (part: StoredInversePart) => isRolledBack(document.history, part);
    const pending = targets
      .filter((part) => !rolledBack(part))
      .find((part) => part.placement.kind === "pending");
    let branchId = pending?.placement.kind === "pending" ? pending.placement.branchId : null;
    const context = contexts.get(document.documentId);
    if (!context) throw new Error("Missing document hold context");
    const { views, liveIndex, holds } = context;
    const targetRoots = new Set(targets.flatMap((part) => liveIndex.roots(part.effect)));
    if (!branchId) {
      const ownHolders = new Set([...targetRoots].flatMap((root) => [...(holds.get(root) ?? [])]));
      branchId =
        targets
          .flatMap((part) => (part.origin.kind === "pending" ? [part.origin.branchId] : []))
          .find((id) => ownHolders.has(id)) ?? null;
    }
    const draft = branchId ? document.drafts.get(branchId) : undefined;
    const heldDraftIds: string[] = [];
    const selection: InverseSelection[] = [];
    for (const part of targets.sort((a, b) => b.id - a.id)) {
      if (rolledBack(part) || !eligiblePlacement(part) || draft?.frozen) continue;
      if (part.placement.kind === "pending" && part.placement.branchId !== branchId) continue;
      const holder = liveIndex
        .roots(part.effect)
        .flatMap((root) => [...(holds.get(root) ?? [])])
        .find((id) => id !== branchId);
      if (holder) {
        heldDraftIds.push(holder);
        continue;
      }
      selection.push({ part });
    }
    const computed = (views.get(branchId) ?? liveIndex).compute(selection, {
      actionId,
      kind: "rollback",
      allocateClient: allocateDocumentClient,
    });
    return { document, branchId, computed, heldDraftIds };
  });
}

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    ...createModelInversePolicy(store),
    async rollbackResponse(
      query: TurnInverseQuery & { responseIdentity: ModelResponseIdentity },
    ): Promise<void> {
      await store.withLockedDocuments(query, async (documents) => {
        const plans = prepare(documents, query, randomUUID(), prepareHolds(documents));
        await store.markBlocking(plans.flatMap((plan) => plan.heldDraftIds));
        // The store also marks only this response's remaining pending target rows.
        await store.commit({ plans, kind: "rollback", query });
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
