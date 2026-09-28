/** Projects persisted turns and blocks into the canonical gateway message context. */

import { type ComponentBlockContent, parseInvocationCard } from "@meridian/contracts/components";
import { referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import { formatWorkSwitchedNotice, type Notice } from "../../notices/index.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  ChildCompletionMetadataCodec,
  ChildCompletionMetadataTagCodec,
} from "../../threads/index.js";
import { orderTurnsByPosition } from "../../threads/order-turns.js";
import { assistant, system, text, toolResult } from "../gateway/helpers/messages.js";
import type { ContentPart, Message, Tool, ToolUsePart } from "../gateway/index.js";
import { assembleComposedSystemPrompt, isThreadPromptFrozen } from "./composed-system-prompt.js";

export interface BuildContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  /** Immutable bake read by the assembler when the thread already has a pointer. */
  frozenSystemPrompt?: string;
  tools?: Tool[];
  /** Raw agent/project prompt used only while the thread prompt is not frozen. */
  unfrozenBasePrompt?: string | null;
  /** Additive per-invocation prompt layer, pre-freeze only. */
  appendPrompt?: string | null;
  /**
   * Available skill listings for pre-freeze assembly only.
   * Ignored when the thread prompt is already frozen.
   */
  availableSkills?: readonly { slug: string; name: string; description: string }[];
  /**
   * Named subagent listings for pre-freeze assembly only.
   * Ignored when the thread prompt is already frozen.
   */
  namedSubagents?: readonly { slug: string; name: string; description: string }[];
  /** Frozen Work section for a would-be first bake. */
  workContext?: string;
  /** Subagent closing instruction; pre-freeze only, owns the prompt's last layer. */
  subagentGuidance?: string | null;
  /** Dev observability for invalid persisted chat contracts. */
  eventSink?: EventSink;
}

export function buildContext(input: BuildContextInput): {
  messages: Message[];
  tools?: Tool[];
} {
  reportPersistedContractFailures(input);
  const messages: Message[] = [];
  const sourceTurnStatusByMessage = new Map<Message, Turn["status"]>();

  if (isThreadPromptFrozen(input.thread)) {
    if (input.frozenSystemPrompt === undefined)
      throw new Error(`Prompt bake is required for frozen thread ${input.thread.id}`);
    messages.push(system(input.frozenSystemPrompt));
  } else {
    messages.push(
      system(
        assembleComposedSystemPrompt({
          basePrompt: input.unfrozenBasePrompt,
          appendPrompt: input.appendPrompt,
          workContext: input.workContext,
          availableSkills: input.availableSkills,
          namedSubagents: input.namedSubagents,
          subagentGuidance: input.subagentGuidance,
        }),
      ),
    );
  }

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
      if (message.role === "assistant") sourceTurnStatusByMessage.set(message, turn.status);
    }
  }

  return {
    messages: mergeAdjacentUserMessages(
      completeToolResultGroups(messages, sourceTurnStatusByMessage),
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
    const assistantParts: ContentPart[] = [];
    for (const block of turnBlocks) {
      if (block.blockType === "tool_result") {
        if (assistantParts.length > 0) {
          const message = assistant(assistantParts.slice());
          messages.push(message);
          assistantParts.length = 0;
        }
        const content = block.content as {
          toolCallId?: string;
          output?: JsonValue;
          isError?: boolean;
        } | null;
        const toolCallId = content?.toolCallId ?? "";
        messages.push(
          toolResult(toolCallId, content?.output ?? block.textContent ?? null, content?.isError),
        );
        continue;
      }
      const part = blockToContentPart(block);
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
  sourceTurnStatusByMessage: ReadonlyMap<Message, Turn["status"]>,
): Message[] {
  const completed: Message[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    completed.push(message);
    if (message.role !== "assistant") continue;

    const missingResultIds = new Set(
      message.content.flatMap((part) => (part.type === "tool_use" ? [part.toolCallId] : [])),
    );
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

    const missingResultMessage =
      sourceTurnStatusByMessage.get(message) === "cancelled"
        ? "Tool call cancelled; no result recorded. Side effects unknown — re-read state before retrying."
        : "Tool call interrupted by an error; no result recorded. Side effects unknown — re-read state before retrying.";
    for (const toolCallId of missingResultIds) {
      completed.push(toolResult(toolCallId, missingResultMessage, true));
    }
  }

  return completed;
}

function turnBlocksToContentParts(blocks: Block[], allowed: Block["blockType"][]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    if (!allowed.includes(block.blockType)) continue;
    const part = blockToContentPart(block);
    if (part) parts.push(part);
  }
  return parts;
}

/** Projects a user turn's allowed blocks and reference results; images arrive pre-projected. */
function userTurnContentParts(blocks: readonly Block[]): ContentPart[] {
  const parts = turnBlocksToContentParts([...blocks], ["text", "image", "file"]);
  const included = new Set<string>();
  for (const block of blocks) {
    const reference = referenceOccurrenceContent(block);
    if (!reference?.read) continue;
    const key = `${reference.documentId}\0${reference.uri}`;
    if (included.has(key)) continue;
    included.add(key);
    parts.push(
      text(
        `\n\nReference read result for ${reference.uri}:\n${JSON.stringify(reference.read.result)}`,
      ),
    );
  }
  return parts;
}

// Pre-admission failures are model context; saved run reports remain transcript UI.
export function componentModelText(content: ComponentBlockContent): string | null {
  if (content.kind !== "helper-result") return null;
  const props = parseInvocationCard(content);
  if (!props || props.terminalAt === null) return null;
  if ("reason" in props) {
    return `Subagent "${props.agentName}" could not start: ${props.reason}`;
  }
  return null;
}

// Unsupported or empty blocks have no gateway content part.
function blockToContentPart(block: Block): ContentPart | null {
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
          ? {
              providerOptions: content.providerOptions as Extract<
                ContentPart,
                { type: "reasoning" }
              >["providerOptions"],
            }
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
    case "image":
    case "file":
      if (block.content && typeof block.content === "object") {
        return block.content as unknown as ContentPart;
      }
      return null;
    case "custom":
      // Interrupt content stays in its tool input/result to preserve provider ordering.
      return null;
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
    return `The system could not verify whether concurrent writer content was preserved in ${affectedDocuments}. Re-read the ${noun} before making another write.`;
  }
  return notice.message;
}

