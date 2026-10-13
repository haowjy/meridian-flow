/** Identity admission and host-held leases for a reply's one save transaction. */
import type {
  AgentEditCore,
  StagedWriteRejectionReason,
  WriteContext,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { grantWorkIds, targetDocumentId } from "../../file-policy/domain/types.js";
import { markReplyConfirmed } from "../../file-policy/edit-confirmation.js";
import type { FileAccess, FileGrant } from "../../file-policy/index.js";
import type { RefusedResponseDocument } from "./agent-edit-cores.js";
import type { BranchCriticalSections, BranchLockLease } from "./branch-critical-sections.js";
import { collabHook } from "./collab-test-hooks.js";
import type { Drafts } from "./drafts.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";

export type ReplyPin = { draftId: DraftId; peerBranchId: string; upstreamBranchId: string };
export type ReplyDocument = {
  core: AgentEditCore;
  grant: FileGrant<"edit">;
  linkView: LinkView;
  pin?: ReplyPin;
};
export type ReplyRecord = {
  responseId: string;
  threadId?: ThreadId;
  participants: Set<AgentEditCore>;
  /** Cores holding refused writes whose receipts the reply's save must still deliver. */
  receipting: Set<AgentEditCore>;
  documents: Map<DocumentId, ReplyDocument>;
};

export function pinStaged(entry: ReplyDocument | undefined, staged: WriteContext): void {
  const pulled = staged.interactionContext;
  if (!entry || pulled?.mode !== "threadPeer" || entry.linkView.kind !== "draft") return;
  if (!pulled.peerBranchId || !pulled.upstreamBranchId)
    throw new Error("Drafted write has no reply peer identity");
  entry.pin = {
    draftId: entry.linkView.draftId,
    peerBranchId: pulled.peerBranchId,
    upstreamBranchId: pulled.upstreamBranchId,
  };
}
export type ReplySaveFences = {
  withLeases<T>(
    record: ReplyRecord,
    run: (lease: BranchLockLease | undefined) => Promise<T>,
  ): Promise<T>;
  confirm(record: ReplyRecord): Promise<RefusedResponseDocument[]>;
};
export function createReplySaveFences(deps: {
  liveUtilityCore: AgentEditCore;
  branches: Pick<ApplicationBranchStore, "getBranch">;
  criticalSections: BranchCriticalSections;
  drafts: Pick<Drafts, "shareActive">;
  fileAccess: Pick<FileAccess, "confirmEdit">;
  lockWorks(workIds: readonly string[]): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
}): ReplySaveFences {
  return {
    withLeases(record, run) {
      const ids = [...record.documents.values()].flatMap(({ pin }) =>
        pin ? [pin.peerBranchId, pin.upstreamBranchId] : [],
      );
      return ids.length ? deps.criticalSections.withBranches(ids, run) : run(undefined);
    },
    async confirm(record) {
      const entries = [...record.documents];
      if (!entries.length) return [];
      const grants = entries.map(([, entry]) => entry.grant);
      await deps.lockWorks(grants.flatMap((grant) => grantWorkIds(grant.facts)));
      await collabHook("save.afterWorkLock");
      const refusals = new Map<DocumentId, RefusedResponseDocument>();
      for (const denial of await deps.fileAccess.confirmEdit(grants)) {
        const documentId = targetDocumentId(denial.target);
        refusals.set(documentId, { documentId, denial });
      }
      const active = new Map<DraftId, boolean>();
      for (const [documentId, { pin }] of entries.sort(([, a], [, b]) =>
        (a.pin?.draftId ?? "").localeCompare(b.pin?.draftId ?? ""),
      )) {
        if (!pin || refusals.has(documentId)) continue;
        if (!active.has(pin.draftId))
          active.set(pin.draftId, Boolean(await deps.drafts.shareActive(pin.draftId)));
        const upstream = await deps.branches.getBranch(pin.upstreamBranchId);
        const peer = await deps.branches.getBranch(pin.peerBranchId);
        let reason: StagedWriteRejectionReason | undefined;
        if (!active.get(pin.draftId)) reason = "discarded_draft";
        else if (!upstream || upstream.status === "closed") reason = "discarded_document";
        else if (!peer || peer.status === "closed") reason = "discarded_edit";
        else if (
          peer.draftId !== pin.draftId ||
          upstream.draftId !== pin.draftId ||
          peer.upstreamBranchId !== pin.upstreamBranchId ||
          peer.documentId !== documentId ||
          upstream.documentId !== documentId ||
          peer.threadId !== record.threadId ||
          peer.kind !== "thread_peer" ||
          upstream.kind !== "work_draft"
        ) {
          reason = "integration";
          console.error("Reply pin identity mismatch", { documentId, pin });
        }
        if (reason) refusals.set(documentId, { documentId, reason });
      }
      const denied = new Set<AgentEditCore>();
      for (const [documentId, refusal] of refusals) {
        const entry = record.documents.get(documentId);
        if (!entry) continue;
        record.documents.delete(documentId);
        if ("reason" in refusal) {
          // Each write keeps its own receipt; the participant still saves them.
          record.receipting.add(entry.core);
          entry.core.refuseStaged(
            record.responseId,
            documentId,
            refusal.reason,
            entry.pin?.peerBranchId,
          );
        } else if (record.threadId) {
          // A denial carries the policy's document-level copy; the writes are dropped (D29, D42).
          await entry.core.invalidateThreadDocument(documentId, record.threadId);
          denied.add(entry.core);
        }
      }
      // A core whose every document was denied has closed the reply on its side.
      for (const core of denied) {
        const writesElsewhere = [...record.documents.values()].some((entry) => entry.core === core);
        if (!writesElsewhere && !record.receipting.has(core)) record.participants.delete(core);
      }
      // Refused participants still own per-write receipts and must save them.
      markReplyConfirmed([...record.documents.keys()]);
      await deps.lockLiveDocuments(
        [...record.documents]
          .filter(([, entry]) => entry.core === deps.liveUtilityCore)
          .map(([id]) => id)
          .sort(),
      );
      return [...refusals.values()];
    },
  };
}
