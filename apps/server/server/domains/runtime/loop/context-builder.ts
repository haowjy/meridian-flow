/** Projects persisted turns and blocks into the canonical gateway message context. */

import { type ComponentBlockContent, parseInvocationCard } from "@meridian/contracts/components";
import { referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type {
  Block,
  StoredMediaPart,
  StoredTextPart,
  Thread,
  ToolContentPart,
  Turn,
} from "@meridian/contracts/threads";
import type {
  AssistantContentPart,
  MediaPart,
  Message,
  ReasoningPart,
  TextPart,
  Tool,
  ToolUsePart,
} from "@meridian-flow/runtime/gateway";
import { assistant, system, text, toolResult } from "@meridian-flow/runtime/gateway";
import { formatWorkSwitchedNotice, type Notice } from "../../notices/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  ChildCompletionMetadataCodec,
  ChildCompletionMetadataTagCodec,
} from "../../threads/index.js";
import { orderTurnsByPosition } from "../../threads/order-turns.js";
import { componentModelText } from "./component-model-text.js";
import { assembleComposedSystemPrompt, isThreadPromptFrozen } from "./composed-system-prompt.js";
import { describeMedia } from "./media-context.js";
import { referenceReadText } from "./reference-context.js";

export interface BuildContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  /**
   * The thread's system prompt: its frozen bake, or the would-be first bake
   * while unfrozen. Required once frozen; an unfrozen thread without one gets
   * the bare runtime instructions.
   */
  systemPrompt?: string;
  tools?: Tool[];
  /**
   * The recorded connection calls of a call that did not finish, by `connectionCallKey`: what the
   * stub tells the model beside "did not finish", so it can see what was sent.
   */
  recordedCalls?: ReadonlyMap<string, readonly string[]>;
  /** Dev observability for invalid persisted chat contracts. */
  eventSink?: EventSink;
}

/** The tools whose calls are recorded in `mcp_calls`: an unfinished one's stub lists its record. */
const CONNECTION_CALL_TOOLS: ReadonlySet<string> = new Set(["mcp_call", "mcp_run"]);

export const connectionCallKey = (turnId: string, toolCallId: string) => `${turnId}\n${toolCallId}`;

/** The assistant turns that have a connection tool call with no stored result: whose records the stub lists. */
export function turnsWithUnfinishedConnectionCalls(
  turns: readonly Turn[],
  blocks: readonly Block[],
): string[] {
  const answered = new Set(
    blocks.flatMap((block) =>
      block.blockType === "tool_result"
        ? [
            connectionCallKey(
              block.turnId as string,
              (block.content as { toolCallId?: string })?.toolCallId ?? "",
            ),
          ]
        : [],
    ),
  );
  const open = new Set<string>();
  for (const block of blocks) {
    if (block.blockType !== "tool_use") continue;
    const content = block.content as { toolCallId?: string; toolName?: string } | null;
    if (
      CONNECTION_CALL_TOOLS.has(content?.toolName ?? "") &&
      !answered.has(connectionCallKey(block.turnId as string, content?.toolCallId ?? ""))
    )
      open.add(block.turnId as string);
  }
  return turns.filter((turn) => open.has(turn.id as string)).map((turn) => turn.id as string);
}

export function buildContext(input: BuildContextInput): {
  messages: Message[];
  tools?: Tool[];
} {
  reportPersistedContractFailures(input);
  const messages: Message[] = [];
  const sourceTurnByMessage = new Map<Message, Turn>();

  if (isThreadPromptFrozen(input.thread) && input.systemPrompt === undefined)
    throw new Error(`Prompt bake is required for frozen thread ${input.thread.id}`);
  messages.push(system(input.systemPrompt ?? assembleComposedSystemPrompt({})));

  const blocksByTurn = new Map<string, Block[]>();
  for (const block of input.blocks) {
    const key = block.turnId as string;
    const list = blocksByTurn.get(key) ?? [];
    list.push(block);
    blocksByTurn.set(key, list);
  }

  for (const turn of orderTurnsByPosition(input.turns)) {
    const turnBlocks = blocksByTurn.get(turn.id as string) ?? [];
    const rendered = turnContextMessages(turn, turnBlocks);
    for (const message of rendered) {
      messages.push(message);
      if (message.role === "assistant") sourceTurnByMessage.set(message, turn);
    }
  }

  return {
    messages: mergeAdjacentUserMessages(
      completeToolResultGroups(messages, sourceTurnByMessage, input.recordedCalls),
    ),
    tools: input.tools?.length ? input.tools : undefined,
  };
}