function formatUndoNotices(notices: readonly Notice[]): string {
  const notifications = notices.flatMap((notice) => {
    const data = notice.data;
    const handles = Array.isArray(data.writeHandles)
      ? data.writeHandles.filter((handle): handle is string => typeof handle === "string")
      : [];
    return handles.map((writeHandle) => ({
      uri: typeof data.uri === "string" ? data.uri : "",
      writeHandle,
      direction: data.direction === "redo" ? ("redo" as const) : ("undo" as const),
    }));
  });
  const latest = new Map<string, (typeof notifications)[number]>();
  for (const notification of notifications) {
    latest.set(`${notification.uri}::${notification.writeHandle}`, notification);
  }
  const reversals = [...latest.values()].filter(
    (notification) => notification.direction === "undo",
  );
  // URI, not basename, identifies a document; distinct documents can share a name.
  const grouped = new Map<string, { label: string; handles: string[] }>();
  for (const notification of reversals) {
    const key = notification.uri || notification.writeHandle;
    const label = filenameFromUri(notification.uri) || notification.uri || notification.writeHandle;
    const entry = grouped.get(key) ?? { label, handles: [] };
    entry.handles.push(notification.writeHandle);
    grouped.set(key, entry);
  }

  const lines = Array.from(
    grouped.values(),
    ({ label, handles }) => `- ${label}: ${handles.join(", ")}`,
  );
  return lines.length > 0
    ? [
        "The writer reversed the following edits before this message:",
        ...lines,
        "They are signaling these changes were unwanted.",
      ].join("\n")
    : "";
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
  const schemeSeparator = trimmed.indexOf("://");
  if (schemeSeparator >= 0 && schemeSeparator < trimmed.length - 3) {
    return decodeURIComponent(trimmed.slice(schemeSeparator + 3));
  }
  return uri;
}
