/** Shared wire contracts for durable change-trail evidence. */

import { z } from "zod";

const yjsIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Stable Yjs block identity. Display hashlines are deliberately excluded. */
export type CanonicalBlockIdentityV1 = {
  documentId: string;
  clientID: number;
  clock: number;
};

export type NavigationTargetV1 =
  | {
      kind: "live_block_range";
      relStart: string;
      relEnd: string;
      targetBlockId: { clientID: number; clock: number };
    }
  | {
      kind: "deletion_boundary";
      position: string;
      affinity: "before_next" | "after_previous" | "document_start";
    }
  | { kind: "unavailable"; reason: string };

export type TrailChangeV1 = {
  changeId: string;
  ordinal: number;
  documentId: string | null;
  pushId: string | null;
  receiptId: string | null;
  kind: "insert" | "modify" | "delete";
  beforeBlockIdentity: CanonicalBlockIdentityV1 | null;
  afterBlockIdentity: CanonicalBlockIdentityV1 | null;
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  navigation: NavigationTargetV1;
};

export type ChangeTrailShellV1 = {
  trailId: string;
  owner:
    | { kind: "turn"; threadId: string; turnId: string }
    | { kind: "shared"; threadId: string; turnId: null };
  state: "building" | "settling" | "settled";
  version: number;
  changeCount: number;
  documentCount: number;
  documents: Array<{ documentId: string; title: string }>;
  wordsAdded: number | null;
  wordsRemoved: number | null;
  updatedAt: string;
  settledAt: string | null;
};

export type ChangeTrailDocumentDetailV1 =
  | {
      documentId: string;
      unavailable: true;
    }
  | {
      trailId: string;
      documentId: string;
      documentTitle: string;
      wordsAdded: number | null;
      wordsRemoved: number | null;
      changes: TrailChangeV1[];
      /** Retained evidence stays readable after its authorized live anchor is deleted. */
      anchorState: "available" | "deleted";
    };

export type ChangeTrailDetailResponseV1 = {
  version: 1;
  trailId: string;
  documents: ChangeTrailDocumentDetailV1[];
};

export const canonicalBlockIdentityV1Schema: z.ZodType<CanonicalBlockIdentityV1> = z.object({
  documentId: z.string(),
  clientID: yjsIntegerSchema,
  clock: yjsIntegerSchema,
});

export const navigationTargetV1Schema: z.ZodType<NavigationTargetV1> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("live_block_range"),
      relStart: z.string(),
      relEnd: z.string(),
      targetBlockId: z.object({ clientID: yjsIntegerSchema, clock: yjsIntegerSchema }),
    }),
    z.object({
      kind: z.literal("deletion_boundary"),
      position: z.string(),
      affinity: z.enum(["before_next", "after_previous", "document_start"]),
    }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  ],
);

export const trailChangeV1Schema = z.object({
  changeId: z.string(),
  ordinal: z.number().int(),
  documentId: z.string().nullable(),
  pushId: z.string().nullable(),
  receiptId: z.string().nullable(),
  kind: z.enum(["insert", "modify", "delete"]),
  beforeBlockIdentity: canonicalBlockIdentityV1Schema.nullable(),
  afterBlockIdentity: canonicalBlockIdentityV1Schema.nullable(),
  beforeText: z.string().nullable(),
  afterTextAtReceipt: z.string().nullable(),
  navigation: navigationTargetV1Schema,
}) satisfies z.ZodType<TrailChangeV1>;

export const changeTrailShellV1Schema: z.ZodType<ChangeTrailShellV1> = z.object({
  trailId: z.string(),
  owner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("turn"), threadId: z.string(), turnId: z.string() }),
    z.object({ kind: z.literal("shared"), threadId: z.string(), turnId: z.null() }),
  ]),
  state: z.enum(["building", "settling", "settled"]),
  version: z.number().int(),
  changeCount: z.number().int(),
  documentCount: z.number().int(),
  documents: z.array(z.object({ documentId: z.string(), title: z.string() })),
  wordsAdded: z.number().int().nullable(),
  wordsRemoved: z.number().int().nullable(),
  updatedAt: z.string(),
  settledAt: z.string().nullable(),
});

/** Fails closed when durable JSON no longer matches the trail wire model. */
export function parseTrailChangesV1(value: unknown): TrailChangeV1[] {
  const result = z.array(trailChangeV1Schema).safeParse(value);
  if (!result.success) {
    throw new Error(`Corrupt change-trail detail: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
