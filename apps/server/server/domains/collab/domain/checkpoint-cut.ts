/** Opaque checkpoint coverage minted only by the trusted journal adapters. */
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";

declare const capturedJournalCut: unique symbol;

export type CapturedCheckpointCut = {
  readonly [capturedJournalCut]: true;
  readonly documentId: string;
  readonly authority: Readonly<CheckpointAuthority>;
  readonly upToSeq: number;
  materializeState(): Promise<Uint8Array>;
};
