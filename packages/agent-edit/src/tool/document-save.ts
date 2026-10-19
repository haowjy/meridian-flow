// One document's save through its host: prepare, persist (the durable append and its cut), then
// the accepted save's report (detection, receipts, frontier), which never fails the save.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { FrontierLookup } from "../frontier.js";
import { toDocHandle } from "../handles.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import type { BlockItemId } from "../model/block-hash.js";
import {
  type DiscardedWriteReason,
  type DocumentAccess,
  type DocumentCoordinator,
  type SaveCut,
  SavePreconditionRefused,
  type StagedCut,
  type StagedWriteRejectionReason,
  type StagedWriteSaveResult,
} from "../ports/document-coordinator.js";
import type { DocumentLinksPort } from "../ports/document-links.js";
import type { AgentEditModel } from "../ports/model.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import type {
  AcceptedMutationReport,
  CommitDetection,
  CommitDetectionInput,
  JournaledUpdate,
} from "./commit-detection.js";
import type { CopySummary } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import { observeRendered } from "./observation.js";
import { rejectedWriteExplanation, renderSettledReceipts } from "./receipt.js";
import type {
  DocumentCommandName,
  InteractionContext,
  MutationActor,
  ResponseCommitDocumentResult,
} from "./types.js";
import type { ObservationFailedDetail } from "./write-deps.js";

/** One staged write of a reply, as its save keeps or refuses it and its receipt renders it. */
export interface StagedResponseUpdate extends JournaledUpdate {
  rejectionReason?: StagedWriteRejectionReason;
  documentLabel: string;
  description: string;
  commandName: DocumentCommandName;
  turnId: string;
  actor: Extract<MutationActor, { kind: "agent" }>;
  writeId: string;
  durableWriteId: string;
  stageSeq: number;
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  /** The view this write planned on, immediately before it was applied. */
  preOwnSnapshot: Uint8Array;
  copied?: CopySummary;
}

/** What a document's save reads from the reply's buffer for it. */
export interface SavedDocument {
  docId: string;
  providerResponseId: string;
  session: { threadId: string };
  interactionContext?: InteractionContext;
  ensureDocumentBeforeCommit: boolean;
  /** The room copy's cut at the scope's first stage of the document (amendment 2). */
  cut: StagedCut;
  updates: StagedResponseUpdate[];
  rejectedUpdates?: StagedResponseUpdate[];
}

/** A document's prepared save, held by its attempt until `install`. */
export interface SaveOutcome {
  updates: StagedResponseUpdate[];
  rejected: StagedResponseUpdate[];
  room: string | null;
  write: StagedWriteSaveResult["write"];
}

export interface SaveNowInput {
  docId: string;
  /** The room copy's cut before the write. */
  cut: StagedCut;
  entry: JournalBatchAppendEntry;
  links: CommandLinks;
  /** The view the write planned on. */
  preOwnSnapshot: Uint8Array;
  actor: MutationActor;
  interactionContext?: InteractionContext;
  /**
   * A create without overwrite lands only in a document still empty when its append reads it
   * under the document's lock; otherwise this is the answer.
   */
  refuseUnlessEmpty?: InternalWriteResult;
}

/** A write saved at once: its report, and the room as the save left it. */
export interface SavedNow extends AcceptedMutationReport {
  afterState: Uint8Array;
}

export interface DocumentSave {
  /**
   * A document's save, prepared by its host without changing the buffer. A host that reports
   * no effect while it kept entries broke the port's contract: refuse rather than certify
   * writes nobody stored.
   */
  prepare(doc: SavedDocument): Promise<SaveOutcome>;
  /**
   * The durable phase, inside the caller's commit scope: the host appends the kept rows and
   * resolves the cut the append actually followed (null when nothing was written); a created
   * document is ensured.
   */
  persist(doc: SavedDocument, save: SaveOutcome): Promise<SaveCut | null>;
  /**
   * The saved document's receipts, after its save handed its write to the host: the save's
   * verdict on `doc` (the commit's snapshot), then detection on `cut` (what `persist`
   * resolved), then the frontier it records. Never throws: past persistence any failure
   * degrades the receipts, never the save.
   */
  report(
    editScopeId: string,
    doc: SavedDocument,
    save: SaveOutcome,
    cut: SaveCut | null,
    recordingFrontier: FrontierLookup | undefined,
  ): Promise<ResponseCommitDocumentResult>;
  /**
   * A write outside a reply, saved at once through the same host port: its one entry kept or
   * refused, persisted, handed over, and detected on the append's cut. Once persisted it is
   * accepted: a reporting failure degrades it, so a retry of the same call finds it cached
   * instead of writing it twice.
   */
  saveNow(input: SaveNowInput): Promise<SavedNow | InternalWriteResult>;
}

