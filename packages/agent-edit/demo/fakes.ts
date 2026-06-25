// In-memory fake server ports for the throwaway agent-edit demo harness.
import {
  type DocumentCoordinator,
  type DocumentLifecycle,
  DocumentNotFoundError,
  type UpdateJournal,
} from "@meridian/agent-edit";
import { InMemoryAgentEditJournal } from "@meridian/agent-edit/test-support";
import * as Y from "yjs";

export class InMemoryJournal extends InMemoryAgentEditJournal {}

const EMPTY_UPDATE_LENGTH = 2;

export class InMemoryCoordinator implements DocumentCoordinator, DocumentLifecycle {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly locks = new Map<string, Promise<void>>();
  private nextClientId = 1000;

  constructor(private readonly journal: UpdateJournal) {}

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    return this.lock(docId, async () => fn(this.getOrCreate(docId)));
  }

  async recover(docId: string): Promise<void> {
    await this.withDocument(docId, async (doc) => {
      const snapshot = await this.journal.read(docId);
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
    });
  }

  async ensureDocument(docId: string): Promise<void> {
    this.getOrCreate(docId);
  }

  requireDocument(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  async applyHumanUpdate(
    docId: string,
    userId: string,
    mutate: (doc: Y.Doc) => void,
  ): Promise<number | null> {
    return this.withDocument(docId, async (doc) => {
      const beforeVector = Y.encodeStateVector(doc);
      doc.transact(() => mutate(doc), { type: "human", userId });
      const update = Y.encodeStateAsUpdate(doc, beforeVector);
      if (!hasYjsUpdate(update)) return null;
      return this.journal.append(docId, update, { origin: `human:${userId}`, seq: 0 });
    });
  }

  private getOrCreate(docId: string): Y.Doc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc({ gc: false });
      doc.clientID = this.nextClientId;
      this.nextClientId += 1;
      this.docs.set(docId, doc);
    }
    return doc;
  }

  private async lock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(docId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(docId, tail);
    tail.finally(() => {
      if (this.locks.get(docId) === tail) this.locks.delete(docId);
    });
    return run;
  }
}

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > EMPTY_UPDATE_LENGTH;
}
