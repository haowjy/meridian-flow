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
 * - **Frozen system prompt**: on first attempt the orchestrator bakes the
 *   immutable agent body, the spawn-time append layer, available skill names and
 *   descriptions, named subagent slug/name/description, document dialect, URI
 *   guidance, and (subagent threads only) the closing report instruction into
 *   `composedSystemPrompt`. Later turns send that string verbatim
 *   (byte-identical). Autoprune is the only future re-bake trigger.
 *
 * - **Runtime URI guidance**: the server appends storage-scheme instructions
 *   to every thread prompt so the model chooses `kb://` for knowledge-base
 *   files while bare paths continue to resolve as `manuscript://`.
 *
 * - **Working state injection**: if `thread.workingState` is set, it's
 *   injected as a separate system message containing JSON-serialized state.
 *   This gives the model persistent scratch space across turns.
 *
 * - **Custom block filtering**: custom blocks are UI surfaces. Interrupt Q&A
 *   already travels through the ask_user tool_use input and tool_result output;
 *   projecting the UI block into the assistant message would break Anthropic's
 *   required tool_use→tool_result adjacency. System turns are the one exception:
 *   a completed `helper-result` card projects as text so the parent model reads
 *   a background child's report, while the writer keeps the card.
 *
 * - **User turns**: all blocks of allowed types (text, image, file)
 *   are merged into a single user message's content[] array.
 *
 * - **Activated skill bodies**: slash-activated SKILL.md is appended as extra
 *   request-only text on the current user message (slug, description, body).
 *   Not a fabricated tool round, not persisted, not frozen prompt bytes.
 *
 * - **System turns**: text blocks from system-role turns are concatenated
 *   into a single system message — they appear as multi-line system
 *   content, not as turn-structured data.
 */

import type { ComponentBlockContent, HelperResultProps } from "@meridian/contracts/components";
import { referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue, Thread, Turn } from "@meridian/contracts/threads";
import { formatWorkSwitchedNotice, type Notice } from "../../notices/index.js";
import { assistant, system, text, toolResult } from "../gateway/helpers/messages.js";
import type { ContentPart, Message, Tool, ToolUsePart } from "../gateway/index.js";
import { assembleComposedSystemPrompt, isThreadPromptFrozen } from "./composed-system-prompt.js";

/** A request-only skill body inlined onto the activating writer message. */
export interface ActivatedSkillBody {
  slug: string;
  description: string;
  body: string;
}

export interface BuildContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  skillBodiesByTurn?: ReadonlyMap<string, readonly ActivatedSkillBody[]>;
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
}

