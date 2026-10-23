// One document's save through its host: prepare, persist (the durable append and its cut), then
// the accepted save's report (revision, receipts, frontier), which never fails the save.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { FrontierLookup } from "../frontier.js";
import { toDocHandle } from "../handles.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import { type BlockItemId, type BlockOriginMap, bindBlockOrigins } from "../model/block-hash.js";
import {
  type DocumentAccess,
  type DocumentCoordinator,
  type RetiredWriteReason,
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
import type { CopySummary } from "./copy-receipt.js";
import type { InternalWriteResult } from "./internal-result.js";
import { type ListingSource, loadConcurrent, observeRendered } from "./observation.js";
import { rejectedWriteResult, renderSettledReceipts } from "./receipt.js";
import type {
  DocumentCommandName,
  InteractionContext,
  MutationActor,
  ResponseCommitDocumentResult,
} from "./types.js";
import type { ObservationFailedDetail } from "./write-deps.js";

/** One staged write of a reply, as its save keeps or refuses it and its receipt renders it. */
export type JournaledUpdate = Pick<JournalBatchAppendEntry, "update" | "meta" | "mutation">;

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
  blockOrigins?: BlockOriginMap;
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
  position?: number;
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
  persist(save: SaveOutcome): Promise<SaveCut | null>;
  /**
   * The saved document's receipts, after its save handed its write to the host: the save's
   * verdict on `doc` (the commit's snapshot), then revision reporting on `cut` (what
   * `persist` resolved), then the frontier it records. Never throws: past persistence any failure
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
  model: AgentEditModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinksPort;
  onObservationFailed?: (event: ObservationFailedDetail) => void;
}): DocumentSave {
  const { coordinator } = deps;

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
        ...(saved.blockOrigins ? { blockOrigins: saved.blockOrigins } : {}),
      };
      if (saved.write.kind === "no-effect" && outcome.updates.length) {
        discardSave(outcome);
        throw new Error(`Host reported no effect for kept writes on ${doc.docId}`);
      }
      return outcome;
    },

    async persist(save) {
      const cut = save.write.kind === "write" ? await save.write.persist() : null;
      return cut;
    },

    async report(editScopeId, doc, save, cut, recordingFrontier) {
      // The snapshot takes the save's verdict; the staged buffer keeps its own until close.
      doc.updates = save.updates;
      doc.rejectedUpdates = [...(doc.rejectedUpdates ?? []), ...save.rejected];
      if (!doc.updates.length) return degradedReceipts(doc, null, 0);
      if (!cut) return degradedReceipts(doc, null);
      return reportAccepted(cut, degradedReceipts(doc, null), save.blockOrigins, async (after) => {
        const links = await saveLinks(editScopeId, doc, after, save.blockOrigins);
        const applied = reportRevision(after, links, deps.links);
        const document = renderedReceipts(doc, links, applied, after, save.blockOrigins);
        return save.room && recordingFrontier
          ? await observeSave(doc, links, document, after, cut, save.room, recordingFrontier)
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
          saved.blockOrigins,
          async (after) => ({
            ...reportRevision(after, input.links, deps.links),
            afterState: cut.afterState,
            ...(cut.position === undefined ? {} : { position: cut.position }),
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
    blockOrigins?: BlockOriginMap,
  ): Promise<CommandLinks> {
    const before = doc.updates.map(({ preOwnSnapshot }) =>
      docFromState(preOwnSnapshot, blockOrigins),
    );
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

  /** Each accepted write's receipt with its echo against the view it planned on. */
  function renderedReceipts(
    doc: SavedDocument,
    links: CommandLinks,
    applied: AcceptedMutationReport,
    after: Y.Doc,
    blockOrigins?: BlockOriginMap,
  ): ResponseCommitDocumentResult {
    const { revision } = applied;
    if (applied.awarenessDegraded) return degradedReceipts(doc, revision);
    try {
      return {
        documentId: doc.docId,
        updateCount: doc.updates.length,
        receipts: renderSettledReceipts(doc.updates, doc.rejectedUpdates ?? [], revision, () => {
          const rendered = snapshotBlocks(toDocHandle(after), deps.model, links.codec);
          const before = doc.updates.map((entry) => {
            const view = docFromState(entry.preOwnSnapshot, blockOrigins);
            try {
              return snapshotBlocks(toDocHandle(view), deps.model, links.codec);
            } finally {
              view.destroy();
            }
          });
          return { before, after: rendered, links };
        }),
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
    cut: SaveCut,
    room: string,
    recordingFrontier: FrontierLookup,
  ): Promise<ResponseCommitDocumentResult> {
    try {
      const accepted = document.receipts.slice(0, doc.updates.length);
      const reportUpdates = coordinator.concurrentUpdatesForReport;
      const source: ListingSource = {
        doc: after,
        model: deps.model,
        links,
        ...(cut.position === undefined ? {} : { position: cut.position }),
        ownRemoved: new Set(
          doc.updates.flatMap((entry) =>
            entry.deletedBlocks.map((block) => `${block.clientID}:${block.clock}`),
          ),
        ),
        ownUpdates: doc.updates.map((entry) => entry.update),
        written: doc.updates
          .filter((_, index) => !accepted[index]?.result.awarenessDegraded)
          .map((entry) => entry.update),
        ownActorTurnIds: new Set(doc.updates.map((entry) => entry.actor.turnId)),
        ...(reportUpdates
          ? {
              loadConcurrent: ({ baseline, after: afterPosition, through, attributionBridge }) =>
                reportUpdates({
                  docId: doc.docId,
                  doc: after,
                  baselineDoc: baseline,
                  after: afterPosition,
                  through,
                  ...(attributionBridge ? { attributionBridge } : {}),
                  access: accessFor(doc.interactionContext),
                }),
            }
          : {}),
      };
      const prev = await recordingFrontier(room);
      const updates = await loadConcurrent(source, prev);
      const { frontier, concurrent } = observeRendered(
        updates ? { ...source, concurrent: updates } : source,
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
  blockOrigins: BlockOriginMap | undefined,
  run: (after: Y.Doc) => Promise<T>,
): Promise<T> {
  let after: Y.Doc | undefined;
  try {
    after = docFromState(cut.afterState, blockOrigins);
    return await run(after);
  } catch {
    return degraded;
  } finally {
    after?.destroy();
  }
}

interface AcceptedMutationReport {
  revision: string | null;
  /** Revision reporting failed after persistence; the save itself still landed. */
  awarenessDegraded?: true;
}

function reportRevision(
  after: Y.Doc,
  links: CommandLinks,
  port: DocumentLinksPort,
): AcceptedMutationReport {
  try {
    return { revision: port.revision(after, links.scope) };
  } catch {
    return { revision: null, awarenessDegraded: true };
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

/** A retirement refusal uses the same record and copy as a settled receipt. */
export function discardedWrite(reason: RetiredWriteReason = "discarded_edit"): InternalWriteResult {
  return rejectedWriteResult(reason);
}

function refusedWrite(reason: StagedWriteRejectionReason): InternalWriteResult {
  return rejectedWriteResult(reason);
}

function docFromState(state: Uint8Array, blockOrigins?: BlockOriginMap): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  if (blockOrigins) bindBlockOrigins(doc, blockOrigins);
  return doc;
}
