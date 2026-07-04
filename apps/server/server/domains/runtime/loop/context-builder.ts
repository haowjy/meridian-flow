/**
 * Context builder: assembles a thread's turns and blocks into the canonical
 * Message[] sent to the gateway for the next model call. Owns the
 * thread-history → model-context projection.
 *
 * Key design decisions:
 *
 * - **Block ordering within a turn**: blocks are sorted by `sequence`
 *   (ascending).  This is the persisted order from the orchestrator's
 *   blockSeq allocation — content blocks appear in adapter output order
 *   (Anthropic content-block index / OpenAI Responses output_index),
 *   followed by synthesized tool_use blocks, then tool_result blocks.
 *
 * - **Tool_result interleaving**: when an assistant turn contains
 *   tool_result blocks, the builder emits an assistant message for the
 *   content parts *before* the first tool_result, then a separate `tool`
 *   role message for each tool_result, then another assistant message for
 *   content parts after the last tool_result. This matches the gateway's
 *   message format where tool results are distinct messages, not inline
 *   content parts of the assistant message.
 *
 * - **Frozen system prompt**: on first attempt the orchestrator bakes agent body,
 *   skills catalog, and URI guidance into `composedSystemPrompt`. Later turns
 *   send that string verbatim (byte-identical). Subagent threads may arrive
 *   pre-frozen at creation. Autoprune is the only future re-bake trigger.
 *
 * - **Runtime URI guidance**: the server appends storage-scheme instructions
 *   to every thread prompt so the model chooses `kb://` for knowledge-base
 *   files while bare paths continue to resolve as `manuscript://`.
 *
 * - **Working state injection**: if `thread.workingState` is set, it's
 *   injected as a separate system message containing JSON-serialized state.
 *   This gives the model persistent scratch space across turns.
 *
 * - **Custom block filtering**: custom blocks are UI surfaces only. Interrupt
 *   Q&A already travels through the ask_user tool_use input and tool_result
 *   output; projecting the UI block into the assistant message would break
 *   Anthropic's required tool_use→tool_result adjacency.
 *
 * - **User turns**: all blocks of allowed types (text, image, file)
 *   are merged into a single user message's content[] array.
 *
 * - **System turns**: text blocks from system-role turns are concatenated
 *   into a single system message — they appear as multi-line system
 *   content, not as turn-structured data.
 */
import type { Block, JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import type { DraftLifecycleState } from "../../collab/domain/drafts.js";
import type { PendingUndoNotification } from "../../undo-notifications/index.js";
import { assistant, system, text, toolResult } from "../gateway/helpers/messages.js";
import type { ContentPart, Message, Tool, ToolUsePart } from "../gateway/index.js";
import { isThreadPromptFrozen } from "./composed-system-prompt.js";

export const RUNTIME_URI_SYSTEM_INSTRUCTION =
  "Context file URI rules: bare file paths resolve as manuscript:// project workspace files. Use explicit kb:// URIs for project knowledge-base files. Use write with command=create/read/insert/replace/undo/redo for document content; use list and search for discovery.";

export interface BuildContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  tools?: Tool[];
  /**
   * Skills catalog for pre-freeze assembly only. Ignored when
   * `thread.composedSystemPrompt` is already frozen.
   */
  skillsSystemPromptSection?: string;
  undoNotifications?: readonly PendingUndoNotification[];
  draftLifecycleStates?: readonly DraftLifecycleState[];
}

