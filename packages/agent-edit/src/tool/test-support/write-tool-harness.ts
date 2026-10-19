// Shared in-memory harness for write-tool module integration tests.

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { createAgentEditCodecFactory } from "../../codec-adapter.js";
import { createAgentEditCore } from "../../index.js";
import { yProsemirrorModel } from "../../model/y-prosemirror.js";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type RoomRead,
  type SavePrecondition,
  SavePreconditionRefused,
  type StagedRoomEntries,
  type StagedWriteSaveResult,
} from "../../ports/document-coordinator.js";
import type { DocumentLinksPort } from "../../ports/document-links.js";
import type { AgentEditModel } from "../../ports/model.js";
import type { SemanticProvenanceWriter } from "../../ports/semantic-provenance.js";
import { createStaticDocumentLinks } from "../../ports/static-document-links.js";
import type { UpdateJournal } from "../../ports/update-journal.js";
import { MemoryJournal } from "./recording-journal.js";

export const schema = buildDocumentSchema();
export const codecFactory = createAgentEditCodecFactory(mdxCodec({ schema }));
/** Scoped to no tree: stored hrefs and `asset:` refs spell as stored. */
export const codec = codecFactory.forScope(UNSCOPED_DOCUMENT_LINKS);
export const model = yProsemirrorModel(schema);
export const THREAD_ID = "thread-a";
export const context = { sessionId: "session-a", threadId: THREAD_ID };
const FIRST_FAKE_LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;

export function harness(
  initialDocs: Record<string, string> = {},
  options: {
    onResponseLifecycleError?: Parameters<
      typeof createAgentEditCore
    >[0]["onResponseLifecycleError"];
    onResponseClaimDiscarded?: Parameters<
      typeof createAgentEditCore
    >[0]["onResponseClaimDiscarded"];
    onResponseCommitterTransition?: Parameters<
      typeof createAgentEditCore
    >[0]["onResponseCommitterTransition"];
    onIdempotencyHit?: Parameters<typeof createAgentEditCore>[0]["onIdempotencyHit"];
    onUnexpectedWriteError?: Parameters<typeof createAgentEditCore>[0]["onUnexpectedWriteError"];
    closedResponseTombstoneCap?: Parameters<
      typeof createAgentEditCore
    >[0]["closedResponseTombstoneCap"];
    journalOverride?: (journal: MemoryJournal) => UpdateJournal;
    model?: AgentEditModel;
    semanticProvenance?: SemanticProvenanceWriter;
    links?: DocumentLinksPort;
    onLinkSpliceFallback?: Parameters<typeof createAgentEditCore>[0]["onLinkSpliceFallback"];
  } = {},
) {
  const agentEditModel = options.model ?? model;
  const coordinator = new MemoryCoordinator(initialDocs);
  const journal = new MemoryJournal();
  coordinator.useJournal(journal);
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const rawCore = createAgentEditCore({
    journal: options.journalOverride?.(journal) ?? journal,
    coordinator,
    codec: codecFactory,
    links: options.links ?? createStaticDocumentLinks(),
    model: agentEditModel,
    semanticProvenance: options.semanticProvenance,
    ...(options.onResponseLifecycleError
      ? { onResponseLifecycleError: options.onResponseLifecycleError }
      : {}),
    ...(options.onResponseClaimDiscarded
      ? { onResponseClaimDiscarded: options.onResponseClaimDiscarded }
      : {}),
    ...(options.onResponseCommitterTransition
      ? { onResponseCommitterTransition: options.onResponseCommitterTransition }
      : {}),
    ...(options.onIdempotencyHit ? { onIdempotencyHit: options.onIdempotencyHit } : {}),
    ...(options.onUnexpectedWriteError
      ? { onUnexpectedWriteError: options.onUnexpectedWriteError }
      : {}),
    ...(options.closedResponseTombstoneCap !== undefined
      ? { closedResponseTombstoneCap: options.closedResponseTombstoneCap }
      : {}),
    ...(options.onLinkSpliceFallback ? { onLinkSpliceFallback: options.onLinkSpliceFallback } : {}),
  });
  const core = {
    ...rawCore,
    write(
      command: Parameters<typeof rawCore.write>[0],
      writeContext: Parameters<typeof rawCore.write>[1] = {},
    ) {
      if ((command.command === "undo" || command.command === "redo") && !writeContext.actor) {
        return rawCore.write(command, {
          ...writeContext,
          actor: {
            kind: "agent",
            turnId: writeContext.turnId ?? "test-reversal",
            threadId: writeContext.threadId ?? THREAD_ID,
            responseId: "test-observed-response",
          },
        });
      }
      // The host materializes a create's document before the command runs (`ensureTrackedDocument`).
      if (command.command === "create" || command.command === "copy")
        coordinator.ensureEmpty(command.documentId ?? command.file);
      return rawCore.write(command, writeContext);
    },
  };
  return {
    core,
    coordinator,
    journal,
    liveDoc: (docId: string) => coordinator.require(docId),
  };
}

