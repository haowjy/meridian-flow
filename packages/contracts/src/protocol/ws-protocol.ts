import { z } from "zod";

import { type MeridianError, meridianErrorSchema } from "../errors/index.js";
import { type ServerProtocol, serverProtocolSchema } from "../release/index.js";
import { askAnswerSchema, draftAnswersSchema, threadAskSchema } from "../threads/asks.js";
import { controlBodySchema } from "../threads/control-body.js";
import type { RunState } from "../threads/run-state.js";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";
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

const wsEventSeqSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export type SequencedEvent = {
  seq: string;
  event: AGUIEvent;
  error?: MeridianError;
  sourceThreadId?: string;
};

const sequencedEventObjectSchema = z.object({
  seq: wsEventSeqSchema,
  event: z.custom<AGUIEvent>((value) => EventSchemas.safeParse(value).success),
  error: meridianErrorSchema.optional(),
  sourceThreadId: z.string().min(1).optional(),
});

export const sequencedEventSchema: z.ZodType<SequencedEvent> = sequencedEventObjectSchema;

const wsRequestIdSchema = z.string().min(1).max(64);

const wsSubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  requestId: wsRequestIdSchema,
  threadId: z.string().min(1),
  lastSeq: wsEventSeqSchema.optional(),
});

const wsUnsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  requestId: wsRequestIdSchema,
  threadId: z.string().min(1),
});

const wsCatalogSubscribeMessageSchema = z.object({
  type: z.literal("catalog.subscribe"),
  requestId: wsRequestIdSchema,
  projectId: z.string().min(1),
});

const wsCatalogUnsubscribeMessageSchema = z.object({
  type: z.literal("catalog.unsubscribe"),
  requestId: wsRequestIdSchema,
  projectId: z.string().min(1),
});

const wsPongMessageSchema = z.object({
  type: z.literal("pong"),
});

const wsAskAnswerMessageSchema = z.object({
  type: z.literal("ask.answer"),
  requestId: wsRequestIdSchema,
  threadId: z.string().min(1),
  askId: z.string().min(1),
  submissionId: z.string().min(1),
  answer: askAnswerSchema,
});

const wsAskPresenceMessageSchema = z.object({
  type: z.literal("ask.presence"),
  threadId: z.string().min(1),
  askId: z.string().min(1),
  answers: draftAnswersSchema.optional(),
});

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  wsSubscribeMessageSchema,
  wsUnsubscribeMessageSchema,
  wsPongMessageSchema,
  wsAskAnswerMessageSchema,
  wsAskPresenceMessageSchema,
  wsCatalogSubscribeMessageSchema,
  wsCatalogUnsubscribeMessageSchema,
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

const wsAskAnswerOkSchema = z.object({
  type: z.literal("ask.answer.ok"),
  requestId: wsRequestIdSchema,
  threadId: z.string().min(1),
  ask: threadAskSchema,
});

const wsAskAnswerErrorSchema = z.object({
  type: z.literal("ask.answer.error"),
  requestId: wsRequestIdSchema,
  threadId: z.string().min(1),
  code: z.enum(["ask_not_open", "invalid_answer"]),
  ask: threadAskSchema.optional(),
  questionIndex: z.number().int().nonnegative().optional(),
});

export type AskAnswerReply =
  | z.infer<typeof wsAskAnswerOkSchema>
  | z.infer<typeof wsAskAnswerErrorSchema>;

export const wsGapCauseSchema = z.enum(["replay_limit_exceeded", "server_restart"]);

export type WsGapCause = z.infer<typeof wsGapCauseSchema>;

const threadStatusSchema: z.ZodType<import("../threads/index.js").ThreadStatus> = z.union([
  z.object({ kind: z.literal("asleep") }),
  z.object({
    kind: z.literal("awake"),
    phase: z.enum(["generating", "waiting", "compacting"]),
    cancelRequested: z.boolean(),
  }),
]);

const threadActivityNodeSchema: z.ZodType<import("../threads/index.js").ThreadActivityNode> =
  z.object({
    threadId: z.string().min(1),
    parentThreadId: z.string().min(1).nullable(),
    ref: z.string().min(1).nullable(),
    title: z.string().nullable(),
    agentName: z.string().nullable(),
    spawnStatus: z.enum(["running", "succeeded", "failed", "cancelled"]).nullable(),
    status: threadStatusSchema,
    deliveryMode: z.enum(["direct", "background_notification"]).nullable(),
    runStartedAt: z.string().nullable(),
    runEndedAt: z.string().nullable(),
    currentTool: z
      .object({
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        input: jsonValueSchema,
      })
      .nullable(),
    originTurnId: z.string().min(1).nullable(),
  });

