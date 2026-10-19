/** Identity admission for a reply's one save transaction: grants, pins and live locks. */
import type {
  AgentEditCore,
  StagedWriteRejectionReason,
  WriteContext,
} from "@meridian/agent-edit/integration";
import type { BranchId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentRemovals } from "../../context/ports/document-removals.js";
import { grantWorkIds, targetDocumentId } from "../../file-policy/domain/types.js";
import { markReplyConfirmed } from "../../file-policy/edit-confirmation.js";
import type { FileAccess, FileGrant } from "../../file-policy/index.js";
import type { RefusedResponseDocument } from "./agent-edit-cores.js";
import type { Branches } from "./branches.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftAgentEditDiagnostics } from "./draft-agent-edit.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";

export type ReplyPin = { branchId: BranchId; peerDraftId: string; upstreamDraftId: string };
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
  if (!entry || pulled?.mode !== "threadPeer" || entry.linkView.kind !== "branch") return;
  if (!pulled.peerDraftId || !pulled.upstreamDraftId)
    throw new Error("Drafted write has no reply peer identity");
  entry.pin = {
    branchId: entry.linkView.branchId,
    peerDraftId: pulled.peerDraftId,
    upstreamDraftId: pulled.upstreamDraftId,
  };
}
export type ReplySaveFences = {
  confirm(record: ReplyRecord): Promise<RefusedResponseDocument[]>;
};
export function createReplySaveFences(deps: {
  liveUtilityCore: AgentEditCore;
  drafts: Pick<ApplicationDraftStore, "getDraft">;
  branches: Pick<Branches, "shareActive">;
  diagnostics?: Pick<DraftAgentEditDiagnostics, "replyPinMismatch">;
  fileAccess: Pick<FileAccess, "confirmEdit">;
  removals: DocumentRemovals;
  lockWorks(workIds: readonly string[]): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
}): ReplySaveFences {
  return {
    async confirm(record) {
      const entries = [...record.documents];
      if (!entries.length) return [];
      const grants = entries.map(([, entry]) => entry.grant);
      await collabHook("save.beforeWorkLock");
      await deps.lockWorks(grants.flatMap((grant) => grantWorkIds(grant.facts)));
      await collabHook("save.afterWorkLock");
      // Works first, then the sorted live documents, never a Work after them. A removal takes
      // the same document locks, so the confirmation below sees it or holds it off until commit.
      await deps.lockLiveDocuments(
        entries
          .filter(([, entry]) => entry.core === deps.liveUtilityCore)
          .map(([id]) => id)
          .sort(),
      );
      await collabHook("save.afterDocumentLock");
      const refusals = new Map<DocumentId, RefusedResponseDocument>();
      const denials = await deps.fileAccess.confirmEdit(grants);
      // A deleted document answers `not_found`; the record says who deleted it.
      const removals = await deps.removals.lookup(
        denials
          .filter((denial) => denial.reason === "not_found")
          .map((d) => targetDocumentId(d.target)),
      );
      for (const denial of denials) {
        const documentId = targetDocumentId(denial.target);
        const removal = removals.get(documentId);
        refusals.set(documentId, { documentId, denial, ...(removal ? { removal } : {}) });
      }
      const active = new Map<BranchId, boolean>();
      for (const [documentId, { pin }] of entries.sort(([, a], [, b]) =>
        (a.pin?.branchId ?? "").localeCompare(b.pin?.branchId ?? ""),
      )) {
        if (!pin || refusals.has(documentId)) continue;
        if (!active.has(pin.branchId))
          active.set(pin.branchId, Boolean(await deps.branches.shareActive(pin.branchId)));
        const upstream = await deps.drafts.getDraft(pin.upstreamDraftId);
        const peer = await deps.drafts.getDraft(pin.peerDraftId);
        let reason: StagedWriteRejectionReason | undefined;
        if (!active.get(pin.branchId)) reason = "discarded_draft";
        else if (!upstream || upstream.status === "closed") reason = "discarded_document";
        else if (!peer || peer.status === "closed") reason = "discarded_edit";
        else if (
          peer.branchId !== pin.branchId ||
          upstream.branchId !== pin.branchId ||
          peer.upstreamDraftId !== pin.upstreamDraftId ||
          peer.documentId !== documentId ||
          upstream.documentId !== documentId ||
          peer.threadId !== record.threadId ||
          peer.kind !== "thread_peer" ||
          upstream.kind !== "work_draft"
        ) {
          reason = "integration";
          deps.diagnostics?.replyPinMismatch({ documentId, threadId: record.threadId, pin });
        }
        if (reason === "discarded_document" || reason === "discarded_edit") {
          // A closed draft over a removed document is the removal's, not a writer's discard;
          // a draft closed with `document_removed` keeps that cause once the document stands again.
          const removal = (await deps.removals.lookup([documentId])).get(documentId);
          if (
            removal ||
            upstream?.closedCause === "document_removed" ||
            peer?.closedCause === "document_removed"
          ) {
            refusals.set(documentId, { documentId, removed: removal ?? null });
            continue;
          }
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
            entry.pin?.peerDraftId,
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
      return [...refusals.values()];
    },
  };
}
