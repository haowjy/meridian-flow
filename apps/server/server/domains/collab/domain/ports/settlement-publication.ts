/**
 * The ordered extension point of a batch's settlement: how Apply's tree work
 * joins the text settlement it publishes with (target "Apply is one
 * publication"; foundation contract §11.1).
 *
 * The same plans and the same lock order run twice. First, before anything is
 * staged, in one short check transaction that calls `check()`; then inside the
 * root-owned completion transaction:
 *
 * 1. Work row locks, the union of every member's and every plan's `workIds`;
 * 2. namespace locks, once, sorted, for the sources of every plan's
 *    `namespaceDocumentIds` together with every plan's `namespaceSourceIds`;
 * 3. document mutation locks, sorted, for every member and every plan's `documentIds`;
 * 4. `beforeAdmission` of every plan (vacate, then install: reveal at final
 *    locations), each deciding `proceed` (optionally holding members) or `refuse`;
 * 5. trail settlement and text admission of every member not held;
 * 6. `afterAdmission(admitted)` of every plan (settle arrivals, record history once);
 * 7. the warm-state recheck of admitted members, then commit;
 * 8. after commit: warm rooms, then every plan's `afterCommit` (catalog refresh,
 *    wake hints), each awaited before the next; a failing effect is logged and
 *    the later ones still run, since the batch is already durable.
 *
 * Nothing a step needs is locked later than its phase: a step never takes a
 * namespace lock under a document lock. A refusal at the check stages nothing;
 * a refusal in completion abandons the staged batch durably (its journal rows
 * are reviewable again). A held member stays out of live everywhere and its
 * rows stay reviewable while the rest admit. Steps run in registration order
 * inside each phase and join the transaction the settlement owns (never an
 * ambient one). A batch with no text members (a branchless image Apply, a
 * tree-only Apply) passes through the same order with phase 5 empty.
 */

import type { ContextSourceId, DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";

export type PublicationRefusal = { code: string; detail?: JsonValue };

/** A member whose text must not admit, and why: its result reports the reason. */
export type PublicationHold = { documentId: DocumentId; reason: PublicationRefusal };

export type PublicationAdmission =
  | { kind: "proceed"; hold?: readonly PublicationHold[] }
  | { kind: "refuse"; reason: PublicationRefusal };

/** A text member as a step sees it; before staging it has no push yet (`pushId` null). */
export type SettlementScopePush = {
  pushId: number | null;
  branchId: string | null;
  documentId: DocumentId;
  journalIds: readonly number[];
};

/** The batch being checked or settled, as a publication step sees it. */
export type SettlementBatchScope = {
  batchId: string;
  pushes: readonly SettlementScopePush[];
  /** Durable step inputs staged with the batch, by step kind. */
  payloads: ReadonlyMap<string, JsonValue>;
  /** Each member's live state vector at its coordinator lease (its lock cut), for text tokens. */
  liveStateVectors: ReadonlyMap<DocumentId, Uint8Array>;
};

export type SettlementPublicationPlan = {
  /** Works this step changes, locked with the batch's own before anything else. */
  workIds?: readonly WorkId[];
  /** Documents whose current sources' namespaces must be held. */
  namespaceDocumentIds?: readonly DocumentId[];
  /** Explicit sources (current and final), merged with the documents' sources into one acquisition. */
  namespaceSourceIds?: readonly ContextSourceId[];
  /** Documents whose mutation locks join the batch's sorted set. */
  documentIds?: readonly DocumentId[];
  /** No writes: the same decision `beforeAdmission` makes, run before staging. */
  check?(): Promise<PublicationAdmission>;
  /** Vacate and install; absent means `proceed`. */
  beforeAdmission?(): Promise<PublicationAdmission>;
  /** Settle arrivals and record history, given the members whose text admitted. */
  afterAdmission?(admitted: readonly DocumentId[]): Promise<void>;
  afterCommit?(): void | Promise<void>;
};

export type SettlementPublicationStep = {
  /** The payload kind this step owns (`"draft_tree"`); recovery finds its input by it. */
  kind: string;
  /**
   * Plans this step for one batch from durable, immutable inputs, before any
   * lock is taken. The check and recovery plan again, so a plan never depends
   * on process state. Null when the step has nothing to publish in this batch.
   */
  plan(batch: SettlementBatchScope): Promise<SettlementPublicationPlan | null>;
};

/** How the store takes namespace locks; the context domain owns the keys. */
export type SettlementNamespaceLocks = {
  /** One sorted acquisition over the documents' current sources and the explicit sources. */
  lockNamespaces(input: {
    documentIds: readonly DocumentId[];
    sourceIds: readonly ContextSourceId[];
  }): Promise<void>;
};
