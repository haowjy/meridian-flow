/** Identifies the authority generation that supplied checkpoint bytes. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId } from "@meridian/contracts";

export type CheckpointAuthority = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

export type CheckpointJournal = Omit<UpdateJournal, "checkpoint"> & {
  checkpoint(
    documentId: string,
    state: Uint8Array,
    upToSeq: number,
    authority?: CheckpointAuthority,
  ): Promise<void>;
};
