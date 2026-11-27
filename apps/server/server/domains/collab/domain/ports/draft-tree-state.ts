import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";

export type DraftTreeChange = "created" | "moving" | "deleting";

export type DraftDocumentTree = {
  documentId: DocumentId;
  origin: "created" | "edited";
  isNew: boolean;
  binary: boolean;
  change: DraftTreeChange | null;
  pending: boolean;
  uri: string | null;
  movedFromUri: string | null;
};

export interface DraftTreeStateReader {
  read(
    draftId: DraftId,
    edited?: readonly DocumentId[],
    only?: readonly DocumentId[],
  ): Promise<DraftDocumentTree[]>;
}
