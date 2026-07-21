/**
 * Purpose: Defines and validates the thread WebSocket protocol messages, including subscription, replay, gap, ping, and error frames.
 * Why independent: WebSocket frames are a JSON-natural client/server wire contract, so schemas and codecs live in contracts rather than server handlers.
 * MULTIPLE PURPOSES: WebSocket message schemas/types and JSON encode/parse helpers.
 */
import { z } from "zod";

import type { MeridianError } from "../interrupt/index.js";
import { type AGUIEvent, EventSchemas } from "./agui";
import type { ThreadLiveState } from "./http-types";

const jsonValueSchema: z.ZodType<import("../threads/index.js").JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const meridianErrorSchema: z.ZodType<MeridianError> = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  source: z.enum(["gateway", "tool", "child-agent", "system"]),
  details: jsonValueSchema.optional(),
});

const wsEventSeqSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export type SequencedEvent = {
  seq: string;
  event: AGUIEvent;
  /** Present when `event` is RUN_ERROR; mirrors the journal MeridianError envelope. */
  error?: MeridianError;
  sourceThreadId?: string;
};

export const sequencedEventSchema: z.ZodType<SequencedEvent> = z.object({
  seq: wsEventSeqSchema,
  event: z.custom<AGUIEvent>((value) => EventSchemas.safeParse(value).success),
  error: meridianErrorSchema.optional(),
  sourceThreadId: z.string().min(1).optional(),
});

const wsSubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  threadId: z.string().min(1),
  lastSeq: wsEventSeqSchema.optional(),
});

const wsUnsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  threadId: z.string().min(1),
});

const wsResumeMessageSchema = z.object({
  type: z.literal("resume"),
  subscriptions: z.array(
    z.object({
      threadId: z.string().min(1),
      lastSeq: wsEventSeqSchema,
    }),
  ),
});

const wsPongMessageSchema = z.object({
  type: z.literal("pong"),
});

const wsInterruptRespondMessageSchema = z.object({
  type: z.literal("interrupt.respond"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  interruptId: z.string().min(1),
  value: z.unknown(),
});

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  wsSubscribeMessageSchema,
  wsUnsubscribeMessageSchema,
  wsResumeMessageSchema,
  wsPongMessageSchema,
  wsInterruptRespondMessageSchema,
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export const wsGapCauseSchema = z.enum(["replay_limit_exceeded", "server_restart"]);

export type WsGapCause = z.infer<typeof wsGapCauseSchema>;

const threadLiveStateSchema: z.ZodType<ThreadLiveState> = z.object({
  threadId: z.string().min(1),
  status: z.enum(["idle", "active", "blocked", "error", "archived"]),
  runningTurnId: z.string().min(1).nullable(),
  currentAgent: z.string().nullable(),
  resumeAfterSeq: wsEventSeqSchema,
});

const aguiEventSchema = z.custom<AGUIEvent>((value) => EventSchemas.safeParse(value).success);

// Deferred: directory, interaction, approval per design

export type WsServerMessage =
  | {
      type: "connected";
      userId: string;
      scope: { type: "standalone" } | { type: "project"; projectId: string };
      serverVersion: string;
      connectionToken: string;
    }
  | {
      type: "subscribed";
      threadId: string;
      catchup: SequencedEvent[];
      state: ThreadLiveState;
      /** First event position after the subscription snapshot. */
      nextSeq: string;
    }
  | {
      type: "event";
      threadId: string;
      seq: string;
      event: AGUIEvent;
      /** Present when `event` is RUN_ERROR; mirrors the journal MeridianError envelope. */
      error?: MeridianError;
      sourceThreadId?: string;
    }
  | {
      type: "gap";
      threadId: string;
      cause: WsGapCause;
      fromSeq?: string;
      toSeq?: string;
      message?: string;
    }
  | { type: "ping"; ts: number }
  | {
      type: "error";
      kind: "error";
      error: MeridianError;
      threadId?: string;
    };

export const wsServerMessageSchema: z.ZodType<WsServerMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connected"),
    userId: z.string().min(1),
    scope: z.discriminatedUnion("type", [
      z.object({ type: z.literal("standalone") }),
      z.object({ type: z.literal("project"), projectId: z.string().min(1) }),
    ]),
    serverVersion: z.string().min(1),
    connectionToken: z.string().min(1),
  }),
  z.object({
    type: z.literal("subscribed"),
    threadId: z.string().min(1),
    catchup: z.array(sequencedEventSchema),
    state: threadLiveStateSchema,
    nextSeq: wsEventSeqSchema,
  }),
  z.object({
    type: z.literal("event"),
    threadId: z.string().min(1),
    seq: wsEventSeqSchema,
    event: aguiEventSchema,
    error: meridianErrorSchema.optional(),
    sourceThreadId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("gap"),
    threadId: z.string().min(1),
    cause: wsGapCauseSchema,
    fromSeq: wsEventSeqSchema.optional(),
    toSeq: wsEventSeqSchema.optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("ping"),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    kind: z.literal("error"),
    error: meridianErrorSchema,
    threadId: z.string().min(1).optional(),
  }),
]);

function parseMessage<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseWsClientMessage(raw: string): WsClientMessage | null {
  return parseMessage(raw, wsClientMessageSchema);
}

export function parseWsServerMessage(raw: string): WsServerMessage | null {
  return parseMessage(raw, wsServerMessageSchema);
}

export function encodeWsServerMessage(message: WsServerMessage): string {
  return JSON.stringify(message);
}