const threadActivitySchema: z.ZodType<import("../threads/index.js").ThreadActivity> = z.object({
  children: z.array(threadActivityNodeSchema),
});

const messageProvenanceSchema: z.ZodType<import("../threads/index.js").MessageProvenance> = z.union(
  [
    z.object({ kind: z.literal("writer"), actorId: z.string().min(1) }),
    z.object({
      kind: z.literal("agent"),
      threadId: z.string().min(1),
      notify: z.object({ turnId: z.string().min(1), toolCallId: z.string().min(1) }).optional(),
    }),
    z.object({
      kind: z.literal("child"),
      threadId: z.string().min(1),
      reportId: z.string().min(1),
      handle: z.string().min(1),
      outcome: z.enum(["succeeded", "failed", "cancelled"]),
      agentName: z.string().min(1),
    }),
    z.object({ kind: z.literal("system"), source: z.string().min(1) }),
  ],
);

const pendingInboxItemSchema: z.ZodType<import("../threads/index.js").PendingInboxItem> = z.object({
  id: z.string().min(1),
  seq: z.number().int(),
  intent: z.enum(["message", "notice", "control"]),
  control: controlBodySchema.optional(),
  provenance: messageProvenanceSchema,
  deliveryState: z.enum(["awaiting_run", "waiting"]),
  summary: z.string(),
  enqueuedAt: z.string().min(1),
});

export const runStateSchema: z.ZodType<RunState> = z.object({
  version: wsEventSeqSchema,
  items: z.array(pendingInboxItemSchema),
  sentThrough: z.number().int().nonnegative(),
  execution: z
    .object({ executionId: z.string().min(1), currentTurnId: z.string().min(1).nullable() })
    .nullable(),
  mode: aiWriteModeSchema,
  blocked: z.object({ reason: z.literal("credits_exhausted") }).nullable(),
});

export function readRunState(value: unknown): RunState | null {
  const parsed = runStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const threadLiveStateSchema = z.object({
  threadId: z.string().min(1),
  status: threadStatusSchema,
  activity: threadActivitySchema,
  runState: runStateSchema,
}) satisfies z.ZodType<ThreadLiveState>;

export type WsServerMessage =
  | {
      type: "connected";
      userId: string;
      scope: { type: "standalone" } | { type: "project"; projectId: string };
      serverVersion: string;
      protocol?: ServerProtocol;
      connectionToken: string;
    }
  | {
      type: "subscribed";
      requestId: string;
      threadId: string;
      after: string;
      catchup: SequencedEvent[];
      state: ThreadLiveState;
    }
  | (SequencedEvent & { type: "event"; threadId: string })
  | {
      type: "gap";
      requestId: string;
      threadId: string;
      cause: WsGapCause;
      fromSeq?: string;
      toSeq?: string;
      message?: string;
    }
  | { type: "ping"; ts: number }
  | import("./context-catalog.js").DraftHint
  | import("./context-catalog.js").ProjectChatsHint
  | import("./context-sources.js").ContextSourcesHint
  | import("./context-catalog.js").AgentFilesHint
  | import("./context-catalog.js").McpConnectionsHint
  | AskAnswerReply
  | {
      type: "error";
      kind: "error";
      error: MeridianError;
      requestId?: string;
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
    protocol: serverProtocolSchema.optional(),
    connectionToken: z.string().min(1),
  }),
  z.object({
    type: z.literal("subscribed"),
    requestId: wsRequestIdSchema,
    threadId: z.string().min(1),
    after: wsEventSeqSchema,
    catchup: z.array(sequencedEventSchema),
    state: threadLiveStateSchema,
  }),
  sequencedEventObjectSchema.extend({
    type: z.literal("event"),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("gap"),
    requestId: wsRequestIdSchema,
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
    type: z.literal("project-chats-hint"),
    projectId: z.string().min(1),
    removedChatIds: z.array(z.string().min(1)).optional(),
    recheckTabs: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("context-sources-hint"),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent-files-hint"),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal("mcp-connections-hint"),
    projectId: z.string().min(1),
  }),
  z.object({
    type: z.literal("draft-hint"),
    projectId: z.string().min(1),
    draft: z.string().regex(/^[0-9a-z]{12}$/),
  }),
  wsAskAnswerOkSchema,
  wsAskAnswerErrorSchema,
  z.object({
    type: z.literal("error"),
    kind: z.literal("error"),
    error: meridianErrorSchema,
    requestId: wsRequestIdSchema.optional(),
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
