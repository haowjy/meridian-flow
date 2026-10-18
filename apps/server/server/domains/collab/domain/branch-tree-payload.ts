/**
 * What `applyItems` and the branch tree step say to each other through the settlement seam
 * (contract §11.2): the durable `branch_tree` payload, parsed when it is read back (recovery
 * reads what a crashed process staged), and one codec for the step's refusals and holds,
 * so neither side probes untyped JSON.
 */
import type { BranchId, DocumentId } from "@meridian/contracts";
import type { DraftApplyNote, DraftHeldReason } from "@meridian/contracts/branches";
import type { JsonValue } from "@meridian/contracts/threads";
import { z } from "zod";
import type { ApplyRefusal } from "./ports/settlement-apply.js";

/** The tree step's payload kind; recovery finds the step by it. */
export const BRANCH_TREE_STEP = "branch_tree";

/** `${BranchId}:${DocumentId}`: one key for every item, text or binary (F12). */
export type DraftItemKey = string;

export function draftItemKey(branchId: BranchId, documentId: DocumentId): DraftItemKey {
  return `${branchId}:${documentId}`;
}

const PayloadItemSchema = z.object({
  itemKey: z.string(),
  documentId: z.string(),
  /** The text member's draft; null for an item without a text draft (a created image). */
  draftId: z.string().nullable(),
  origin: z.enum(["created", "edited"]),
  /**
   * The tokens the item is applied against (§11.3): the writer's render, or the read
   * `applyItems` made when the request carried none. Null: the item has no live text
   * (hidden, deleted, binary) or no draft.
   */
  locationToken: z.string(),
  liveTextToken: z.string().nullable(),
  draftGenerationToken: z.string().nullable(),
  /**
   * Per-change Apply: the classes and operations it applied, so completion places exactly
   * those parts and resets a drained item (§4.1). Null for item Apply, which takes the draft.
   */
  selection: z
    .object({
      operationIds: z.array(z.string()).readonly(),
      closureClassIds: z.array(z.string()).readonly(),
    })
    .nullable(),
});

/** How the writer's command is answered once the batch is terminal (§4.5, §4.6). */
const CommandSchema = z.object({
  shape: z.enum(["item", "all", "changes"]),
  /** Every item the command named, in order: a held item leaves `items` but not the answer. */
  itemKeys: z.array(z.string()).readonly(),
});

const PayloadSchema = z.object({
  branchId: z.string(),
  /** Null for an Apply no writer command owns (D40's switch). */
  command: CommandSchema.nullable(),
  items: z.array(PayloadItemSchema).readonly(),
});

/**
 * The step's durable input, immutable once staged. Apply never closes the branch (§2.4).
 * `items` keeps only the items eligible
 * at the pre-staging check, so completion and recovery apply from this snapshot.
 */
export type BranchTreePayload = z.infer<typeof PayloadSchema>;
export type BranchTreePayloadItem = BranchTreePayload["items"][number];

/** The staged payload, or null when the batch carries none; throws when it isn't one. */
export function parseBranchTreePayload(payload: JsonValue | undefined): BranchTreePayload | null {
  if (payload === undefined) return null;
  return PayloadSchema.parse(payload);
}

export function encodeBranchTreePayload(payload: BranchTreePayload): JsonValue {
  return payload as unknown as JsonValue;
}

/** How the step refuses a whole batch, as `applyItems` reads it back. */
export type BranchTreeRefusal =
  /** A rendered token moved, or an item is no longer the branch's: these items. */
  | { kind: "stale"; itemKeys: readonly DraftItemKey[] }
  /** The branch closed. */
  | { kind: "gone" };

const StaleDetail = z.object({ itemKeys: z.array(z.string()) });

export const branchTreeRefusal = {
  stale: (itemKeys: readonly DraftItemKey[]): ApplyRefusal => ({
    code: "stale",
    detail: { itemKeys: [...itemKeys] },
  }),
  gone: (): ApplyRefusal => ({ code: "gone" }),
};

/** The step's refusal, or null for one another step made. */
export function readBranchTreeRefusal(reason: ApplyRefusal): BranchTreeRefusal | null {
  switch (reason.code) {
    case "stale":
      return { kind: "stale", itemKeys: StaleDetail.parse(reason.detail).itemKeys };
    case "gone":
      return { kind: "gone" };
    default:
      return null;
  }
}

/** Why an item stays in the branch: 5a, the live path it needs is taken (the wire's type). */
export type HeldReason = DraftHeldReason;

const HoldDetail = z.object({ path: z.string() });

export function branchTreeHold(path: string): ApplyRefusal {
  return { code: "path_taken", detail: { path } };
}

/** The step's hold reason, or null for one another step made. */
export function readBranchTreeHold(reason: ApplyRefusal): HeldReason | null {
  return reason.code === "path_taken"
    ? { code: "path_taken", path: HoldDetail.parse(reason.detail).path }
    : null;
}

/** A receipt note: what completion did to an item beyond landing its text (§11.2). */
export type ApplyNote = DraftApplyNote;

const NotesDetail = z.object({
  notes: z.array(
    z.discriminatedUnion("code", [z.object({ code: z.literal("restored"), path: z.string() })]),
  ),
});

/** An item's notes as the step reports them out of completion. */
export function branchTreeNotes(notes: readonly ApplyNote[]): JsonValue {
  return { notes: notes.map((note) => ({ ...note })) };
}

export function readBranchTreeNotes(detail: JsonValue): ApplyNote[] {
  return NotesDetail.parse(detail).notes;
}
