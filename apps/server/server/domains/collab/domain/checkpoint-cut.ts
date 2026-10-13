/** Nominal checkpoint capability minted and resolved only by trusted journal adapters. */
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";

export declare class CapturedCheckpointCut {
  private constructor();
  private readonly capturedJournalCut: true;
  readonly documentId: string;
  readonly authority: Readonly<CheckpointAuthority>;
  readonly upToSeq: number;
  materializeState(): Promise<Uint8Array>;
}
