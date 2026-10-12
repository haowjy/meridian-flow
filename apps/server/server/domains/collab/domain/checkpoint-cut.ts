/** A checkpoint's inseparable bytes and coverage, folded from a durable journal cut. */
import type { PersistedUpdate } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";

export class CapturedCheckpointCut {
  private constructor(
    readonly documentId: string,
    readonly authority: Readonly<CheckpointAuthority>,
    private readonly bytes: Uint8Array,
    readonly upToSeq: number,
  ) {}

  get state(): Uint8Array {
    return this.bytes.slice();
  }

  /** The adapter holds the mutation lock while reading this generation's base and suffix. */
  static fromJournal(
    documentId: string,
    authority: CheckpointAuthority,
    checkpoint: { state: Uint8Array; upToSeq: number } | null,
    updates: readonly Pick<PersistedUpdate, "seq" | "update">[],
  ): CapturedCheckpointCut {
    const doc = createCollabYDoc({ gc: false });
    try {
      let upToSeq = checkpoint?.upToSeq ?? 0;
      if (checkpoint) Y.applyUpdate(doc, checkpoint.state);
      for (const row of updates) {
        Y.applyUpdate(doc, row.update);
        upToSeq = Math.max(upToSeq, row.seq);
      }
      // An incomplete Yjs dependency chain must remain replayable, not become a floor.
      if (doc.store.pendingStructs || doc.store.pendingDs) {
        throw new Error("Cannot checkpoint unresolved Yjs journal dependencies");
      }
      const cut = new CapturedCheckpointCut(
        documentId,
        Object.freeze({ ...authority }),
        Y.encodeStateAsUpdate(doc),
        upToSeq,
      );
      Object.freeze(cut);
      return cut;
    } finally {
      doc.destroy();
    }
  }
}
