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

import type { WriteObservationEvidence } from "@meridian/agent-edit";
import type { Block, JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import type { Notice } from "../../notices/index.js";
import { assistant, system, text, toolResult } from "../gateway/helpers/messages.js";
import type { ContentPart, Message, Tool, ToolUsePart } from "../gateway/index.js";
import { isThreadPromptFrozen } from "./composed-system-prompt.js";

export const RUNTIME_URI_SYSTEM_INSTRUCTION =
  "Context file URI rules: bare file paths resolve as `manuscript://` -- the writer's manuscript documents. `kb://` is the project knowledge base (durable reference: characters, places, canon). `scratch://` holds working files for this work item -- plans, notes, intermediate material; never the manuscript. It belongs to this work item only: switch work items and you are in a different scratch space. Anything meant to outlive this work item belongs in `kb://` or the manuscript. `uploads://` holds files the writer attached to this work item (same scoping). `user://` is the writer's personal files. Use `write` with command=create/read/insert/replace/undo/redo for document content; use `ls` and `grep` for discovery.";

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
}

export type RequestObservationEvidence = WriteObservationEvidence & { documentId: string };

/** Documents whose persisted tool output can serialize observation evidence into this request. */
export function observationDocumentIds(blocks: readonly Block[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.blockType !== "tool_result" || block.pruned) continue;
    const content = block.content as Parameters<typeof evidenceProvenByOutput>[0];
    for (const evidence of evidenceProvenByOutput(content)) ids.add(evidence.documentId);
  }
  return [...ids].sort();
}

export function buildContext(input: BuildContextInput): {
  messages: Message[];
  tools?: Tool[];
  observationEvidence: RequestObservationEvidence[];
} {
  const messages: Message[] = [];
  const sourceTurnStatusByMessage = new Map<Message, Turn["status"]>();
  const observationEvidence: RequestObservationEvidence[] = [];

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

  // Group blocks by turn, then sort each group by sequence number.
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of input.blocks) {
    if (block.pruned) continue;
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
            const message = assistant(assistantParts.slice());
            messages.push(message);
            sourceTurnStatusByMessage.set(message, turn.status);
            assistantParts.length = 0;
          }
          const content = block.content as {
            toolCallId?: string;
            output?: JsonValue;
            isError?: boolean;
            metadata?: {
              documentId?: unknown;
              observationEvidence?: unknown;
            };
          } | null;
          const toolCallId = content?.toolCallId ?? "";
          messages.push(
            toolResult(toolCallId, content?.output ?? block.textContent ?? null, content?.isError),
          );
          observationEvidence.push(...evidenceProvenByOutput(content));
          continue;
        }
        const part = blockToContentPart(block);
        if (part) assistantParts.push(part);
      }
      if (assistantParts.length > 0) {
        const message = assistant(assistantParts.slice());
        messages.push(message);
        sourceTurnStatusByMessage.set(message, turn.status);
      }
    }
  }

  return {
    messages: completeToolResultGroups(messages, sourceTurnStatusByMessage),
    tools: input.tools?.length ? input.tools : undefined,
    observationEvidence,
  };
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
        ? "Cancelled before a result was recorded; outcome unknown."
        : "Run failed before a result was recorded; outcome unknown.";
    for (const toolCallId of missingResultIds) {
      completed.push(toolResult(toolCallId, missingResultMessage, true));
    }
  }

  return completed;
}

function evidenceProvenByOutput(
  content: {
    output?: JsonValue;
    metadata?: { documentId?: unknown; observationEvidence?: unknown };
  } | null,
): RequestObservationEvidence[] {
  const documentId = content?.metadata?.documentId;
  const evidence = content?.metadata?.observationEvidence;
  if (typeof documentId !== "string" || !Array.isArray(evidence)) return [];
  const serializedOutput = JSON.stringify(content?.output ?? null);
  return evidence.flatMap((value) => {
    if (
      !isWriteObservationEvidence(value) ||
      !serializedOutput.includes(JSON.stringify(value.sourceText).slice(1, -1))
    ) {
      return [];
    }
    return [{ documentId, ...value }];
  });
}

function isWriteObservationEvidence(value: unknown): value is WriteObservationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as WriteObservationEvidence;
  return (
    Number.isSafeInteger(evidence.clientID) &&
    Number.isSafeInteger(evidence.clock) &&
    typeof evidence.sourceText === "string" &&
    ((evidence.kind === "rendered" && typeof evidence.renderedContent === "string") ||
      (evidence.kind === "explicit_deletion" && typeof evidence.capturedBody === "string"))
  );
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

export function safetyNoticeSystemMessage(notices: readonly Notice[]): Message | null {
  const content = formatSafetyNotices(notices);
  return content ? system(content) : null;
}

export function formatSafetyNotices(notices: readonly Notice[]): string {
  const sections: string[] = [];
  const undoNotices = notices.filter((notice) => notice.kind === "undo");
  if (undoNotices.length > 0) sections.push(formatUndoNotices(undoNotices));
  for (const notice of notices) {
    if (notice.kind === "undo") continue;
    sections.push(formatSafetyNotice(notice));
  }
  return sections.filter(Boolean).join("\n\n");
}

function formatSafetyNotice(notice: Notice): string {
  if (notice.kind === "rejection") return notice.message;
  const documentName =
    stringData(notice, "documentName") ?? stringData(notice, "documentId") ?? "the document";
  if (
    notice.kind === "late_sweep" ||
    notice.kind === "push_swept" ||
    notice.kind === "checkpoint_sweep"
  ) {
    return "";
  }
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
  // Group by uri (the document identity), not filename — distinct docs can share
  // a basename, and merging their handles would mislabel which file changed.
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