export function createDocumentSave(deps: {
  coordinator: DocumentCoordinator;
  detection: CommitDetection;
  model: AgentEditModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinksPort;
  ensureDocument?: (docId: string) => Promise<void>;
  onObservationFailed?: (event: ObservationFailedDetail) => void;
}): DocumentSave {
  const { coordinator, detection } = deps;

  return {
    async prepare(doc) {
      const saved = await coordinator.prepareSave({
        docId: doc.docId,
        cut: doc.cut,
        entries: journalEntries(doc.docId, doc.updates),
        access: accessFor(doc.interactionContext),
      });
      const kept = new Set(saved.kept);
      const reasons = new Map(saved.rejected.map((write) => [write.writeId, write.reason]));
      const outcome: SaveOutcome = {
        updates: doc.updates.filter((entry) => kept.has(entry.durableWriteId)),
        rejected: doc.updates
          .filter((entry) => !kept.has(entry.durableWriteId))
          .map((entry) => ({
            ...entry,
            rejectionReason: reasons.get(entry.durableWriteId) ?? ("integration" as const),
          })),
        room: saved.room,
        write: saved.write,
      };
      if (saved.write.kind === "no-effect" && outcome.updates.length) {
        discardSave(outcome);
        throw new Error(`Host reported no effect for kept writes on ${doc.docId}`);
      }
      return outcome;
    },

    async persist(doc, save) {
      const cut = save.write.kind === "write" ? await save.write.persist() : null;
      if (save.updates.length && doc.ensureDocumentBeforeCommit)
        await deps.ensureDocument?.(doc.docId);
      return cut;
    },

    async report(editScopeId, doc, save, cut, recordingFrontier) {
      // The snapshot takes the save's verdict; the staged buffer keeps its own until close.
      doc.updates = save.updates;
      doc.rejectedUpdates = [...(doc.rejectedUpdates ?? []), ...save.rejected];
      if (!doc.updates.length) return degradedReceipts(doc, null, 0);
      if (!cut) return degradedReceipts(doc, null);
      return reportAccepted(cut, degradedReceipts(doc, null), async (before, after) => {
        const links = await saveLinks(editScopeId, doc, after);
        const applied = await detection.reportAcceptedMutation(before, after, {
          ...detectionInput(doc, links),
          access: accessFor(doc.interactionContext),
        });
        const document = renderedReceipts(doc, links, applied, after);
        return save.room && recordingFrontier
          ? await observeSave(doc, links, document, after, save.room, recordingFrontier)
          : document;
      });
    },

    async saveNow(input) {
      const access = accessFor(input.interactionContext);
      const { refuseUnlessEmpty } = input;
      const saved = await coordinator.prepareSave({
        docId: input.docId,
        cut: input.cut,
        entries: [input.entry],
        access,
        ...(refuseUnlessEmpty ? { precondition: holdsNoBlocks } : {}),
      });
      const { write } = saved;
      let persisted = false;
      try {
        const refused = saved.rejected[0];
        if (refused) return refusedWrite(refused.reason);
        if (write.kind === "no-effect")
          throw new Error(`Host reported no effect for a kept write on ${input.docId}`);
        let cut: SaveCut;
        try {
          cut = await write.persist();
        } catch (cause) {
          if (refuseUnlessEmpty && cause instanceof SavePreconditionRefused)
            return refuseUnlessEmpty;
          throw cause;
        }
        persisted = true;
        write.transfer();
        return reportAccepted(
          cut,
          { revision: null, awarenessDegraded: true, afterState: cut.afterState },
          async (before, after) => ({
            ...(await detection.reportAcceptedMutation(before, after, {
              docId: input.docId,
              links: input.links,
              preOwnSnapshot: input.preOwnSnapshot,
              access,
              actor: input.actor,
              interactionContext: input.interactionContext,
              ownWrites: [{ preOwnSnapshot: input.preOwnSnapshot, update: input.entry.update }],
            })),
            afterState: cut.afterState,
          }),
        );
      } finally {
        if (!persisted && write.kind === "write") write.dispose();
      }
    },
  };

  /** Whether a document's state holds no blocks: a create without overwrite's precondition. */
  function holdsNoBlocks(state: Uint8Array): boolean {
    const doc = docFromState(state);
    try {
      return deps.model.getBlocks(toDocHandle(doc)).length === 0;
    } finally {
      doc.destroy();
    }
  }

  /** The save's links: they spell the saved room and every write's view before it ran. */
  async function saveLinks(
    editScopeId: string,
    doc: SavedDocument,
    after: Y.Doc,
  ): Promise<CommandLinks> {
    const before = doc.updates.map(({ preOwnSnapshot }) => docFromState(preOwnSnapshot));
    try {
      return await openCommandLinks(deps, {
        documentId: doc.docId,
        docs: [after, ...before],
        context: {
          responseIdentity: { providerResponseId: doc.providerResponseId, editScopeId },
          threadId: doc.session.threadId,
        },
      });
    } finally {
      for (const view of before) view.destroy();
    }
  }

  /** What a document's commit detection and sweep read: its writes against their views. */
  function detectionInput(doc: SavedDocument, links: CommandLinks): CommitDetectionInput {
    const first = doc.updates[0];
    const last = doc.updates.at(-1);
    if (!first || !last) throw new Error(`Response document ${doc.docId} has no staged updates.`);
    return {
      docId: doc.docId,
      links,
      preOwnSnapshot: first.preOwnSnapshot,
      interactionContext: doc.interactionContext,
      actor: last.actor,
      ownWrites: doc.updates.map(({ preOwnSnapshot, update }) => ({ preOwnSnapshot, update })),
    };
  }

  /** Each accepted write's receipt with its echo against the view it planned on. */
  function renderedReceipts(
    doc: SavedDocument,
    links: CommandLinks,
    applied: AcceptedMutationReport,
    after: Y.Doc,
  ): ResponseCommitDocumentResult {
    const { lateSweep, revision } = applied;
    if (applied.awarenessDegraded) return degradedReceipts(doc, revision);
    try {
      return {
        documentId: doc.docId,
        updateCount: doc.updates.length,
        receipts: renderSettledReceipts(doc.updates, doc.rejectedUpdates ?? [], revision, () => {
          const rendered = snapshotBlocks(toDocHandle(after), deps.model, links.codec);
          const before = doc.updates.map((entry) => {
            const view = docFromState(entry.preOwnSnapshot);
            try {
              return snapshotBlocks(toDocHandle(view), deps.model, links.codec);
            } finally {
              view.destroy();
            }
          });
          return { before, after: rendered, links, lateSweep };
        }),
        ...(lateSweep ? { lateSweep } : {}),
      };
    } catch {
      return degradedReceipts(doc, revision);
    }
  }

  /**
   * The document's frontier at the save's after-state, in the room the save committed into: it
   * credits what the accepted receipts show in full (none when they are degraded or textless),
   * the blocks holding only their writes' text, and what the last one lists as changed since
   * the model last saw it. A failure is reported and the document goes out without either.
   */
  async function observeSave(
    doc: SavedDocument,
    links: CommandLinks,
    document: ResponseCommitDocumentResult,
    after: Y.Doc,
    room: string,
    recordingFrontier: FrontierLookup,
  ): Promise<ResponseCommitDocumentResult> {
    try {
      const prev = await recordingFrontier(room);
      const accepted = document.receipts.slice(0, doc.updates.length);
      const { frontier, concurrent } = observeRendered(
        {
          doc: after,
          model: deps.model,
          links,
          ownRemoved: new Set(
            doc.updates.flatMap((entry) =>
              entry.deletedBlocks.map((block) => `${block.clientID}:${block.clock}`),
            ),
          ),
          written: doc.updates
            .filter((_, index) => !accepted[index]?.result.awarenessDegraded)
            .map((entry) => entry.update),
        },
        room,
        prev,
        accepted.map((receipt) => receipt.result),
      );
      const last = accepted.at(-1);
      if (!concurrent || !last || last.result.status !== "success")
        return { ...document, frontier };
      // The listing rides on the last receipt, which the host records the frontier with.
      const result = { ...last.result, concurrent };
      const listed = { ...last, result, ...shownEvidence(renderedItems(result), links) };
      return {
        ...document,
        frontier,
        receipts: document.receipts.map((receipt) => (receipt === last ? listed : receipt)),
      };
    } catch (cause) {
      deps.onObservationFailed?.({ documentId: doc.docId, cause });
      return document;
    }
  }
}

