/** Detached historical draft and receipt evidence from one database snapshot. */
import type { AttributionPart, ItemRange, Provenance } from "@meridian/agent-edit/diff";
import type { EditOrigin } from "@meridian/contracts";
import type { DraftRead } from "../draft-store.js";

export interface OwnerThread {
  threadId: string;
  title: string;
  reveal: { threadId: string; turnId: string; toolCallId?: string; subagentThreadId?: string };
}

export interface DraftReceiptPart extends AttributionPart {
  id: number;
  editId: string;
  ordinal: number;
  origin: EditOrigin;
  owner: OwnerThread | null;
}

export interface WriterReceipt {
  userId: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}

export interface DraftProvenance extends Provenance {
  /** Apply evidence only; a non-applied part may ultimately be discarded. Use view.parts[].disposition. */
  parts: readonly (DraftReceiptPart & { status: "pending" | "applied" })[];
  writers?: readonly WriterReceipt[];
}

export interface DraftDispositionCapture {
  draft: DraftRead;
  /** Both durable byte fields are explicitly zero-length, not merely a missing checkpoint. */
  contentReleased: boolean;
  userId: string;
  /** Latest first. The kernel receives the owner identity, not the subagent's identity. */
  parts: readonly DraftReceiptPart[];
  writers?: readonly WriterReceipt[];
}

export interface DraftDispositionStore {
  /** Historical access only: closed drafts are readable, never admitted for writing here. */
  capture(
    draftId: string,
    options?: { writerRanges?: readonly ItemRange[] },
  ): Promise<DraftDispositionCapture | null>;
}
