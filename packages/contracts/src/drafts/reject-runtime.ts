/** Wire artifacts used by the client-side reject reconstruction runtime. */

export interface DraftJournalUpdateWire {
  seq: number;
  update: string;
}

export interface DraftJournalResponse {
  draftId: string;
  draftRevisionToken: number;
  checkpoint: string | null;
  updates: DraftJournalUpdateWire[];
}

export type WIdRange = { min: number; max: number };