/** One model-visible turn, shared by live requests and cold summary transcripts. */
export function turnContextMessages(turn: Turn, blocks: readonly Block[]): Message[] {
  const messages: Message[] = [];
  const turnBlocks = [...blocks].sort((a, b) => a.sequence - b.sequence);
  if (turn.role === "user") {
    const parts = userTurnContentParts(turnBlocks);
    if (parts.length > 0) {
      messages.push({ role: "user", content: parts });
    }
    return messages;
  }
  if (turn.role === "system") {
    const textParts = turnBlocks
      .flatMap((b) =>
        b.blockType === "text" && b.textContent
          ? [b.textContent]
          : b.blockType === "custom"
            ? [componentModelText(b.content as ComponentBlockContent)].filter(
                (v): v is string => !!v,
              )
            : [],
      )
      .join("\n");
    if (textParts) {
      const update =
        textParts.startsWith("<system_update>") && textParts.endsWith("</system_update>")
          ? textParts
          : `<system_update>\n${textParts}\n</system_update>`;
      messages.push({ role: "user", content: [text(update)] });
    }
    return messages;
  }

  if (turn.role === "assistant") {
    const assistantParts: AssistantContentPart[] = [];
    for (const block of turnBlocks) {
      if (block.blockType === "tool_result") {
        if (assistantParts.length > 0) {
          const message = assistant(assistantParts.slice());
          messages.push(message);
          assistantParts.length = 0;
        }
        const content = block.content as unknown as {
          toolCallId?: string;
          content: (ToolContentPart | MediaPart)[];
          isError?: boolean;
        };
        messages.push(
          toolResult(
            content.toolCallId ?? "",
            storedContentParts(content.content),
            content.isError,
          ),
        );
        continue;
      }
      const part = blockToAssistantPart(block);
      if (part) assistantParts.push(part);
    }
    if (assistantParts.length > 0) {
      const message = assistant(assistantParts.slice());
      messages.push(message);
    }
  }

  return messages;
}

function reportPersistedContractFailures(input: BuildContextInput): void {
  if (!input.eventSink) return;
  const threadId = input.thread.id as string;
  for (const turn of input.turns) {
    const metadata = turn.metadata;
    if (
      ChildCompletionMetadataTagCodec.safeParse(metadata).success &&
      !ChildCompletionMetadataCodec.safeParse(metadata).success
    ) {
      emitEvent(input.eventSink, {
        level: "warn",
        source: "runtime.context_builder",
        name: "chat.persisted_contract.invalid",
        correlation: { threadId, turnId: turn.id as string },
        sensitivity: "safe",
        payload: { field: "subagent_update" },
      });
    }
  }
  for (const block of input.blocks) {
    if (block.blockType !== "custom") continue;
    const content = block.content;
    if (
      !content ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      content.kind !== "helper-result" ||
      parseInvocationCard(content)
    ) {
      continue;
    }
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.context_builder",
      name: "chat.persisted_contract.invalid",
      correlation: { threadId, turnId: block.turnId as string },
      sensitivity: "safe",
      payload: { field: "invocation_card" },
    });
  }
}

