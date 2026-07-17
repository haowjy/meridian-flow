// Shared in-memory harness for write-tool module integration tests.

import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { snapshotBlocks } from "../../apply/echo.js";
import { createAgentEditCodec } from "../../codec-adapter.js";
import { toDocHandle } from "../../handles.js";
import { createAgentEditCore, type ReversalNoticePort } from "../../index.js";
import { yProsemirrorModel } from "../../model/y-prosemirror.js";
import { digestRenderedContent } from "../../observation-snapshot.js";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
} from "../../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../../ports/document-lifecycle.js";
import type { ObservationSnapshotStore } from "../../ports/observation-snapshot.js";
import type { ReversalStore, UpdateJournal } from "../../ports/update-journal.js";
import { MemoryJournal } from "./recording-journal.js";

export const schema = buildDocumentSchema();
export const codec = createAgentEditCodec(
  mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
);
export const model = yProsemirrorModel(schema);
export const THREAD_ID = "thread-a";
export const context = { sessionId: "session-a", threadId: THREAD_ID };
export const REVERSAL_CLIENT_ID = AGENT_EDIT_UNDO_CLIENT_ID;
const FIRST_FAKE_LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;

export function harness(
  initialDocs: Record<string, string> = {},
  options: {
    lifecycle?: boolean;
    undoClientId?: number;
    createRuntimeDoc?: () => Y.Doc;
    reversalNoticePort?: ReversalNoticePort;
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
    onReversalNoticeFailed?: Parameters<typeof createAgentEditCore>[0]["onReversalNoticeFailed"];
    closedResponseTombstoneCap?: Parameters<
      typeof createAgentEditCore
    >[0]["closedResponseTombstoneCap"];
    afterResponsePreflight?: Parameters<typeof createAgentEditCore>[0]["afterResponsePreflight"];
    journalOverride?: (journal: MemoryJournal) => UpdateJournal & ReversalStore;
    observationSnapshots?: ObservationSnapshotStore;
  } = {},
) {
  const coordinator = new MemoryCoordinator(initialDocs);
  const lifecycle = new MemoryDocumentLifecycle(coordinator);
  const journal = new MemoryJournal();
  coordinator.useJournal(journal);
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const initialObservationEntries = [...coordinator.docs].flatMap(([documentId, doc]) =>
    snapshotBlocks(toDocHandle(doc), model, codec).map((block) => ({
      documentId,
      clientID: block.clientID as number,
      clock: block.clock as number,
      value: {
        kind: "rendered" as const,
        digest: digestRenderedContent(block.renderedContent as string),
      },
    })),
  );
  const observationSnapshots: ObservationSnapshotStore = options.observationSnapshots ?? {
    async seal() {},
    async load(responseId) {
      const entries =
        responseId === "test-observed-response"
          ? [...coordinator.docs].flatMap(([documentId, doc]) =>
              snapshotBlocks(toDocHandle(doc), model, codec).map((block) => ({
                documentId,
                clientID: block.clientID as number,
                clock: block.clock as number,
                value: {
                  kind: "rendered" as const,
                  digest: digestRenderedContent(block.renderedContent as string),
                },
              })),
            )
          : initialObservationEntries;
      return { responseId, entries };
    },
  };
  const rawCore = createAgentEditCore({
    journal: options.journalOverride?.(journal) ?? journal,
    coordinator,
    ...(options.lifecycle === false ? {} : { lifecycle }),
    codec,
    model,
    observationSnapshots,
    undoClientId: options.undoClientId,
    ...(options.createRuntimeDoc ? { createRuntimeDoc: options.createRuntimeDoc } : {}),
    ...(options.reversalNoticePort ? { reversalNoticePort: options.reversalNoticePort } : {}),
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
    ...(options.onReversalNoticeFailed
      ? { onReversalNoticeFailed: options.onReversalNoticeFailed }
      : {}),
    ...(options.closedResponseTombstoneCap !== undefined
      ? { closedResponseTombstoneCap: options.closedResponseTombstoneCap }
      : {}),
    ...(options.afterResponsePreflight
      ? { afterResponsePreflight: options.afterResponsePreflight }
      : {}),
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
      return rawCore.write(command, writeContext);
    },
    reverse(input: Parameters<typeof rawCore.reverse>[0]) {
      return rawCore.reverse({
        ...input,
        actor:
          input.actor.type === "agent" && !("responseId" in input.actor)
            ? { ...input.actor, responseId: "test-observed-response" }
            : input.actor,
      });
    },
  };
  return {
    core,
    coordinator,
    lifecycle,
    journal,
    liveDoc: (docId: string) => coordinator.require(docId),
  };
}

export class MemoryDocumentLifecycle implements DocumentLifecycle {
  constructor(private readonly coordinator: MemoryCoordinator) {}

  async ensureDocument(docId: string): Promise<void> {
    this.coordinator.ensureEmpty(docId);
  }
}

export class MemoryCoordinator implements DocumentCoordinator {
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

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    if (this.nextFailureByDoc.has(docId)) {
      const failure = this.nextFailureByDoc.get(docId);
      this.nextFailureByDoc.delete(docId);
      throw failure;
    }
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      throw failure;
    }
    if (this.failure) throw this.failure;
    return fn(this.require(docId));
  }

  async recover(docId: string): Promise<void> {
    if (!this.journal) return;
    const snapshot = await this.journal.read(docId);
    if (!snapshot.checkpoint && snapshot.updates.length === 0) return;
    const doc = this.ensureEmpty(docId);
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint, { type: "system" });
    for (const entry of snapshot.updates) {
      Y.applyUpdate(doc, entry.update, { type: "system" });
    }
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