/**
 * The one reporting boundary of an accepted save, immediate or a reply's: `run` reads the
 * append's cut, and any failure in it answers `degraded`, never an error. The write is
 * already persisted, so an error here would invite a retry that writes it twice.
 */
async function reportAccepted<T>(
  cut: SaveCut,
  degraded: T,
  run: (before: Y.Doc, after: Y.Doc) => Promise<T>,
): Promise<T> {
  const docs: Y.Doc[] = [];
  try {
    const before = docFromState(cut.beforeState);
    docs.push(before);
    const after = docFromState(cut.afterState);
    docs.push(after);
    return await run(before, after);
  } catch {
    return degraded;
  } finally {
    for (const doc of docs) doc.destroy();
  }
}

/** A prepared save that will not persist: the host drops its write. */
export function discardSave(outcome: SaveOutcome): void {
  if (outcome.write.kind === "write") outcome.write.dispose();
}

/** Receipts that echo nothing: what a save that couldn't read its result still reports. */
export function degradedReceipts(
  doc: Pick<SavedDocument, "docId" | "updates" | "rejectedUpdates">,
  revision: string | null,
  updateCount = doc.updates.length,
): ResponseCommitDocumentResult {
  return {
    documentId: doc.docId,
    updateCount,
    receipts: renderSettledReceipts(
      updateCount ? doc.updates : [],
      doc.rejectedUpdates ?? [],
      revision,
      () => null,
    ),
  };
}

