/** Identifies the authority generation that supplied checkpoint bytes. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId } from "@meridian/contracts";
import type { CapturedCheckpointCut } from "../checkpoint-cut.js";

export type CheckpointAuthority = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

export type CheckpointJournal = UpdateJournal & {
  captureCheckpoint(
    documentId: string,
    authority: CheckpointAuthority,
  ): Promise<CapturedCheckpointCut | null>;
  storeCheckpoint(cut: CapturedCheckpointCut): Promise<void>;
};
