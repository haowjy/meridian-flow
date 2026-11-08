/**
 * Purpose: Defines the Yjs WebSocket path and room-name wire contract shared by collaborative sync clients and server handlers.
 * Why independent: Path constants and room names are protocol primitives shared across the frontend editor and server WebSocket adapter.
 */

import { z } from "zod";
import type { DocumentId } from "../runtime/index.js";

export const YJS_WS_PATH_PREFIX = "/ws/yjs";
export const YJS_DRAFT_ROOM_PREFIX = "draft:";

export type YjsRoomName =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "draft"; draftId: string };

const yjsIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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

const navigationTargetV1Schema: z.ZodType<NavigationTargetV1> = z.discriminatedUnion("kind", [
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
]);

export type ChangeEventProjection = {
  changeId: string;
  kind: "insert" | "modify" | "delete";
  navigation: NavigationTargetV1;
  admittedByUserId: string | null;
  /** Recipient-specific attention severity; the server targets each connection. */
  swept: boolean;
  excerpt: string | null;
  pureDeletionOffset: number | null;
};

export interface ChangeEventWsMessage {
  type: "change_event";
  documentId: DocumentId;
  threadId: string;
  trailId: string;
  /**
   * Changes are a REPLACE-SET for `(trailId, documentId)`; `trailId` groups the changes of one
   * turn. Revisions increase monotonically for that key; clients replace the set and drop stale
   * messages.
   */
  projectionRevision: number;
  /**
   * Authorship drives identity and the conversation link. The writer arm is reserved for future
   * writer-push broadcasts. No server producer emits change events today.
   */
  author:
    | { kind: "agent"; threadId: string; turnId: string | null }
    | { kind: "writer"; userId: string };
  changes: ChangeEventProjection[];
  truncated: boolean;
}

type YjsStatelessMessageByType = {
  change_event: ChangeEventWsMessage;
};

export type YjsStatelessMessage = YjsStatelessMessageByType[keyof YjsStatelessMessageByType];

const changeEventProjectionSchema: z.ZodType<ChangeEventProjection> = z.object({
  changeId: z.string(),
  kind: z.enum(["insert", "modify", "delete"]),
  navigation: navigationTargetV1Schema,
  swept: z.boolean(),
  admittedByUserId: z.string().nullable(),
  excerpt: z.string().max(500).nullable(),
  pureDeletionOffset: z.number().int().nonnegative().nullable(),
});

const changeEventWsMessageSchema: z.ZodType<ChangeEventWsMessage> = z
  .object({
    type: z.literal("change_event"),
    documentId: z.string() as z.ZodType<DocumentId>,
    threadId: z.string(),
    trailId: z.string(),
    projectionRevision: z.number().int().nonnegative(),
    author: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("agent"),
        threadId: z.string(),
        turnId: z.string().nullable(),
      }),
      z.object({ kind: z.literal("writer"), userId: z.string() }),
    ]),
    changes: z.array(changeEventProjectionSchema),
    truncated: z.boolean(),
  })
  .superRefine((message, context) => {
    if (message.author.kind === "agent" && message.author.threadId !== message.threadId) {
      context.addIssue({
        code: "custom",
        path: ["author", "threadId"],
        message: "Agent author threadId must match the owning threadId",
      });
    }
  });

export function encodeChangeEventWsMessage(message: Omit<ChangeEventWsMessage, "type">): string {
  return JSON.stringify(changeEventWsMessageSchema.parse({ type: "change_event", ...message }));
}

/** Parses the extensible stateless Yjs channel and rejects malformed payloads. */
export function parseYjsStatelessMessage(payload: string): YjsStatelessMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = changeEventWsMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}

export function draftRoomName(draftId: string): string {
  return `${YJS_DRAFT_ROOM_PREFIX}${draftId}`;
}

export function parseYjsRoomName(roomName: string): YjsRoomName | null {
  if (roomName.startsWith(YJS_DRAFT_ROOM_PREFIX)) {
    const draftId = roomName.slice(YJS_DRAFT_ROOM_PREFIX.length);
    return draftId.length > 0 && !draftId.includes(":") ? { kind: "draft", draftId } : null;
  }
  return roomName.length > 0 ? { kind: "live", documentId: roomName as DocumentId } : null;
}