/** How a call reaches the host: a draft-mode call names the thread peer it is bound to. */
export function accessFor(context: InteractionContext | undefined): DocumentAccess | undefined {
  return context?.mode === "threadPeer" && context.peerDraftId
    ? { pinnedDraftId: context.peerDraftId }
    : undefined;
}

export function journalEntries(
  docId: string,
  updates: readonly StagedResponseUpdate[],
): JournalBatchAppendEntry[] {
  return updates.map((entry) => ({
    docId,
    update: entry.update,
    meta: entry.meta,
    mutation: entry.mutation,
  }));
}

/** A write a Discard refused, named by which Discard. */
export function discardedWrite(
  reason: DiscardedWriteReason = "discarded_edit",
): InternalWriteResult {
  return {
    status: "invalid_write",
    model: {
      message: `Write did not land: ${rejectedWriteExplanation(reason)}. Re-read and retry.`,
      rejected: reason,
    },
  };
}

/** A save that refused a write outside a reply: a Discard's named refusal, else the reason. */
function refusedWrite(reason: StagedWriteRejectionReason): InternalWriteResult {
  if (reason.startsWith("discarded_")) return discardedWrite(reason as DiscardedWriteReason);
  return {
    status: "invalid_write",
    model: {
      message: `Write did not land: ${rejectedWriteExplanation(reason)}. Re-read and retry.`,
    },
  };
}

function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  return doc;
}
