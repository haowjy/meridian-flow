/**
 * A reply's save fences (contract §2.5, §14, file-access §5.2): the pin each drafted
 * document's staged writes carry, the branch leases a save or rollback takes before its
 * transaction, and the confirmation under the save's locks that drops refused and stale
 * documents. The pool owns routing and the reply's records; this owns their fencing.
 */
import type { AgentEditCore, WriteContext } from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import {
  type FileAccess,
  type FileGrant,
  grantWorkIds,
  markReplyConfirmed,
  targetDocumentId,
} from "../../file-policy/index.js";
import type { RefusedResponseDocument } from "./agent-edit-cores.js";
import type { BranchCriticalSections, BranchLockLease } from "./branch-critical-sections.js";
import { collabHook } from "./collab-test-hooks.js";
import type { Drafts } from "./drafts.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";

/**
 * A drafted document's staged writes are pinned: to the draft its first write ensured,
 * the thread peer it staged against, and the draft branch's generation then. Its save
 * resolves exactly these and never provisions another draft.
 */
export type DraftPin = { draftId: DraftId; branchId: string; generation: number };

/**
 * One document's place in a reply: its grant, and with it its destination and the link
 * view that destination resolved to, is pinned at its first write; a drafted one also
 * pins its draft and peer.
 */
export type ReplyDocument = {
  core: AgentEditCore;
  grant: FileGrant<"edit">;
  linkView: LinkView;
  pin?: DraftPin;
};

export type ReplyRecord = {
  threadId?: ThreadId;
  /** Every core holding this reply's buffered writes; each saves in the reply's one step. */
  participants: Set<AgentEditCore>;
  documents: Map<DocumentId, ReplyDocument>;
  /** Drafted reversals staged in the reply: history routed them; their peers pin like writes. */
  reversals: Map<DocumentId, ReplyDocument>;
};

/** Records the peer a reply's drafted call just staged against as its document's pin. */
export function pinStaged(entry: ReplyDocument | undefined, staged: WriteContext): void {
  const pulled = staged.interactionContext;
  if (!entry || pulled?.mode !== "threadPeer" || entry.linkView.kind !== "draft") return;
  entry.pin = {
    draftId: entry.linkView.draftId,
    branchId: pulled.branchId,
    generation: pulled.branchGeneration,
  };
}

export type ReplySaveFences = {
  /**
   * The reply's pinned peers and their draft branches, discovered outside any
   * transaction and leased in one ordered acquisition held through `run` (V2-H2): a save
   * and a whole-draft close serialize on the leases, never on a Work row. No pins, no lease.
   */
  withLeases<T>(
    record: ReplyRecord,
    run: (lease: BranchLockLease | undefined) => Promise<T>,
  ): Promise<T>;
  /**
   * In the save's transaction, once per reply: every grant confirmed under its Works'
   * locks (id order), each pin rechecked under them (peer and draft branch active at the
   * pinned generation, the draft `FOR SHARE`), then the live documents' mutation locks.
   * A refused or stale document leaves the record and its core; the rest saves (D29, D42).
   * Nothing here ensures a draft or a peer.
   */
  confirm(record: ReplyRecord): Promise<RefusedResponseDocument[]>;
};

export function createReplySaveFences(deps: {
  liveUtilityCore: AgentEditCore;
  branches: Pick<ApplicationBranchStore, "getBranch">;
  criticalSections: BranchCriticalSections;
  drafts: Pick<Drafts, "shareActive">;
  fileAccess: Pick<FileAccess, "confirmEdit">;
  /** Locks Work rows `FOR NO KEY UPDATE` in one id-ordered select, in the save's transaction. */
  lockWorks(workIds: readonly string[]): Promise<void>;
  /** A reply's live documents' mutation locks, sorted, after its Work locks (§5.2). */
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
}): ReplySaveFences {
  function pinsOf(record: ReplyRecord): (DraftPin & { documentId: DocumentId })[] {
    const pins = new Map<DocumentId, DraftPin & { documentId: DocumentId }>();
    for (const [documentId, entry] of [...record.documents, ...record.reversals]) {
      if (entry.pin && !pins.has(documentId)) pins.set(documentId, { documentId, ...entry.pin });
    }
    return [...pins.values()];
  }

  async function leasedBranchIds(pins: readonly DraftPin[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const pin of pins) {
      ids.add(pin.branchId);
      const peer = await deps.branches.getBranch(pin.branchId);
      if (peer?.upstreamBranchId) ids.add(peer.upstreamBranchId);
    }
    return [...ids];
  }

  async function stalePins(
    pins: readonly (DraftPin & { documentId: DocumentId })[],
  ): Promise<Set<DocumentId>> {
    const stale = new Set<DocumentId>();
    const draftActive = new Map<DraftId, boolean>();
    for (const pin of [...pins].sort((a, b) => a.draftId.localeCompare(b.draftId))) {
      if (!draftActive.has(pin.draftId)) {
        draftActive.set(pin.draftId, Boolean(await deps.drafts.shareActive(pin.draftId)));
      }
      const peer = await deps.branches.getBranch(pin.branchId);
      const upstream = peer?.upstreamBranchId
        ? await deps.branches.getBranch(peer.upstreamBranchId)
        : null;
      if (
        !draftActive.get(pin.draftId) ||
        peer?.status !== "active" ||
        peer.draftId !== pin.draftId ||
        upstream?.status !== "active" ||
        upstream.generation !== pin.generation
      ) {
        stale.add(pin.documentId);
      }
    }
    return stale;
  }

  return {
    async withLeases(record, run) {
      const branchIds = await leasedBranchIds(pinsOf(record));
      return branchIds.length === 0
        ? run(undefined)
        : deps.criticalSections.withBranches(branchIds, (lease) => run(lease));
    },

    async confirm(record) {
      const entries = [...record.documents, ...record.reversals];
      if (entries.length === 0) return [];
      const grants = entries.map(([, entry]) => entry.grant);
      await deps.lockWorks(grants.flatMap((grant) => grantWorkIds(grant.facts)));
      await collabHook("save.afterWorkLock");
      const refusals = new Map<DocumentId, RefusedResponseDocument>();
      for (const denial of await deps.fileAccess.confirmEdit(grants)) {
        const documentId = targetDocumentId(denial.target);
        refusals.set(documentId, { documentId, denial });
      }
      for (const documentId of await stalePins(pinsOf(record))) {
        if (!refusals.has(documentId)) refusals.set(documentId, { documentId, stale: true });
      }
      for (const documentId of refusals.keys()) {
        for (const documents of [record.documents, record.reversals]) {
          const entry = documents.get(documentId);
          if (!entry) continue;
          documents.delete(documentId);
          if (record.threadId)
            await entry.core.invalidateThreadDocument(documentId, record.threadId);
        }
      }
      for (const core of [...record.participants]) {
        const holds = (entry: ReplyDocument) => entry.core === core;
        const writesElsewhere =
          [...record.documents.values()].some(holds) || [...record.reversals.values()].some(holds);
        if (!writesElsewhere && entries.some(([, entry]) => holds(entry))) {
          record.participants.delete(core);
        }
      }
      // The seams these documents' participants reach take this as their grant.
      markReplyConfirmed([...record.documents.keys(), ...record.reversals.keys()]);
      await deps.lockLiveDocuments(
        [...record.documents]
          .filter(([, entry]) => entry.core === deps.liveUtilityCore)
          .map(([documentId]) => documentId)
          .sort(),
      );
      return [...refusals.values()];
    },
  };
}