export function buildContext(input: BuildContextInput): {
  messages: Message[];
  tools?: Tool[];
} {
  const messages: Message[] = [];
  const sourceTurnStatusByMessage = new Map<Message, Turn["status"]>();

  const composed = input.thread.composedSystemPrompt;
  if (composed && isThreadPromptFrozen(input.thread)) {
    messages.push(system(composed));
  } else {
    const systemPrompt = input.unfrozenBasePrompt ?? composed;
    messages.push(
      system(
        assembleComposedSystemPrompt({
          basePrompt: systemPrompt,
          appendPrompt: input.appendPrompt,
          workContext: input.workContext,
          availableSkills: input.availableSkills,
          namedSubagents: input.namedSubagents,
          subagentGuidance: input.subagentGuidance,
        }),
      ),
    );
  }

  if (input.thread.workingState) {
    messages.push(system(`Working state:\n${JSON.stringify(input.thread.workingState)}`));
  }

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
      const parts = userTurnContentParts(turnBlocks);
      const skills = input.skillBodiesByTurn?.get(turn.id);
      if (skills?.length) parts.push(text(skills.map(formatInvokedSkill).join("\n\n")));
      if (parts.length > 0) {
        messages.push({ role: "user", content: parts });
      }
      continue;
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
      if (textParts) messages.push(system(textParts));
      continue;
    }

    if (turn.role === "assistant") {
      const assistantParts: ContentPart[] = [];
      for (const block of turnBlocks) {
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
        sourceTurnStatusByMessage.set(message, turn.status);
      }
    }
  }

  return {
    messages: completeToolResultGroups(messages, sourceTurnStatusByMessage),
    tools: input.tools?.length ? input.tools : undefined,
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

/**
 * The model-facing content parts for one user turn: its allowed blocks plus any
 * persisted reference read results. Images must already be projected by the
 * shared request assembler, whether the turn is historical or newly adopted.
 */
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

// Projects a system-turn custom card into the model-facing text. Only the
// delivered background report (`helper-result`) has model meaning; the card
// itself stays in the writer transcript. A running card has nothing to report.
// Artifact refs are included so a report never loses what it produced.
export function componentModelText(content: ComponentBlockContent): string | null {
  if (content.kind !== "helper-result") return null;
  const props = content.props as HelperResultProps;
  if (props.status === "running") return null;
  const lines = [
    `Background subagent "${props.agentName}" ${props.status === "failed" ? "failed" : "reported"}.`,
    props.summary ?? "",
    props.payload !== undefined ? JSON.stringify(props.payload) : "",
    props.artifacts !== undefined && props.artifacts.length > 0
      ? JSON.stringify(props.artifacts)
      : "",
  ].filter(Boolean);
  return lines.join("\n");
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

/**
 * Appends to the last user message by default. Callers that have already
 * appended other user messages (a drained message) pass `targetIndex` to pin the
 * attachment to the writer's triggering message instead.
 */
export function attachSkillBodiesToLatestUserMessage(
  messages: readonly Message[],
  skills: readonly ActivatedSkillBody[],
  targetIndex?: number,
): Message[] {
  if (skills.length === 0) return [...messages];
  return appendTextToUserMessage(
    messages,
    skills.map(formatInvokedSkill).join("\n\n"),
    "skill bodies",
    targetIndex,
  );
}

function formatInvokedSkill(skill: ActivatedSkillBody): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    `skill invoked: ${skill.slug}`,
    ...(description ? ["", `description: ${description}`] : []),
    "",
    skill.body,
  ].join("\n");
}

export function attachNoticesToLatestUserMessage(
  messages: readonly Message[],
  notices: readonly Notice[],
  targetIndex?: number,
): Message[] {
  const content = formatNotices(notices);
  if (!content) return [...messages];
  return appendTextToUserMessage(
    messages,
    `\n\nMeridian context for this message:\n${content}`,
    "pre-turn notices",
    targetIndex,
  );
}

/** Index of the last user-role message, or undefined when there is none. */
export function lastUserMessageIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return undefined;
}

function appendTextToUserMessage(
  messages: readonly Message[],
  value: string,
  label: string,
  targetIndex?: number,
): Message[] {
  const updated = [...messages];
  const part = text(value);
  if (targetIndex !== undefined) {
    const message = updated[targetIndex];
    if (message?.role !== "user") {
      throw new Error(`Cannot attach ${label}: message ${targetIndex} is not a writer message`);
    }
    updated[targetIndex] = { ...message, content: [...message.content, part] };
    return updated;
  }
  const index = lastUserMessageIndex(updated);
  if (index === undefined) {
    throw new Error(`Cannot attach ${label} without a writer message`);
  }
  const message = updated[index] as Message;
  updated[index] = { ...message, content: [...message.content, part] };
  return updated;
}

export function insertPostToolNotices(
  messages: readonly Message[],
  notices: readonly Notice[],
  afterMessageCount: number,
): Message[] {
  const content = formatNotices(notices);
  if (!content) return [...messages];
  if (afterMessageCount < 0 || afterMessageCount > messages.length) {
    throw new Error("Post-tool notice anchor is outside the model request");
  }

  const updated = [...messages];
  updated.splice(afterMessageCount, 0, {
    role: "user",
    content: [text(`Meridian context after the preceding edits:\n${content}`)],
  });
  return updated;
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
