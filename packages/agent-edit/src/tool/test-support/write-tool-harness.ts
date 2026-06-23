// Shared in-memory harness for write-tool module integration tests.
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
  RESERVED_CLIENT_ID_MAX,
} from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";

import { mdxCodec } from "../../codec/presets/mdx.js";
import { createAgentEditCore } from "../../index.js";
import { yProsemirrorModel } from "../../model/y-prosemirror.js";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
} from "../../ports/document-coordinator.js";
import type { DocumentLifecycle } from "../../ports/document-lifecycle.js";
import type { UpdateJournal } from "../../ports/update-journal.js";
import { MemoryJournal } from "./recording-journal.js";

export const schema = buildDocumentSchema();
export const codec = mdxCodec({ schema });
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
    retention?: {
      reversalWindowMs?: number;
    };
    createRuntimeDoc?: () => Y.Doc;
  } = {},
) {
  const coordinator = new MemoryCoordinator(initialDocs);
  const lifecycle = new MemoryDocumentLifecycle(coordinator);
  const journal = new MemoryJournal();
  coordinator.useJournal(journal);
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const core = createAgentEditCore({
    journal,
    coordinator,
    ...(options.lifecycle === false ? {} : { lifecycle }),
    codec,
    model,
    undoClientId: options.undoClientId,
    ...(options.createRuntimeDoc ? { createRuntimeDoc: options.createRuntimeDoc } : {}),
    ...(options.retention ? { retention: options.retention } : {}),
  });
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
