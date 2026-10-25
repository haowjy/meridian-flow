/** Applies accepted stream events to a turn. */
import type { AGUIEvent, Block, BlockType, JsonValue, Turn } from "@meridian/contracts/protocol";
import {
  blockContentRecord,
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  RUN_STATE_EVENT,
  readMessagesHandedBack,
  readRunStartedMeta,
  readTurnsForgotten,
  readWriteModeSwitched,
  TURNS_FORGOTTEN_EVENT,
  WRITE_MODE_SWITCHED_EVENT,
} from "@meridian/contracts/protocol";
import {
  ASK_UPDATED_EVENT,
  isTerminalTurnStatus,
  type ThreadAsk,
  threadAskSchema,
} from "@meridian/contracts/threads";
import { WORK_CONTEXT_PROJECTION_EVENT } from "@meridian/contracts/works";
import {
  eventH,
  nextBlockSequence,
  parseToolOutput,
  readString,
  toBlockContent,
} from "./state-helpers";
import type { SwitchTurnFacts } from "./turn-ops";

type CustomBlockUpsertPayload = {
  block: {
    id: string;
    turnId: string;
    responseId?: string | null;
    blockType: "custom";
    sequence: number;
    content: JsonValue;
    provider?: string | null;
    status?: "complete" | "partial";
  };
};

type PositionalBlockIdentity = {
  id: string;
  turnId: string;
  sequence: number;
};

export type TurnStore = {
  turns(threadId: string): Turn[] | undefined;
  ensureAssistantTurn(
    threadId: string,
    turnId: string,
    opts?: { createdAt?: string; writeMode?: Turn["writeMode"] },
  ): void;
  /** Adds the write-mode divider a `meridian.write_mode.switched` frame names (see `ensureSwitchTurnIn`). */
  ensureSwitchTurn(threadId: string, facts: SwitchTurnFacts, seq: string): void;
  upsertAssistantBlock(threadId: string, turnId: string, block: Block): void;
  /** Adapter hook: ask the host to refetch. Reduction never depends on it. */
  invalidateThreadSnapshot?(threadId: string): void;
  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: Turn["status"],
    patch?: Partial<Pick<Turn, "completedAt" | "error" | "finishReason">>,
  ): void;
  /**
   * Removes turns that left the conversation (handed-back messages) and keeps a tombstone at
   * `seq`, so a snapshot read before the removal cannot bring them back.
   */
  removeTurns(threadId: string, ids: readonly string[], seq: string): void;
  /**
   * Stamps failed turns that left the conversation (`meridian.turns.forgotten`) and remembers every id, so
   * a stamp that arrives before its turn is hydrated still applies, and an older snapshot can't clear it.
   */
  markForgotten(threadId: string, ids: readonly string[], byTurnId: string): void;
  /** Takes a `meridian.ask` frame's ask; a status never moves back (see `asks/`). */
  receiveAsk(threadId: string, ask: ThreadAsk): void;
  bumpEventsApplied(threadId: string): number;
};

/** The addressed block vocabulary has one reducer owner, independent of a run. */
export function isDurableBlockEvent(event: AGUIEvent): boolean {
  return event.type === EventType.CUSTOM && event.name === "meridian.block.upserted";
}

export function isWellFormedDurableBlockEvent(event: AGUIEvent): boolean {
  if (!isDurableBlockEvent(event) || event.type !== EventType.CUSTOM) return false;
  return parseCustomBlockUpsertPayload(event.value) !== null;
}

function parseCustomBlockUpsertPayload(value: unknown): CustomBlockUpsertPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = (value as Record<string, unknown>).block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const candidate = block as Record<string, unknown>;
  if (candidate.blockType !== "custom") return null;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) return null;
  if (typeof candidate.sequence !== "number" || !Number.isSafeInteger(candidate.sequence)) {
    return null;
  }

  return {
    block: {
      id: candidate.id,
      turnId: candidate.turnId,
      responseId: typeof candidate.responseId === "string" ? candidate.responseId : null,
      blockType: "custom",
      sequence: candidate.sequence,
      content: toBlockContent(candidate.content as JsonValue),
      provider: typeof candidate.provider === "string" ? candidate.provider : null,
      status: candidate.status === "partial" ? "partial" : "complete",
    },
  };
}

