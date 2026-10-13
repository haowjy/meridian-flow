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
 *    then the plans' `draftIds` rows (`FOR NO KEY UPDATE`, id order);
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

import type { DraftId } from "@meridian/contracts";
import type { ContextSourceId, DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { BranchLockLease } from "../branch-critical-sections.js";

export type PublicationRefusal = { code: string; detail?: JsonValue };

/**
 * An item a step keeps out of live, and why. Items are the step's own units
 * (Apply: a draft item key); `documentId` names the text member that must not
 * admit with it, absent for a branchless item (an image). Holds are durable:
 * staged with the batch when decided at the check, written in completion when
 * decided there, and reported per item either way.
 */
export type PublicationItemHold = {
  itemKey: string;
  documentId?: DocumentId;
  reason: PublicationRefusal;
};

/**
 * What completion did to one item that publishes, in the step's own terms (lane E: the
 * receipt notes, a rename named back or a restore), decided under the completion's locks
 * and returned with the batch's result.
 */
export type PublicationItemOutcome = { itemKey: string; detail: JsonValue };

export type PublicationAdmission =
  | {
      kind: "proceed";
      hold?: readonly PublicationItemHold[];
      /** Completion only: what it did per item, reported with the batch's result. */
      outcomes?: readonly PublicationItemOutcome[];
    }
  | { kind: "refuse"; reason: PublicationRefusal };

/**
 * The pre-staging decision. A step that holds items must return its payload
 * refined to exclude them: that refined payload is what is staged, so
 * completion never sees, and can never promote, an excluded item.
 */
export type PublicationCheckAdmission =
  | { kind: "proceed"; hold?: readonly PublicationItemHold[]; payload?: JsonValue }
  | { kind: "refuse"; reason: PublicationRefusal };

/** A text member, known before staging and reconstructed from its push for completion. */
export type PublicationMember = {
  documentId: DocumentId;
  branchId: string | null;
  workId: WorkId | null;
  journalIds: readonly number[];
};

/** A member after staging: lineage-specific data lives only here. */
export type StagedPublicationMember = PublicationMember & { pushId: number };

type ScopeInputs = {
  batchId: string;
  /** Step inputs by step kind; at completion, exactly what was staged (immutable). */
  payloads: ReadonlyMap<string, JsonValue>;
  /**
   * Each member's full-state fingerprint (`fullStateFingerprint`) at its coordinator
   * lease, its lock cut, for rendered-text tokens: deletions change it.
   */
  liveTextFingerprints: ReadonlyMap<DocumentId, string>;
};

/** The batch being checked before staging, or settled after it, as a step sees it. */
export type SettlementBatchScope =
  | (ScopeInputs & { stage: "check"; members: readonly PublicationMember[] })
  | (ScopeInputs & {
      stage: "completion";
      members: readonly StagedPublicationMember[];
      /** Items already held for this batch (at the check), never promoted. */
      held: readonly PublicationItemHold[];
      /** The lease the caller holds over the batch's branches, when it has one. */
      lease?: BranchLockLease;
    });

export type SettlementPublicationPlan = {
  /** Works this step changes, locked with the batch's own before anything else. */
  workIds?: readonly WorkId[];
  /** Drafts this step publishes or closes, row-locked after Works, before namespaces. */
  draftIds?: readonly DraftId[];
  /** Documents whose current sources' namespaces must be held. */
  namespaceDocumentIds?: readonly DocumentId[];
  /** Explicit sources (current and final), merged with the documents' sources into one acquisition. */
  namespaceSourceIds?: readonly ContextSourceId[];
  /** Documents whose mutation locks join the batch's sorted set. */
  documentIds?: readonly DocumentId[];
  /** No writes: the same decision `beforeAdmission` makes, run before staging. */
  check?(): Promise<PublicationCheckAdmission>;
  /** Vacate and install; absent means `proceed`. */
  beforeAdmission?(): Promise<PublicationAdmission>;
  /** Settle arrivals and record history, given the members whose text admitted. */
  afterAdmission?(admitted: readonly DocumentId[]): Promise<void>;
  /**
   * The batch was refused in completion and is being abandoned, in that same transaction:
   * a step records what the withdrawal means for its writer's command (§4.6).
   */
  onRefused?(reason: PublicationRefusal): Promise<void>;
  afterCommit?(): void | Promise<void>;
};

export type SettlementPublicationStep = {
  /** The payload kind this step owns (`"draft_tree"`); recovery finds its input by it. */
  kind: string;
  /**
   * The outer preparation, from the step's payload: the branch ids whose
   * critical-section leases the batch needs (Apply all: every branch of the draft
   * an Apply may close). Warm execution and recovery both acquire them before
   * coordinator leases and any database transaction; completion calls it again
   * under its locks, and a set that grew sends the batch back to discovery.
   * Never take leases from `beforeAdmission`.
   */
  prepare?(payload: JsonValue): Promise<{ branchIds: readonly string[] }>;
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
