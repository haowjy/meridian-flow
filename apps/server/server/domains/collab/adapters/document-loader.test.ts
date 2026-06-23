/** Tests for rebuilding Y.Doc state from the UpdateJournal. */

import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  PersistedUpdate,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadDocumentState } from "./document-loader.js";

const DOC_ID = "doc.md";

class MemoryJournal implements UpdateJournal {
  private checkpointState: Uint8Array | null = null;
  private checkpointUpToSeq = 0;
  private readonly updates: PersistedUpdate[] = [];

  async append(_docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    const seq = this.updates.length + 1;
    this.updates.push({ seq, update, meta: { ...meta, seq } });
    return seq;
  }

  async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    return entries.map((entry) => {
      const seq = this.updates.length + 1;
      this.updates.push({ seq, update: entry.update, meta: { ...entry.meta, seq } });
      return { seq };
    });
  }

  async latestActiveTurn(): Promise<string | undefined> {
    return undefined;
  }

  async activeTurnSummary() {
    return [];
  }

  async turnMinCreatedSeq(): Promise<number | undefined> {
    return undefined;
  }

  async read() {
    return {
      checkpoint: this.checkpointState,
      updates: this.updates.filter((update) => update.seq > this.checkpointUpToSeq),
    };
  }

  async checkpoint(_docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
    this.checkpointState = state;
    this.checkpointUpToSeq = upToSeq;
  }

  async compact() {
    return { updatesFolded: 0, reversalsExpired: 0 };
  }

  async persistReversal(): Promise<void> {}

  async persistRedo() {
    return { consumed: false };
  }

  async readReversals() {
    return [];
  }
}

describe("loadDocumentState", () => {
  it("returns null when the journal has no checkpoint or updates", async () => {
    await expect(loadDocumentState(new MemoryJournal(), DOC_ID)).resolves.toBeNull();
  });

  it("rebuilds state from checkpoint plus ordered updates", async () => {
    const journal = new MemoryJournal();
    const source = new Y.Doc({ gc: false });
    source.getText("body").insert(0, "Alpha");
    await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(source), 0);

    const before = Y.encodeStateVector(source);
    source.getText("body").insert(5, " Beta");
    await journal.append(DOC_ID, Y.encodeStateAsUpdate(source, before), {
      origin: "agent:turn-a",
      actorTurnId: "turn-a",
      seq: 0,
    });

    const state = await loadDocumentState(journal, DOC_ID);
    expect(state).toBeInstanceOf(Uint8Array);
    if (!state) throw new Error("expected rebuilt document state");

    const rebuilt = new Y.Doc({ gc: false });
    Y.applyUpdate(rebuilt, state);
    expect(rebuilt.getText("body").toString()).toBe("Alpha Beta");
  });
});