/** Inbox turns retain durable graph identity but travel to the model as one delivery. */
function mergeAdjacentUserMessages(messages: readonly Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === "user" && message.role === "user") {
      merged[merged.length - 1] = {
        role: "user",
        content: [...previous.content, ...message.content],
      };
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function completeToolResultGroups(
  messages: readonly Message[],
  sourceTurnByMessage: ReadonlyMap<Message, Turn>,
  recordedCalls: ReadonlyMap<string, readonly string[]> = new Map(),
): Message[] {
  const completed: Message[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    completed.push(message);
    if (message.role !== "assistant") continue;

    const missingResultIds = new Set(
      message.content.flatMap((part) => (part.type === "tool_use" ? [part.toolCallId] : [])),
    );
    const sourceTurn = sourceTurnByMessage.get(message);
    if (missingResultIds.size === 0) continue;

    let nextIndex = index + 1;
    while (messages[nextIndex]?.role === "tool") {
      const toolMessage = messages[nextIndex];
      completed.push(toolMessage);
      for (const part of toolMessage.content) {
        if (part.type === "tool_result") missingResultIds.delete(part.toolCallId);
      }
      nextIndex++;
    }
    index = nextIndex - 1;

    const unfinished =
      sourceTurn?.status === "cancelled"
        ? "Tool call cancelled; no result recorded."
        : "Tool call did not finish: the turn ended before it returned (for example, Flow's server restarted); no result recorded. This is not a time limit.";
    const missingResultMessage = `${unfinished} Side effects unknown — re-read state before retrying.`;
    for (const toolCallId of missingResultIds) {
      const recorded = sourceTurn
        ? recordedCalls.get(connectionCallKey(sourceTurn.id, toolCallId))
        : undefined;
      const stub = recorded?.length
        ? `${unfinished}\n${recorded.join("\n")}`
        : missingResultMessage;
      completed.push(toolResult(toolCallId, [text(stub)], true));
    }
  }

  return completed;
}

/**
 * A tool result's parts as the gateway's. Request preparation has already turned each stored media
 * part into the gateway's part or into text; one it never saw (an estimate before projection)
 * is described as text.
 */
function storedContentParts(
  parts: readonly (ToolContentPart | MediaPart)[],
): (TextPart | MediaPart)[] {
  return parts.map((part) =>
    part.type === "media" && "source" in part
      ? part
      : text(
          part.type === "media"
            ? describeMedia(part as StoredMediaPart)
            : (part as StoredTextPart).text,
        ),
  );
}

/** Projects a user turn's allowed blocks and reference results; images arrive pre-projected. */
function userTurnContentParts(blocks: readonly Block[]): (TextPart | MediaPart)[] {
  const parts: (TextPart | MediaPart)[] = [];
  for (const block of blocks) {
    const part = blockToUserPart(block);
    if (part) parts.push(part);
  }
  const included = new Set<string>();
  for (const block of blocks) {
    if (block.blockType === "custom") {
      const content = block.content as ComponentBlockContent;
      if (content.kind === "thread-reference") {
        const modelText = componentModelText(content);
        if (modelText) parts.push(text(`\n\n${modelText}`));
      }
    }
    const reference = referenceOccurrenceContent(block);
    if (reference?.kind !== "document" || !reference.read) continue;
    const key = `${reference.documentId}\0${reference.uri}`;
    if (included.has(key)) continue;
    included.add(key);
    parts.push(
      text(
        `\n\nReference read result for ${reference.uri}:\n${referenceReadText(reference.read.result)}`,
      ),
    );
    const media = reference.read.media;
    if (typeof media === "string") parts.push(text(`\n${media}`));
    else if (media) parts.push(media as unknown as MediaPart);
  }
  return parts;
}

/** A user turn's text and projected media. Reference blocks are added separately by `userTurnContentParts`; other blocks map to no part. */
function blockToUserPart(block: Block): TextPart | MediaPart | null {
  switch (block.blockType) {
    case "text":
      return block.textContent ? text(block.textContent) : null;
    case "media": {
      // Only a projected picture carries a source; the stored part holds identity alone.
      const image = block.content as Partial<MediaPart> | null;
      return image?.type === "media" && image.source ? (image as MediaPart) : null;
    }
    default:
      return null;
  }
}

/** An assistant turn's text, reasoning and tool use; no provider takes media from the model. */
function blockToAssistantPart(block: Block): AssistantContentPart | null {
  switch (block.blockType) {
    case "text":
      return block.textContent ? text(block.textContent) : null;
    case "reasoning": {
      const content =
        block.content && typeof block.content === "object" && !Array.isArray(block.content)
          ? (block.content as {
              text?: unknown;
              providerOptions?: unknown;
            })
          : null;
      const reasoningText =
        typeof content?.text === "string" ? content.text : (block.textContent ?? "");
      const hasProviderOptions =
        content?.providerOptions &&
        typeof content.providerOptions === "object" &&
        !Array.isArray(content.providerOptions);
      if (!reasoningText && !hasProviderOptions) return null;
      return {
        type: "reasoning",
        text: reasoningText,
        ...(hasProviderOptions
          ? { providerOptions: content.providerOptions as ReasoningPart["providerOptions"] }
          : {}),
      };
    }
    case "tool_use": {
      const content = block.content as {
        toolCallId?: string;
        toolName?: string;
        input?: Record<string, unknown>;
      } | null;
      return {
        type: "tool_use",
        toolCallId: content?.toolCallId ?? "",
        toolName: content?.toolName ?? "",
        input: content?.input ?? {},
      } satisfies ToolUsePart;
    }
    // Interrupt content stays in its tool input/result to preserve provider ordering.
    default:
      return null;
  }
}

export function formatNotices(notices: readonly Notice[]): string {
  const sections: string[] = [];
  const undoNotices = notices.filter((notice) => notice.kind === "undo");
  if (undoNotices.length > 0) sections.push(formatUndoNotices(undoNotices));
  for (const notice of notices) {
    if (notice.kind === "undo") continue;
    sections.push(formatNotice(notice));
  }
  return sections.filter(Boolean).join("\n\n");
}

function formatNotice(notice: Notice): string {
  if (notice.kind === "work_switched") {
    return formatWorkSwitchedNotice(notice.data) ?? notice.message;
  }
  const documentName =
    stringData(notice, "documentName") ?? stringData(notice, "documentId") ?? "the document";
  if (notice.kind === "awareness_degraded") {
    const documentNames = Array.isArray(notice.data.documentNames)
      ? notice.data.documentNames.filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        )
      : [];
    const affectedDocuments = documentNames.length > 0 ? documentNames.join(", ") : documentName;
    const noun = documentNames.length > 1 ? "documents" : "document";
    return `The system could not verify whether concurrent user content was preserved in ${affectedDocuments}. Re-read the ${noun} before making another write.`;
  }
  return notice.message;
}

