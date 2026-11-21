/** Nominal checkpoint capability minted and resolved only by trusted journal adapters. */
import type * as Y from "yjs";
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";

export declare class CapturedCheckpointCut {
  private constructor();
  private readonly capturedJournalCut: true;
  readonly documentId: string;
  readonly authority: Readonly<CheckpointAuthority>;
  readonly upToSeq: number;
  materializeState(): Promise<Uint8Array>;
  /** The stored history's shape, once the state is materialized. */
  history(): Promise<{ bytes: number; structs: number; contentBytes: number }>;
  /**
   * Drops `document`'s deleted content the way the stored state did. For the room's own document
   * once its checkpoint is stored: the room then copies and walks no more than a cold load would.
   */
  dropUnseenContent(document: Y.Doc): Promise<void>;
}