export type TurnReducer = {
  /** `seq` is the event's stream seq; the frames that remove turns need it for their tombstones. */
  applyEvent(threadId: string, event: AGUIEvent, seq?: string): void;
  /** False means the owned vocabulary was malformed or not for this thread. */
  applyDurableBlockEvent(threadId: string, event: AGUIEvent): boolean;
};

export type TurnReducerOptions = {
  store: TurnStore;
  /** ISO-8601 timestamp source; the reducer never reads a clock itself. */
  now: () => string;
};

/** One reducer per store. */
export function createTurnReducer(options: TurnReducerOptions): TurnReducer {
  const { store, now } = options;
  function activeAssistantTurn(store: TurnStore, threadId: string): Turn | null {
    const turns = store.turns(threadId) ?? [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn?.role === "assistant" && !isTerminalTurnStatus(turn.status)) return turn;
    }
    return null;
  }

  function turnById(store: TurnStore, threadId: string, turnId: string): Turn | null {
    return (store.turns(threadId) ?? []).find((turn) => turn.id === turnId) ?? null;
  }

  function blockById(turn: Turn, blockId: string): Block | null {
    return turn.blocks.find((block) => block.id === blockId) ?? null;
  }

  // Returns the LAST block matching blockId. Text segments are accumulated by
  // messageId; if a turn ever surfaces two blocks with the same id (e.g. a
  // resumed text segment), deltas must land on the most-recently-opened block,
  // not the first. find() would mis-route to the stale first block.
  function lastBlockById(turn: Turn, blockId: string): Block | null {
    for (let i = turn.blocks.length - 1; i >= 0; i -= 1) {
      const block = turn.blocks[i];
      if (block && block.id === blockId) return block;
    }
    return null;
  }

  function lastPartialBlock(turn: Turn, blockType?: BlockType): Block | null {
    for (let index = turn.blocks.length - 1; index >= 0; index -= 1) {
      const block = turn.blocks[index];
      if (block?.status !== "partial") continue;
      if (blockType && block.blockType !== blockType) continue;
      return block;
    }
    return null;
  }

  function baseBlock(args: {
    id: string;
    turnId: string;
    blockType: BlockType;
    sequence: number;
    content: JsonValue;
    responseId?: string | null;
    textContent?: string | null;
    provider?: string | null;
    providerData?: JsonValue | null;
    status?: "complete" | "partial";
  }): Block {
    return {
      id: args.id,
      turnId: args.turnId,
      responseId: args.responseId ?? null,
      blockType: args.blockType,
      sequence: args.sequence,
      textContent: args.textContent ?? (typeof args.content === "string" ? args.content : null),
      content: args.content,
      provider: args.provider ?? null,
      providerData: args.providerData ?? null,
      executionSide: "server",
      status: args.status ?? "complete",
      collapsedContent: null,
      createdAt: now(),
    };
  }

  function textBlock(args: {
    id: string;
    turnId: string;
    sequence: number;
    blockType: "text" | "reasoning";
    text: string;
    status: "complete" | "partial";
  }): Block {
    return baseBlock({
      id: args.id,
      turnId: args.turnId,
      blockType: args.blockType,
      sequence: args.sequence,
      textContent: args.text,
      content: { text: args.text },
      status: args.status,
    });
  }

  function toolBlock(args: {
    id: string;
    turnId: string;
    sequence: number;
    toolCallId: string;
    toolName: string;
    input?: JsonValue;
    status: "complete" | "partial";
    output?: JsonValue;
    // The tool's typed result beside the model-facing `output` text; mirrors the
    // durable block's `content.result`.
    result?: JsonValue;
    message?: string | null;
    isError?: boolean;
    // Live, append-only interleaved stdout/stderr buffer streamed via the
    // `meridian.tool.output_delta` CUSTOM event. Distinct from `output`, which is
    // the authoritative final tool result. Kept past completion so the card can
    // still show the streamed log alongside the structured result.
    streamedOutput?: string | null;
    // Server-authored result metadata (e.g. the work receipt). Mirrors the
    // durable block's `content.metadata` so live and cold-loaded tool views
    // read the same field.
    metadata?: Record<string, JsonValue> | null;
  }): Block {
    return baseBlock({
      id: args.id,
      turnId: args.turnId,
      blockType: "tool_use",
      sequence: args.sequence,
      textContent: args.message ?? null,
      content: {
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        input: args.input ?? null,
        output: args.output ?? null,
        result: args.result ?? null,
        message: typeof args.message === "string" ? args.message : null,
        isError: args.isError ?? false,
        streamedOutput: typeof args.streamedOutput === "string" ? args.streamedOutput : null,
        metadata: args.metadata ?? null,
      },
      provider: args.toolName,
      providerData: { tool: args.toolName },
      status: args.status,
    });
  }

  function toolIsErrorFromContent(content: Record<string, JsonValue>): boolean {
    return content.isError === true;
  }

  function preservedToolFields(content: Record<string, JsonValue>): {
    input: JsonValue;
    output: JsonValue;
    result: JsonValue;
    message: string | null;
    isError: boolean;
    // Carried across every tool-block upsert so TOOL_CALL_ARGS/END/RESULT and
    // tool.progress activity events don't wipe the running stdout/stderr log.
    // Intentionally kept past completion — the typed `result` is what the card's
    // preview consumes, but the streamed buffer remains visible in details.
    streamedOutput: string | null;
    metadata: Record<string, JsonValue> | null;
  } {
    return {
      input: content.input ?? null,
      output: content.output ?? null,
      result: content.result ?? null,
      message: typeof content.message === "string" ? content.message : null,
      isError: toolIsErrorFromContent(content),
      streamedOutput: typeof content.streamedOutput === "string" ? content.streamedOutput : null,
      metadata: recordContentField(content, "metadata"),
    };
  }

  function recordContentField(
    content: Record<string, JsonValue>,
    key: string,
  ): Record<string, JsonValue> | null {
    const value = content[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, JsonValue>)
      : null;
  }

  /** The typed result the server sends beside the model-facing text, when the tool has one. */
  function toolResultEventResult(event: object): JsonValue {
    return ((event as Record<string, unknown>).result as JsonValue | undefined) ?? null;
  }

  function toolResultEventMetadata(event: object): Record<string, JsonValue> | null {
    const value = (event as Record<string, unknown>).metadata;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, JsonValue>)
      : null;
  }

  function opaqueBlock(args: {
    turn: Turn;
    blockType: string;
    content: JsonValue;
    eventsApplied: number;
  }): Block {
    return baseBlock({
      id: `${args.turn.id}_${args.blockType}_${args.eventsApplied}`,
      turnId: args.turn.id,
      blockType: args.blockType as BlockType,
      sequence: nextBlockSequence(args.turn.blocks),
      content: toBlockContent(args.content),
      textContent: typeof args.content === "string" ? args.content : null,
      status: "complete",
    });
  }

  function completeBlock(store: TurnStore, threadId: string, turnId: string, block: Block): void {
    if (block.status !== "partial") return;
    store.upsertAssistantBlock(threadId, turnId, { ...block, status: "complete" });
  }

  function completePartialBlocks(store: TurnStore, threadId: string, turn: Turn): void {
    for (const block of turn.blocks) {
      completeBlock(store, threadId, turn.id, block);
    }
  }

  function parsePositionalReasoningId(value: unknown): PositionalBlockIdentity | null {
    const messageId = readString(value);
    if (!messageId) {
      warnMalformedReasoningId("missing positional messageId");
      return null;
    }

    const parts = messageId.split("::");
    if (parts.length !== 2 || !parts[0] || !/^(0|[1-9]\d*)$/.test(parts[1] ?? "")) {
      warnMalformedReasoningId(`messageId must be encoded as {turnId}::{sequence}: ${messageId}`);
      return null;
    }

    const sequence = Number(parts[1]);
    if (!Number.isSafeInteger(sequence)) {
      warnMalformedReasoningId(`sequence is not a safe integer: ${messageId}`);
      return null;
    }

    return { id: messageId, turnId: parts[0], sequence };
  }

  function parseReasoningIdentity(
    currentTurn: Turn | null,
    value: unknown,
  ): PositionalBlockIdentity | null {
    const identity = parsePositionalReasoningId(value);
    if (!identity) return null;
    if (currentTurn && currentTurn.id !== identity.turnId) {
      warnMalformedReasoningId(
        `turnId ${identity.turnId} does not match active turn ${currentTurn.id}`,
      );
      return null;
    }
    return identity;
  }

  let malformedReasoningWarned = false;
  function warnMalformedReasoningId(detail: string): void {
    if (malformedReasoningWarned) return;
    malformedReasoningWarned = true;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[live-turn] dropping malformed reasoning event: ${detail}`);
    }
  }

  function applyTextDelta(args: {
    store: TurnStore;
    threadId: string;
    turn: Turn;
    messageId: string;
    blockType: "text" | "reasoning";
    sequence?: number;
    delta: string;
  }): void {
    const existing = lastBlockById(args.turn, args.messageId);
    const text = `${existing?.textContent ?? ""}${args.delta}`;
    const sequence = existing?.sequence ?? args.sequence ?? nextBlockSequence(args.turn.blocks);
    args.store.upsertAssistantBlock(
      args.threadId,
      args.turn.id,
      textBlock({
        id: args.messageId,
        turnId: args.turn.id,
        sequence,
        blockType: args.blockType,
        text,
        status: "partial",
      }),
    );
  }

  function blockFromCustomUpsertPayload(payload: CustomBlockUpsertPayload): Block {
    return baseBlock({
      id: payload.block.id,
      turnId: payload.block.turnId,
      responseId: payload.block.responseId ?? null,
      blockType: "custom",
      sequence: payload.block.sequence,
      content: payload.block.content,
      provider: payload.block.provider ?? null,
      status: payload.block.status ?? "complete",
    });
  }

  type ToolOutputDeltaPayload = {
    toolCallId: string;
    stream: "stdout" | "stderr";
    text: string;
  };

  function parseToolOutputDeltaPayload(value: unknown): ToolOutputDeltaPayload | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const { toolCallId, stream, text } = candidate;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
    if (stream !== "stdout" && stream !== "stderr") return null;
    if (typeof text !== "string") return null;
    return { toolCallId, stream, text };
  }

  type ToolResultErrorPayload = {
    toolCallId: string;
    isError: true;
  };

  function parseToolResultErrorPayload(value: unknown): ToolResultErrorPayload | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const { toolCallId, isError } = candidate;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) return null;
    if (isError !== true) return null;
    return { toolCallId, isError };
  }

  let malformedToolOutputDeltaWarned = false;
  function warnMalformedToolOutputDelta(detail: string): void {
    if (malformedToolOutputDeltaWarned) return;
    malformedToolOutputDeltaWarned = true;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[live-turn] dropping malformed meridian.tool.output_delta: ${detail}`);
    }
  }

  function applyCustomBlockUpsertEvent(
    store: TurnStore,
    threadId: string,
    payload: CustomBlockUpsertPayload,
  ): void {
    if (!turnById(store, threadId, payload.block.turnId)) {
      store.invalidateThreadSnapshot?.(threadId);
      return;
    }
    store.upsertAssistantBlock(
      threadId,
      payload.block.turnId,
      blockFromCustomUpsertPayload(payload),
    );
  }

  function toolNameFromBlock(block: Block | null): string {
    const content = block ? blockContentRecord(block) : {};
    const value = content.toolName;
    return typeof value === "string" ? value : "tool";
  }

  function toolCallIdFromBlock(block: Block): string {
    const content = blockContentRecord(block);
    const value = content.toolCallId;
    if (typeof value === "string" && value.length > 0) return value;
    return block.id.startsWith("tool-") ? block.id.slice("tool-".length) : block.id;
  }

  function toolNameFromEvent(event: Record<string, unknown>): string {
    return readString(event.toolCallName) ?? readString(event.toolName) ?? "tool";
  }

  /** False means the owned vocabulary was malformed, not an opaque CUSTOM event. */
  function applyDurableBlockEvent(threadId: string, event: AGUIEvent): boolean {
    if (!isDurableBlockEvent(event) || (eventH(event) && event.threadId !== threadId)) return false;
    if (event.type !== EventType.CUSTOM) return false;
    const payload = parseCustomBlockUpsertPayload(event.value);
    if (!payload) return false;
    applyCustomBlockUpsertEvent(store, threadId, payload);
    return true;
  }

  /** Applies one live AG-UI event to the unified thread store. */
  function applyEvent(threadId: string, event: AGUIEvent, seq?: string): void {
    if (eventH(event) && event.threadId !== threadId) return;

    if (isDurableBlockEvent(event)) {
      applyDurableBlockEvent(threadId, event);
      return;
    }

    const eventsApplied = store.bumpEventsApplied(threadId);

    switch (event.type) {
      case EventType.RUN_STARTED:
        store.ensureAssistantTurn(threadId, event.runId, {
          createdAt: now(),
          writeMode: readRunStartedMeta(event.rawEvent).writeMode,
        });
        return;

      case EventType.TEXT_MESSAGE_START: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        completePartialBlocks(store, threadId, turn);
        const refreshedTurn = turnById(store, threadId, turn.id) ?? turn;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          textBlock({
            id: event.messageId,
            turnId: turn.id,
            sequence: nextBlockSequence(refreshedTurn.blocks),
            blockType: "text",
            text: "",
            status: "partial",
          }),
        );
        return;
      }

      case EventType.TEXT_MESSAGE_CONTENT: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        applyTextDelta({
          store,
          threadId,
          turn,
          messageId: event.messageId,
          blockType: "text",
          delta: event.delta,
        });
        return;
      }

      case EventType.TEXT_MESSAGE_CHUNK: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) return;
        const fallbackBlock = lastPartialBlock(turn, "text");
        const messageId = event.messageId ?? fallbackBlock?.id ?? `text_${eventsApplied}`;
        applyTextDelta({ store, threadId, turn, messageId, blockType: "text", delta });
        return;
      }

      case EventType.TEXT_MESSAGE_END: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const block = lastBlockById(turn, event.messageId) ?? lastPartialBlock(turn, "text");
        if (block) completeBlock(store, threadId, turn.id, block);
        return;
      }

      case EventType.REASONING_MESSAGE_START:
      case EventType.THINKING_TEXT_MESSAGE_START: {
        const currentTurn = activeAssistantTurn(store, threadId);
        const identity = parseReasoningIdentity(
          currentTurn,
          (event as Record<string, unknown>).messageId,
        );
        if (!identity) return;
        store.ensureAssistantTurn(threadId, identity.turnId, { createdAt: now() });
        const turn = turnById(store, threadId, identity.turnId);
        if (!turn) return;
        completePartialBlocks(store, threadId, turn);
        store.upsertAssistantBlock(
          threadId,
          identity.turnId,
          textBlock({
            id: identity.id,
            turnId: identity.turnId,
            sequence: identity.sequence,
            blockType: "reasoning",
            text: "",
            status: "partial",
          }),
        );
        return;
      }

      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
        const currentTurn = activeAssistantTurn(store, threadId);
        const identity = parseReasoningIdentity(
          currentTurn,
          (event as Record<string, unknown>).messageId,
        );
        if (!identity) return;
        store.ensureAssistantTurn(threadId, identity.turnId, { createdAt: now() });
        const turn = turnById(store, threadId, identity.turnId);
        if (!turn) return;
        applyTextDelta({
          store,
          threadId,
          turn,
          messageId: identity.id,
          sequence: identity.sequence,
          blockType: "reasoning",
          delta: readString((event as Record<string, unknown>).delta) ?? "",
        });
        return;
      }

      case EventType.REASONING_MESSAGE_CHUNK: {
        const currentTurn = activeAssistantTurn(store, threadId);
        const identity = parseReasoningIdentity(currentTurn, event.messageId);
        if (!identity) return;
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) return;
        store.ensureAssistantTurn(threadId, identity.turnId, { createdAt: now() });
        const turn = turnById(store, threadId, identity.turnId);
        if (!turn) return;
        applyTextDelta({
          store,
          threadId,
          turn,
          messageId: identity.id,
          sequence: identity.sequence,
          blockType: "reasoning",
          delta,
        });
        return;
      }

      case EventType.REASONING_MESSAGE_END:
      case EventType.THINKING_TEXT_MESSAGE_END: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const identity = parseReasoningIdentity(turn, (event as Record<string, unknown>).messageId);
        const block = identity ? blockById(turn, identity.id) : lastPartialBlock(turn, "reasoning");
        if (block) completeBlock(store, threadId, turn.id, block);
        return;
      }

      case EventType.TOOL_CALL_START: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const existingTool = blockById(turn, `tool-${event.toolCallId}`);
        const content = existingTool ? blockContentRecord(existingTool) : {};
        completePartialBlocks(store, threadId, turn);
        const refreshedTurn = turnById(store, threadId, turn.id) ?? turn;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          toolBlock({
            id: `tool-${event.toolCallId}`,
            turnId: turn.id,
            sequence: existingTool?.sequence ?? nextBlockSequence(refreshedTurn.blocks),
            toolCallId: event.toolCallId,
            toolName: event.toolCallName,
            ...preservedToolFields(content),
            status: "partial",
          }),
        );
        return;
      }

      case EventType.TOOL_CALL_ARGS: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const existingTool = blockById(turn, `tool-${event.toolCallId}`);
        const content = existingTool ? blockContentRecord(existingTool) : {};
        const existingInput = typeof content.input === "string" ? content.input : "";
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          toolBlock({
            id: `tool-${event.toolCallId}`,
            turnId: turn.id,
            sequence: existingTool?.sequence ?? nextBlockSequence(turn.blocks),
            toolCallId: event.toolCallId,
            toolName: existingTool ? toolNameFromBlock(existingTool) : toolNameFromEvent(event),
            ...preservedToolFields(content),
            // Gateway adapters emit `delta` as an incremental args-json fragment;
            // replacing here drops prior fragments and corrupts the tool input.
            input: `${existingInput}${event.delta}`,
            status: "partial",
          }),
        );
        return;
      }

      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const content =
          event.type === EventType.ACTIVITY_SNAPSHOT
            ? ((event.content as JsonValue) ?? null)
            : ({
                patch: (event as Record<string, unknown>).patch ?? null,
                delta: (event as Record<string, unknown>).delta ?? null,
              } as JsonValue);

        if (event.activityType === "tool.progress") {
          const existingTool = event.messageId ? blockById(turn, `tool-${event.messageId}`) : null;
          if (existingTool?.blockType === "tool_use") {
            const existingContent = blockContentRecord(existingTool);
            const progress =
              content && typeof content === "object" && !Array.isArray(content)
                ? (content as Record<string, JsonValue>)
                : {};
            const message =
              typeof progress.message === "string"
                ? progress.message
                : typeof existingContent.message === "string"
                  ? existingContent.message
                  : null;
            store.upsertAssistantBlock(
              threadId,
              turn.id,
              toolBlock({
                id: existingTool.id,
                turnId: turn.id,
                sequence: existingTool.sequence,
                toolCallId: toolCallIdFromBlock(existingTool),
                toolName: toolNameFromBlock(existingTool),
                ...preservedToolFields(existingContent),
                status: "partial",
                // Override message from progress payload — preservedToolFields
                // would otherwise carry the prior message, but progress *is* the
                // message update channel for live tools.
                message,
              }),
            );
            return;
          }
        }

        store.upsertAssistantBlock(
          threadId,
          turn.id,
          opaqueBlock({
            turn,
            blockType: "activity",
            content: {
              activityType: event.activityType,
              content,
            },
            eventsApplied,
          }),
        );
        return;
      }

      case EventType.TOOL_CALL_END: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const existingTool = blockById(turn, `tool-${event.toolCallId}`);
        if (!existingTool) return;
        const content = blockContentRecord(existingTool);
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          toolBlock({
            id: existingTool.id,
            turnId: turn.id,
            sequence: existingTool.sequence,
            toolCallId: event.toolCallId,
            toolName: toolNameFromBlock(existingTool),
            ...preservedToolFields(content),
            status: "complete",
          }),
        );
        return;
      }

      case EventType.TOOL_CALL_RESULT: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        const existingTool = blockById(turn, `tool-${event.toolCallId}`);
        const content = existingTool ? blockContentRecord(existingTool) : {};
        const resultMetadata = toolResultEventMetadata(event);
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          toolBlock({
            id: `tool-${event.toolCallId}`,
            turnId: turn.id,
            sequence: existingTool?.sequence ?? nextBlockSequence(turn.blocks),
            toolCallId: event.toolCallId,
            toolName: toolNameFromBlock(existingTool),
            ...preservedToolFields(content),
            status: "complete",
            output: parseToolOutput(event.content),
            result: toolResultEventResult(event),
            isError: toolIsErrorFromContent(content),
            ...(resultMetadata ? { metadata: resultMetadata } : {}),
          }),
        );
        return;
      }

      case EventType.STATE_SNAPSHOT: {
        const snapshot = event.snapshot as Record<string, unknown>;
        const runningTurnId =
          typeof snapshot.runningTurnId === "string" ? snapshot.runningTurnId : null;
        if (runningTurnId) store.ensureAssistantTurn(threadId, runningTurnId, { createdAt: now() });
        const turn = runningTurnId
          ? turnById(store, threadId, runningTurnId)
          : activeAssistantTurn(store, threadId);
        if (!turn) return;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          opaqueBlock({
            turn,
            blockType: "state_snapshot",
            content: event.snapshot as JsonValue,
            eventsApplied,
          }),
        );
        if (snapshot.status === "streaming") {
          store.patchTurnStatus(threadId, turn.id, "streaming");
        }
        return;
      }

      case EventType.STATE_DELTA: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          opaqueBlock({
            turn,
            blockType: "state_delta",
            content: { delta: event.delta as JsonValue },
            eventsApplied,
          }),
        );
        return;
      }

      case EventType.CUSTOM: {
        if (event.name === "meridian.tool.output_delta") {
          const payload = parseToolOutputDeltaPayload(event.value);
          if (!payload) {
            warnMalformedToolOutputDelta(`value=${typeof event.value}`);
            return;
          }
          const turn = activeAssistantTurn(store, threadId);
          if (!turn) return;
          // Deltas can race ahead of TOOL_CALL_START; without a host block to
          // append into we drop quietly — TOOL_CALL_START will create a fresh
          // block and the next delta (or the final RESULT) lands correctly.
          const existingTool = blockById(turn, `tool-${payload.toolCallId}`);
          if (existingTool?.blockType !== "tool_use") return;
          const content = blockContentRecord(existingTool);
          const prior = typeof content.streamedOutput === "string" ? content.streamedOutput : "";
          // Single interleaved buffer (stdout + stderr in arrival order). This
          // is the terminal-style view a user expects when watching a long
          // streaming tool — distinguishing streams would force two columns or
          // a markup pass for a marginal gain.
          const nextBuffer = `${prior}${payload.text}`;
          store.upsertAssistantBlock(
            threadId,
            turn.id,
            toolBlock({
              id: existingTool.id,
              turnId: turn.id,
              sequence: existingTool.sequence,
              toolCallId: toolCallIdFromBlock(existingTool),
              toolName: toolNameFromBlock(existingTool),
              ...preservedToolFields(content),
              streamedOutput: nextBuffer,
              status: existingTool.status === "complete" ? "complete" : "partial",
            }),
          );
          return;
        }
        if (event.name === "meridian.tool.result_error") {
          const payload = parseToolResultErrorPayload(event.value);
          if (!payload) return;
          const turn = activeAssistantTurn(store, threadId);
          if (!turn) return;
          const existingTool = blockById(turn, `tool-${payload.toolCallId}`);
          if (existingTool?.blockType !== "tool_use") return;
          const content = blockContentRecord(existingTool);
          store.upsertAssistantBlock(
            threadId,
            turn.id,
            toolBlock({
              id: existingTool.id,
              turnId: turn.id,
              sequence: existingTool.sequence,
              toolCallId: toolCallIdFromBlock(existingTool),
              toolName: toolNameFromBlock(existingTool),
              ...preservedToolFields(content),
              isError: true,
              status: existingTool.status === "complete" ? "complete" : "partial",
            }),
          );
          return;
        }
        if (event.name === "meridian.usage" || event.name === "meridian.permission.denied") return;
        // Subagent activity is live read-model state consumed via ThreadLiveState;
        // it is not transcript content, so it never becomes a turn block. The
        // spawn hint is not either: the invocation card carries its `from`
        // source durably, and its value holds the child's whole prompt.
        if (event.name === "meridian.subagent.activity" || event.name === "meridian.agent.spawn")
          return;
        // Waiting messages that left the chat: the turns go, and a tombstone at this frame's
        // seq keeps an older snapshot from bringing them back.
        if (event.name === MESSAGES_HANDED_BACK_EVENT) {
          const handedBack = readMessagesHandedBack(event.value);
          if (handedBack) store.removeTurns(threadId, handedBack.userTurnIds, seq ?? "0");
          return;
        }
        if (event.name === ASK_UPDATED_EVENT) {
          const parsed = threadAskSchema.safeParse(event.value);
          if (parsed.success) store.receiveAsk(threadId, parsed.data);
          else console.warn(`[live-turn] dropping malformed ${ASK_UPDATED_EVENT}`);
          return;
        }
        // Failed turns the chat left behind: stamped, never removed, so the graph still chains through them.
        if (event.name === TURNS_FORGOTTEN_EVENT) {
          const forgotten = readTurnsForgotten(event.value);
          if (forgotten) store.markForgotten(threadId, forgotten.turnIds, forgotten.byTurnId);
          return;
        }
        // The switch turn is not announced by a turn event, so its frame is how a follower gets
        // the divider; the run-state slice answers the writer's control from the same frame.
        if (event.name === WRITE_MODE_SWITCHED_EVENT) {
          const switched = readWriteModeSwitched(event.value);
          if (switched) store.ensureSwitchTurn(threadId, switched, seq ?? "0");
          return;
        }
        // Durable custom projections are consumed by live listeners — the
        // useThreadDurableProjections trail/Work-binding listener — so they are not transcript
        // content. Falling through here rendered each one as an "Unknown
        // component" note under the digest for the duration of the turn.
        if (
          event.name === "meridian.turn_change_trail.updated" ||
          event.name === "meridian.turn_change_trail.settled" ||
          event.name === WORK_CONTEXT_PROJECTION_EVENT ||
          // The run-state record is the chat's run-state slice's.
          event.name === RUN_STATE_EVENT
        ) {
          return;
        }
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          opaqueBlock({
            turn,
            blockType: "custom",
            content: { name: event.name, value: event.value as JsonValue },
            eventsApplied,
          }),
        );
        return;
      }

      case EventType.RAW: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        store.upsertAssistantBlock(
          threadId,
          turn.id,
          opaqueBlock({
            turn,
            blockType: "raw",
            content: { event: event.event as JsonValue },
            eventsApplied,
          }),
        );
        return;
      }

      case EventType.RUN_FINISHED: {
        const turn = turnById(store, threadId, event.runId) ?? activeAssistantTurn(store, threadId);
        if (!turn) return;
        completePartialBlocks(store, threadId, turn);
        const stopReason =
          event.result &&
          typeof event.result === "object" &&
          "stopReason" in event.result &&
          event.result.stopReason === "user_cancelled";
        store.patchTurnStatus(threadId, turn.id, stopReason ? "cancelled" : "complete", {
          completedAt: now(),
          finishReason: stopReason ? "stop_sequence" : "end_turn",
        });
        return;
      }

      case EventType.RUN_ERROR: {
        const turn = activeAssistantTurn(store, threadId);
        if (!turn) return;
        store.patchTurnStatus(threadId, turn.id, "error", {
          completedAt: now(),
          error: event.message,
          finishReason: "error",
        });
        return;
      }

      default:
        return;
    }
  }

  return {
    applyEvent,
    applyDurableBlockEvent,
  };
}
