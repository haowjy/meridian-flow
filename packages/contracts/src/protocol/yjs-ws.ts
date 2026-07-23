/**
 * Purpose: Defines the Yjs WebSocket path and room-name wire contract shared by collaborative sync clients and server handlers.
 * Why independent: Path constants and room names are protocol primitives shared across the frontend editor and server WebSocket adapter.
 */

import { z } from "zod";
import { type TrailChangeV1, trailChangeV1Schema } from "../change-trails.js";
import type { DocumentId } from "../runtime/index.js";

export const YJS_WS_PATH_PREFIX = "/ws/yjs";
export const YJS_BRANCH_ROOM_PREFIX = "branch:";
const BRANCH_GENERATION_SEPARATOR = ":gen:";

export type YjsRoomName =
  | { kind: "live"; documentId: DocumentId }
  | { kind: "branch"; branchId: string; generation: number };

export type ChangeEventProjection = Pick<TrailChangeV1, "changeId" | "kind" | "navigation"> & {
  swept: boolean;
  excerpt: string | null;
};

export interface ChangeEventWsMessage {
  type: "change_event";
  documentId: DocumentId;
  threadId: string;
  trailId: string;
  /**
   * Changes are a REPLACE-SET for `(trailId, documentId)`. Revisions increase
   * monotonically for that key; clients replace the set and drop stale messages.
   */
  projectionRevision: number;
  /**
   * Authorship and admission are independent facts. Author drives identity and
   * the conversation link; the admitter drives client self-suppression.
   */
  author:
    | { kind: "agent"; threadId: string; turnId: string | null }
    | { kind: "writer"; userId: string };
  admittedByUserId: string | null;
  changes: ChangeEventProjection[];
  truncated: boolean;
}

type YjsStatelessMessageByType = {
  change_event: ChangeEventWsMessage;
};

export type YjsStatelessMessage = YjsStatelessMessageByType[keyof YjsStatelessMessageByType];

const changeEventProjectionSchema: z.ZodType<ChangeEventProjection> = trailChangeV1Schema
  .pick({ changeId: true, kind: true, navigation: true })
  .extend({
    swept: z.boolean(),
    excerpt: z.string().nullable(),
  });

const changeEventWsMessageSchema: z.ZodType<ChangeEventWsMessage> = z.object({
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
  admittedByUserId: z.string().nullable(),
  changes: z.array(changeEventProjectionSchema),
  truncated: z.boolean(),
});

export function encodeChangeEventWsMessage(message: Omit<ChangeEventWsMessage, "type">): string {
  return JSON.stringify({ type: "change_event", ...message } satisfies ChangeEventWsMessage);
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

export function branchRoomName(branchId: string, generation: number): string {
  return `${YJS_BRANCH_ROOM_PREFIX}${branchId}${BRANCH_GENERATION_SEPARATOR}${generation}`;
}

export function parseYjsRoomName(roomName: string): YjsRoomName | null {
  if (roomName.startsWith(YJS_BRANCH_ROOM_PREFIX)) {
    const raw = roomName.slice(YJS_BRANCH_ROOM_PREFIX.length);
    const separatorIndex = raw.lastIndexOf(BRANCH_GENERATION_SEPARATOR);
    if (separatorIndex <= 0) return null;
    const branchId = raw.slice(0, separatorIndex);
    const generationText = raw.slice(separatorIndex + BRANCH_GENERATION_SEPARATOR.length);
    if (!/^[1-9][0-9]*$/.test(generationText)) return null;
    const generation = Number(generationText);
    return branchId.length > 0 && Number.isSafeInteger(generation) && generation > 0
      ? { kind: "branch", branchId, generation }
      : null;
  }
  return roomName.length > 0 ? { kind: "live", documentId: roomName as DocumentId } : null;
}
