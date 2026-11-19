/** Detached historical draft and receipt evidence from one database snapshot. */
import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import type { AttributionPart } from "@meridian/agent-edit/diff";
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
  /** What the part did to the text; null for a part written before deltas. */
  delta: StoredDelta | null;
}

export interface DraftDispositionCapture {
  draft: DraftRead;
  /** Both durable byte fields are explicitly zero-length, not merely a missing checkpoint. */
  contentReleased: boolean;
  userId: string;
  /** Latest first. The kernel receives the owner identity, not the subagent's identity. */
  parts: readonly DraftReceiptPart[];
  /** The draft's Applies in force, oldest first, with the changes of parts each took. */
  applied: readonly { commandId: string; carried: readonly (readonly [number, number])[] }[];
}

export interface DraftDispositionStore {
  /** Historical access only: closed drafts are readable, never admitted for writing here. */
  capture(draftId: string): Promise<DraftDispositionCapture | null>;
  /** `capture` for many drafts from one snapshot, one query per kind of fact; a missing draft is absent. */
  captureAll(draftIds: readonly string[]): Promise<Map<string, DraftDispositionCapture>>;
}
