/**
 * The ordered extension point of a batch's completion transaction: how Apply's
 * tree work joins the text settlement it publishes with (target "Apply is one
 * publication").
 *
 * Inside the one completion transaction the order is fixed:
 *
 * 1. Work row locks, the union of every member's and every plan's `workIds`;
 * 2. namespace locks, once, for the union of every plan's `namespaceDocumentIds`;
 * 3. document mutation locks, sorted, for every member and every plan's `documentIds`;
 * 4. `beforeAdmission` of every plan (vacate, then install: reveal at final locations);
 * 5. trail settlement and text admission of every member;
 * 6. `afterAdmission` of every plan (settle arrivals, record history once);
 * 7. the warm-state recheck, then commit;
 * 8. after commit: warm rooms, then every plan's `afterCommit` (catalog refresh, wake hints).
 *
 * Steps run in registration order inside each phase and join the ambient
 * transaction. A batch with no text members (a tree-only Apply) passes through
 * the same order with phase 5 empty.
 */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { PushLineageRow } from "../branch-push-contracts.js";

/** The batch a completion transaction settles, as a publication step sees it. */
export type SettlementBatchScope = {
  batchId: string;
  pushes: readonly PushLineageRow[];
};

export type SettlementPublicationPlan = {
  /** Works this step changes, locked with the batch's own before anything else. */
  workIds?: readonly WorkId[];
  /** Documents whose source namespaces must be held, after Work locks, before document locks. */
  namespaceDocumentIds?: readonly DocumentId[];
  /** Documents whose mutation locks join the batch's sorted set. */
  documentIds?: readonly DocumentId[];
  beforeAdmission?(): Promise<void>;
  afterAdmission?(): Promise<void>;
  afterCommit?(): void | Promise<void>;
};

export type SettlementPublicationStep = {
  /**
   * Plans this step for one batch from durable, immutable inputs, before any
   * lock is taken. Recovery replans, so a plan never depends on process state.
   * Null when the step has nothing to publish in this batch.
   */
  plan(batch: SettlementBatchScope): Promise<SettlementPublicationPlan | null>;
};

/** How the store takes namespace locks; the context domain owns the keys. */
export type SettlementNamespaceLocks = {
  lockNamespaces(documentIds: readonly DocumentId[]): Promise<void>;
};