export class MemoryCoordinator implements DocumentCoordinator {
  resolveRevertSource: DocumentCoordinator["resolveRevertSource"] = async () => ({
    refusal: "invalid_write",
  });
  readonly docs = new Map<string, Y.Doc>();
  concurrentUpdatesSince?: DocumentCoordinator["concurrentUpdatesSince"];
  private journal?: UpdateJournal;
  private failure: unknown;
  private nextFailure: unknown;
  private readonly nextFailureByDoc = new Map<string, unknown>();

  constructor(initialDocs: Record<string, string>) {
    for (const [docId, markdown] of Object.entries(initialDocs)) {
      this.docs.set(docId, createDoc(markdown, FIRST_FAKE_LIVE_CLIENT_ID + this.docs.size));
    }
  }

  createEmpty(docId: string): Y.Doc {
    return this.ensureEmpty(docId);
  }

  ensureEmpty(docId: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing) return existing;
    const doc = new Y.Doc({ gc: false });
    doc.clientID = FIRST_FAKE_LIVE_CLIENT_ID + this.docs.size;
    this.docs.set(docId, doc);
    return doc;
  }

  require(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  failWith(cause: unknown): void {
    this.failure = cause;
  }

  failNextWith(cause: unknown): void {
    this.nextFailure = cause;
  }

  failNextForDoc(docId: string, cause: unknown): void {
    this.nextFailureByDoc.set(docId, cause);
  }

  useJournal(journal: UpdateJournal): void {
    this.journal = journal;
  }

  /** The armed failure for a save of `docId`, taken once when it is a next-failure. */
  private takeFailure(docId: string): unknown {
    if (this.nextFailureByDoc.has(docId)) {
      const failure = this.nextFailureByDoc.get(docId);
      this.nextFailureByDoc.delete(docId);
      return failure;
    }
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      return failure;
    }
    return this.failure;
  }

  /**
   * A live save: every entry kept, appended to the journal as one batch by `persist` (which
   * judges the precondition on, and resolves, the cut the append followed: the room as it is
   * then), and delivered to the in-memory room at `transfer`. A missing document saves onto an
   * empty one.
   */
  async prepareSave(
    input: StagedRoomEntries & { docId: string; precondition?: SavePrecondition },
  ): Promise<StagedWriteSaveResult> {
    const failure = this.takeFailure(input.docId);
    if (failure) throw failure;
    const doc = this.docs.has(input.docId)
      ? (await this.readRoom(input.docId, null)).doc
      : new Y.Doc({ gc: false });
    let prepared: Uint8Array;
    try {
      prepared = Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
    const result = {
      kept: input.entries.flatMap((entry) =>
        entry.mutation?.writeId ? [entry.mutation.writeId] : [],
      ),
      rejected: [],
      room: this.docs.has(input.docId) ? `memory:${input.docId}` : null,
    };
    if (!input.entries.length) return { ...result, write: { kind: "no-effect" } };
    return {
      ...result,
      write: {
        kind: "write",
        persist: async () => {
          const cut = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(cut, prepared);
            const room = this.docs.get(input.docId);
            if (room) Y.applyUpdate(cut, Y.encodeStateAsUpdate(room));
            const beforeState = Y.encodeStateAsUpdate(cut);
            if (input.precondition && !input.precondition(beforeState))
              throw new SavePreconditionRefused(input.docId);
            await this.journal?.appendBatch(input.entries);
            for (const entry of input.entries) Y.applyUpdate(cut, entry.update);
            return { beforeState, afterState: Y.encodeStateAsUpdate(cut) };
          } finally {
            cut.destroy();
          }
        },
        // The room catches up in one apply, as a live room's recovery does.
        transfer: () => {
          Y.applyUpdate(
            this.ensureEmpty(input.docId),
            Y.mergeUpdates(input.entries.map((entry) => entry.update)),
          );
        },
        dispose: () => {},
      },
    };
  }

  /**
   * A copy of the in-memory document caught up from the journal (as a live room behind a
   * failed projection is), with the staged entries applied in order.
   */
  async readRoom(docId: string, staged: StagedRoomEntries | null): Promise<RoomRead> {
    if (this.failure) throw this.failure;
    const doc = cloneDoc(this.require(docId));
    const committed = await this.journal?.read(docId);
    if (committed?.checkpoint) Y.applyUpdate(doc, committed.checkpoint);
    for (const entry of committed?.updates ?? []) Y.applyUpdate(doc, entry.update);
    for (const entry of staged?.entries ?? []) Y.applyUpdate(doc, entry.update);
    return {
      doc,
      room: `memory:${docId}`,
      generation: 0,
      kept: (staged?.entries ?? []).flatMap((entry) =>
        entry.mutation?.writeId ? [entry.mutation.writeId] : [],
      ),
      rejected: [],
    };
  }
}

export function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const root = schema.node("doc", null, codec.parse(markdown).blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

export function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

export type WriteToolHarness = ReturnType<typeof harness>;
