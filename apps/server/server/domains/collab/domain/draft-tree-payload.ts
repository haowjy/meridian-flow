/**
 * What `applyItems` and the draft tree step say to each other through the settlement seam
 * (contract §11.2): the durable `draft_tree` payload, parsed when it is read back (recovery
 * reads what a crashed process staged), and one codec for the step's refusals and holds,
 * so neither side probes untyped JSON.
 */
import type { DocumentId, DraftId } from "@meridian/contracts";
import type { DraftApplyNote, DraftHeldReason } from "@meridian/contracts/drafts";
import type { JsonValue } from "@meridian/contracts/threads";
import { z } from "zod";
import type { PublicationRefusal } from "./ports/settlement-publication.js";

/** The tree step's payload kind; recovery finds the step by it. */
export const DRAFT_TREE_STEP = "draft_tree";

/** `${DraftId}:${DocumentId}`: one key for every item, text or binary (F12). */
export type DraftItemKey = string;

export function draftItemKey(draftId: DraftId, documentId: DocumentId): DraftItemKey {
  return `${draftId}:${documentId}`;
}

const PayloadItemSchema = z.object({
  itemKey: z.string(),
  documentId: z.string(),
  /** The text member's branch; null for a branchless item (a created image). */
  draftBranchId: z.string().nullable(),
  origin: z.enum(["created", "edited"]),
  /**
   * The tokens the item is published against (§11.3): the writer's render, or the read
   * `applyItems` made when the request carried none. Null: the item has no live text
   * (hidden, deleted, binary) or no branch.
   */
  locationToken: z.string(),
  liveTextToken: z.string().nullable(),
  branchGenerationToken: z.string().nullable(),
});

const PayloadSchema = z.object({
  draftId: z.string(),
  closeWhenEmpty: z.boolean(),
  linkCut: z.object({
    draftId: z.string(),
    branches: z
      .array(z.object({ branchId: z.string(), documentId: z.string(), fingerprint: z.string() }))
      .readonly(),
  }),
  items: z.array(PayloadItemSchema).readonly(),
  holderMeanings: z
    .array(
      z.object({
        holderDocumentId: z.string(),
        refs: z.array(z.object({ aheadId: z.string(), documentId: z.string() })).readonly(),
      }),
    )
    .readonly(),
});

/**
 * The step's durable input, immutable once staged. `items` keeps only the items eligible
 * at the pre-staging check; `holderMeanings` is filled there, with the link cut fenced, so
 * completion and recovery bind from this snapshot (V2-H4).
 */
export type DraftTreePayload = z.infer<typeof PayloadSchema>;
export type DraftTreePayloadItem = DraftTreePayload["items"][number];

/** The staged payload, or null when the batch carries none; throws when it isn't one. */
export function parseDraftTreePayload(payload: JsonValue | undefined): DraftTreePayload | null {
  if (payload === undefined) return null;
  return PayloadSchema.parse(payload);
}

export function encodeDraftTreePayload(payload: DraftTreePayload): JsonValue {
  return payload as unknown as JsonValue;
}

/** How the step refuses a whole batch, as `applyItems` reads it back. */
export type DraftTreeRefusal =
  /** A rendered token moved, or an item is no longer the draft's: these items. */
  | { kind: "stale"; itemKeys: readonly DraftItemKey[] }
  /** The draft closed. */
  | { kind: "gone" }
  /** A branch changed since its links registered (F18): register again. */
  | { kind: "link_cut_changed" };

const StaleDetail = z.object({ itemKeys: z.array(z.string()) });

export const draftTreeRefusal = {
  stale: (itemKeys: readonly DraftItemKey[]): PublicationRefusal => ({
    code: "stale",
    detail: { itemKeys: [...itemKeys] },
  }),
  gone: (): PublicationRefusal => ({ code: "gone" }),
  linkCutChanged: (): PublicationRefusal => ({ code: "link_cut_changed" }),
};

/** The step's refusal, or null for one another step made. */
export function readDraftTreeRefusal(reason: PublicationRefusal): DraftTreeRefusal | null {
  switch (reason.code) {
    case "stale":
      return { kind: "stale", itemKeys: StaleDetail.parse(reason.detail).itemKeys };
    case "gone":
      return { kind: "gone" };
    case "link_cut_changed":
      return { kind: "link_cut_changed" };
    default:
      return null;
  }
}

/** Why an item stays in the draft: 5a, the live path it needs is taken (the wire's type). */
export type HeldReason = DraftHeldReason;

const HoldDetail = z.object({ path: z.string() });

export function draftTreeHold(path: string): PublicationRefusal {
  return { code: "path_taken", detail: { path } };
}

/** The step's hold reason, or null for one another step made. */
export function readDraftTreeHold(reason: PublicationRefusal): HeldReason | null {
  return reason.code === "path_taken"
    ? { code: "path_taken", path: HoldDetail.parse(reason.detail).path }
    : null;
}

/** A receipt note: what completion did to an item beyond publishing its text (§11.2). */
export type ApplyNote = DraftApplyNote;

const NotesDetail = z.object({
  notes: z.array(
    z.discriminatedUnion("code", [
      z.object({ code: z.literal("rename_replaced"), replacedPath: z.string(), path: z.string() }),
      z.object({ code: z.literal("restored"), path: z.string() }),
    ]),
  ),
});

/** An item's notes as the step reports them out of completion. */
export function draftTreeNotes(notes: readonly ApplyNote[]): JsonValue {
  return { notes: notes.map((note) => ({ ...note })) };
}

export function readDraftTreeNotes(detail: JsonValue): ApplyNote[] {
  return NotesDetail.parse(detail).notes;
}
