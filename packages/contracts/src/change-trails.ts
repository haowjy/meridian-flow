/** Shared wire contracts for durable change trails and their forward actions. */

import { z } from "zod";

export type TrailForwardAction = "restore" | "delete-again";

export type TrailForwardActionStateV1 =
  | {
      status: "committed";
      update: string;
      expectedLiveStateHash: string;
    }
  | { status: "applied"; updateId: number }
  | {
      status: "settled";
      outcome: "anchor_unavailable" | "retry_exhausted";
    };

export type TrailForwardActionResult =
  | { status: "applied" | "already_applied" }
  | { status: "anchor_unavailable" }
  | { status: "retry_exhausted" };

export type HistoricalBody =
  | { status: "available"; markdown: string }
  | { status: "unavailable"; reason: string };

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
  beforeBlockId: string | null;
  afterBlockId: string | null;
  beforeBlockIdentity?: CanonicalBlockIdentityV1 | null;
  afterBlockIdentity?: CanonicalBlockIdentityV1 | null;
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  navigation: NavigationTargetV1;
  swept: null | {
    affectedBlockHash: string;
    affectedBlockIdentity?: CanonicalBlockIdentityV1;
    removed: HistoricalBody;
    beforeContentRef: number | null;
  };
  writerProtection?:
    | {
        kind: "sweep";
        body: HistoricalBody;
        ranges?: Array<{ clientID: number; clock: number; length: number }>;
      }
    | { kind: "resurrection"; body: HistoricalBody };
  forwardActions?: Partial<Record<TrailForwardAction, TrailForwardActionStateV1>>;
  reversible: false;
};

export type ChangeTrailShellV1 = {
  trailId: string;
  owner:
    | { kind: "turn"; threadId: string; turnId: string }
    | { kind: "shared"; threadId: string; turnId: null };
  state: "building" | "settling" | "settled";
  version: number;
  changeCount: number;
  sweptChangeCount: number;
  documentCount: number;
  updatedAt: string;
  settledAt: string | null;
};

export const historicalBodySchema: z.ZodType<HistoricalBody> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), markdown: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export const canonicalBlockIdentityV1Schema: z.ZodType<CanonicalBlockIdentityV1> = z.object({
  documentId: z.string(),
  clientID: z.number().int(),
  clock: z.number().int(),
});

export const navigationTargetV1Schema: z.ZodType<NavigationTargetV1> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("live_block_range"),
      relStart: z.string(),
      relEnd: z.string(),
      targetBlockId: z.object({ clientID: z.number().int(), clock: z.number().int() }),
    }),
    z.object({
      kind: z.literal("deletion_boundary"),
      position: z.string(),
      affinity: z.enum(["before_next", "after_previous", "document_start"]),
    }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  ],
);

const trailForwardActionStateV1Schema: z.ZodType<TrailForwardActionStateV1> = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("committed"),
      update: z.string(),
      expectedLiveStateHash: z.string(),
    }),
    z.object({ status: z.literal("applied"), updateId: z.number().int() }),
    z.object({
      status: z.literal("settled"),
      outcome: z.enum(["anchor_unavailable", "retry_exhausted"]),
    }),
  ],
);

export const trailChangeV1Schema = z.object({
  changeId: z.string(),
  ordinal: z.number().int(),
  documentId: z.string().nullable(),
  pushId: z.string().nullable(),
  receiptId: z.string().nullable(),
  kind: z.enum(["insert", "modify", "delete"]),
  beforeBlockId: z.string().nullable(),
  afterBlockId: z.string().nullable(),
  beforeBlockIdentity: canonicalBlockIdentityV1Schema.nullable().optional(),
  afterBlockIdentity: canonicalBlockIdentityV1Schema.nullable().optional(),
  beforeText: z.string().nullable(),
  afterTextAtReceipt: z.string().nullable(),
  navigation: navigationTargetV1Schema,
  swept: z
    .object({
      affectedBlockHash: z.string(),
      affectedBlockIdentity: canonicalBlockIdentityV1Schema.optional(),
      removed: historicalBodySchema,
      beforeContentRef: z.number().int().nullable(),
    })
    .nullable(),
  writerProtection: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("sweep"),
        body: historicalBodySchema,
        ranges: z
          .array(
            z.object({
              clientID: z.number().int().nonnegative(),
              clock: z.number().int().nonnegative(),
              length: z.number().int().positive(),
            }),
          )
          .optional(),
      }),
      z.object({ kind: z.literal("resurrection"), body: historicalBodySchema }),
    ])
    .optional(),
  forwardActions: z
    .object({
      restore: trailForwardActionStateV1Schema.optional(),
      "delete-again": trailForwardActionStateV1Schema.optional(),
    })
    .optional(),
  reversible: z.literal(false),
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
  sweptChangeCount: z.number().int(),
  documentCount: z.number().int(),
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