function formatUndoNotices(notices: readonly Notice[]): string {
  const notifications = notices.flatMap((notice) => {
    const data = notice.data;
    return typeof data.turnId === "string"
      ? [
          {
            uri: typeof data.uri === "string" ? data.uri : "",
            turnId: data.turnId,
            direction: data.direction === "redo" ? ("redo" as const) : ("undo" as const),
          },
        ]
      : [];
  });
  const first = new Map<string, (typeof notifications)[number]>();
  const latest = new Map<string, (typeof notifications)[number]>();
  for (const notification of notifications) {
    const key = `${notification.uri}::${notification.turnId}`;
    if (!first.has(key)) first.set(key, notification);
    latest.set(key, notification);
  }
  // Reversals in one undelivered batch cancel in pairs. A standalone redo
  // restores an edit whose undo the model already saw in an earlier batch.
  const changes = [...latest.entries()]
    .filter(([key, notification]) => first.get(key)?.direction === notification.direction)
    .map(([, notification]) => notification);
  const sections: string[] = [];
  for (const direction of ["undo", "redo"] as const) {
    // URI, not basename, identifies a document; distinct documents can share a name.
    const grouped = new Map<string, string>();
    for (const notification of changes.filter((change) => change.direction === direction)) {
      const key = notification.uri || notification.turnId;
      const label = filenameFromUri(notification.uri) || notification.uri || notification.turnId;
      grouped.set(key, label);
    }
    const lines = Array.from(grouped.values(), (label) => `- ${label}`);
    if (lines.length === 0) continue;
    sections.push(
      [
        `The user ${direction === "undo" ? "reversed" : "restored"} the following edits before this message:`,
        ...lines,
        ...(direction === "undo" ? ["They are signaling these changes were unwanted."] : []),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function stringData(notice: Notice, key: string): string | null {
  const value = notice.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function filenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash >= 0 && lastSlash < trimmed.length - 1) {
    return decodeURIComponent(trimmed.slice(lastSlash + 1));
  }
  return uri;
}