export function buildContext(input: BuildContextInput): { messages: Message[]; tools?: Tool[] } {
  const messages: Message[] = [];

  const composed = input.thread.composedSystemPrompt;
  if (composed && isThreadPromptFrozen(input.thread)) {
    messages.push(system(composed));
  } else {
    const systemPrompt = composed ?? input.thread.systemPrompt;
    messages.push(
      system(
        [systemPrompt, input.skillsSystemPromptSection, RUNTIME_URI_SYSTEM_INSTRUCTION]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }

  // Working state injected as a separate system message so the model sees
  // persistent scratch state at every turn.
  if (input.thread.workingState) {
    messages.push(system(`Working state:\n${JSON.stringify(input.thread.workingState)}`));
  }

  if (input.undoNotifications?.length) {
    messages.push(undoNotificationSystemMessage(input.undoNotifications));
  }

  if (input.draftLifecycleStates?.length) {
    messages.push(
      draftLifecycleStateSystemMessage(
        input.draftLifecycleStates,
        lastAssistantTurnCreatedAt(input.turns),
      ),
    );
  }

  // Group blocks by turn, then sort each group by sequence number.
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of input.blocks) {
    const key = block.turnId as string;
    const list = blocksByTurn.get(key) ?? [];
    list.push(block);
    blocksByTurn.set(key, list);
  }
  for (const list of blocksByTurn.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  for (const turn of input.turns) {
    const turnBlocks = blocksByTurn.get(turn.id as string) ?? [];
    if (turn.role === "user") {
      const parts = turnBlocksToContentParts(turnBlocks, ["text", "image", "file"]);
      if (parts.length > 0) {
        messages.push({ role: "user", content: parts });
      }
      continue;
    }
    if (turn.role === "system") {
      const textParts = turnBlocks
        .flatMap((b) => (b.blockType === "text" && b.textContent ? [b.textContent] : []))
        .join("\n");
      if (textParts) messages.push(system(textParts));
      continue;
    }

    if (turn.role === "assistant") {
      const assistantParts: ContentPart[] = [];
      for (const block of turnBlocks) {
        // tool_result blocks split the assistant message: flush accumulated
        // content parts as an assistant message, then emit the tool result
        // as a separate tool-role message.
        if (block.blockType === "tool_result") {
          if (assistantParts.length > 0) {
            messages.push(assistant(assistantParts.slice()));
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
        messages.push(assistant(assistantParts.slice()));
      }
    }
  }

  return {
    messages,
    tools: input.tools?.length ? input.tools : undefined,
  };
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

// Converts a single block into a gateway ContentPart.
// Returns null for blocks whose content cannot be represented as a
// gateway content part (e.g. empty text blocks, malformed JSON content).
// reasoning blocks extract `text` from a structured content object or
// fall back to `textContent`; providerOptions are preserved if present.
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
      // Custom blocks are UI-only. For interrupts, the tool_use input carries
      // the question/options and the tool_result carries the answer; adding a
      // text summary here would separate Anthropic tool_use blocks from their
      // required immediately-following tool_result blocks.
      return null;
    default:
      return null;
  }
}

export function undoNotificationSystemMessage(
  notifications: readonly PendingUndoNotification[],
): Message {
  return system(formatUndoNotificationMessage(notifications));
}

export function formatUndoNotificationMessage(
  notifications: readonly PendingUndoNotification[],
): string {
  // Group by uri (the document identity), not filename — distinct docs can share
  // a basename, and merging their handles would mislabel which file changed.
  const grouped = new Map<string, { label: string; handles: string[] }>();
  for (const notification of notifications) {
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
  return [
    "The writer reversed the following edits before this message:",
    ...lines,
    "They are signaling these changes were unwanted.",
  ].join("\n");
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

export function draftLifecycleStateSystemMessage(
  states: readonly DraftLifecycleState[],
  lastAssistantCreatedAt?: Date,
): Message {
  return system(formatDraftLifecycleStateMessage(states, lastAssistantCreatedAt));
}

export function formatDraftLifecycleStateMessage(
  states: readonly DraftLifecycleState[],
  lastAssistantCreatedAt?: Date,
): string {
  const lines = states.map((state) => {
    const documentName = state.documentName || state.documentId;
    if (
      state.status === "active" &&
      state.partialAcceptedOperationCount !== null &&
      state.proposedOperationCount !== null &&
      state.partialAcceptedOperationCount > 0
    ) {
      return `- ${documentName}: ${state.partialAcceptedOperationCount} of ${state.proposedOperationCount} proposed operations applied${formatLifecycleAnchor(
        state.partialAcceptedAt ?? state.updatedAt,
        lastAssistantCreatedAt,
      )}; the remaining proposal is active and open for review.`;
    }
    if (state.status === "active" && state.undoneAt) {
      return `- ${documentName}: the writer undid this draft at ${formatLifecycleTime(
        state.undoneAt,
        lastAssistantCreatedAt,
      )}; the draft is active and open for review again.`;
    }
    if (state.status === "applied" && state.appliedAt) {
      return `- ${documentName}: the writer applied this draft at ${formatLifecycleTime(
        state.appliedAt,
        lastAssistantCreatedAt,
      )}.`;
    }
    if (state.status === "discarded" && state.discardedAt) {
      return `- ${documentName}: the writer discarded this draft at ${formatLifecycleTime(
        state.discardedAt,
        lastAssistantCreatedAt,
      )}.`;
    }
    return `- ${documentName}: draft status is ${state.status}; last lifecycle update was ${formatLifecycleTime(
      state.updatedAt,
      lastAssistantCreatedAt,
    )}.`;
  });
  return [
    "Current draft review state for this work:",
    ...lines,
    "Use this as durable context about what the writer accepted, rejected, or reopened.",
  ].join("\n");
}

function formatLifecycleTime(date: Date, lastAssistantCreatedAt?: Date): string {
  return `${date.toISOString()}${formatLifecycleAnchor(date, lastAssistantCreatedAt)}`;
}

function formatLifecycleAnchor(date: Date, lastAssistantCreatedAt?: Date): string {
  if (!lastAssistantCreatedAt || date.getTime() <= lastAssistantCreatedAt.getTime()) return "";
  return " (this happened after your last reply)";
}

function lastAssistantTurnCreatedAt(turns: readonly Turn[]): Date | undefined {
  let latest: Date | undefined;
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const createdAt = new Date(turn.createdAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    if (!latest || createdAt > latest) latest = createdAt;
  }
  return latest;
}
