/**
 * Model-only history projection of one turn and its blocks: labels, the
 * visibility classifier and display items. Copies are elided before any size
 * trimming.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import {
  type DocumentRevisionEvidence,
  referenceOccurrenceContent,
} from "@meridian/contracts/protocol";
import type { Block, JsonObject, JsonValue, Turn } from "@meridian/contracts/threads";
import { classifyHistoryItem, isConversationTurn } from "../../threads/index.js";
import type { BlockRepository } from "../../threads/ports/repositories.js";
import { componentHistoryText } from "../loop/component-model-text.js";
import { elideReferenceRead } from "../loop/reference-context.js";
import type { ToolRegistry } from "../tools/types.js";
import { orderLikeSchema } from "./history-call-line.js";
import type { HistoryTurn } from "./history-result.js";

export type HistoryInclude =
  | "routine_calls"
  | "tool_results"
  | "thinking"
  | "system_messages"
  | "system_prompt"
  | "timestamps";

const stringify = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);
const toolKey = (turnId: string, toolCallId: string, type: string) =>
  JSON.stringify([turnId, toolCallId, type]);
export const historyTime = (turn: Turn) => turn.createdAt.slice(0, 16).replace("T", " ");

/** Fetch pairs even when the other side lies outside the selected page. */
export async function loadHistoryToolPairs(
  blocks: BlockRepository,
  entries: readonly { block: Block | null }[],
): Promise<ReadonlyMap<string, Block>> {
  const keys = new Map<string, { turnId: Block["turnId"]; toolCallId: string }>();
  for (const { block } of entries) {
    if (block?.blockType !== "tool_use" && block?.blockType !== "tool_result") continue;
    const toolCallId = String((block.content as JsonObject).toolCallId);
    keys.set(JSON.stringify([block.turnId, toolCallId]), { turnId: block.turnId, toolCallId });
  }
  const pairs = await blocks.listToolBlocks([...keys.values()]);
  return toolPairMap(pairs);
}

export function toolPairMap(blocks: readonly Block[]): ReadonlyMap<string, Block> {
  return new Map(
    blocks
      .filter((block) => block.blockType === "tool_use" || block.blockType === "tool_result")
      .map((block) => [
        toolKey(block.turnId, String((block.content as JsonObject).toolCallId), block.blockType),
        block,
      ]),
  );
}

/** The turn's heading and whether the whole turn is a system message. */
export function describeTurn(turn: Turn): Pick<HistoryTurn, "role" | "label" | "failure"> & {
  system: boolean;
} {
  const kind = classifyHistoryItem(turn);
  const metadata = turn.metadata as JsonObject | null;
  const reason =
    turn.status === "error" && typeof metadata?.reason === "string" ? metadata.reason : undefined;
  const failure =
    turn.error || reason || turn.status === "error" || turn.status === "cancelled"
      ? {
          status: turn.status,
          ...(turn.error ? { error: turn.error } : {}),
          ...(reason ? { reason } : {}),
        }
      : undefined;
  const base = failure ? { failure } : {};
  // One rule decides numbering here and in the repository count: isConversationTurn.
  if (isConversationTurn(turn)) {
    if (turn.role === "assistant")
      return { ...base, system: false, role: "assistant", label: "assistant" };
    if (turn.origin === "writer")
      return {
        ...base,
        system: false,
        role: "user",
        label: `user${kind.kind === "writer_request" && kind.delivery === "steer" ? ", steer" : ""}`,
      };
    return {
      ...base,
      system: false,
      role: "user",
      label: `agent${kind.kind === "agent_request" && kind.source === "child_seed" ? ", spawn prompt" : ""}`,
    };
  }
  return {
    ...base,
    system: true,
    role: "system",
    label:
      kind.kind === "child_completion"
        ? `system: child ${metadata?.handle} finished (${metadata?.outcome})`
        : kind.kind === "work_update"
          ? "system: Work update"
          : `system: ${kind.kind}`,
  };
}

/** One block as a display item, before the view decides how much of it to show. */
export type DescribedBlock =
  /** A tool result shown on its call's line. */
  | { kind: "merged" }
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "system"; label: string; text: string }
  | {
      kind: "tool";
      tool: string;
      /** History withholds the arguments: `return_result` (D6), or the call is missing. */
      withheld: boolean;
      /** After the arrow: a finished call's result in brief, a failed call's status or code. */
      summary?: string;
      routine: boolean;
      /** True when the call has no result yet. */
      open: boolean;
      isError: boolean;
      args: JsonObject;
      /** The result as history may quote it: document copies elided, errors verbatim. */
      result?: string;
      /** Size of the result the model saw. */
      rawResult?: string;
      /** The call wrote a document; quoting its arguments is an edit record. */
      write: boolean;
      documents: DocumentRevisionEvidence[];
    };

export function describeBlock(input: {
  turn: Turn;
  block: Block;
  registry: ToolRegistry;
  toolPairs: ReadonlyMap<string, Block>;
}): DescribedBlock {
  const { turn, block, registry, toolPairs } = input;
  if (block.blockType === "tool_use" || block.blockType === "tool_result") {
    const content = block.content as JsonObject;
    const pair = toolPairs.get(
      toolKey(
        turn.id,
        String(content.toolCallId),
        block.blockType === "tool_use" ? "tool_result" : "tool_use",
      ),
    );
    if (block.blockType === "tool_result" && pair) return { kind: "merged" };
    const call = (block.blockType === "tool_use" ? content : undefined) as JsonObject | undefined;
    const result = (block.blockType === "tool_result" ? content : pair?.content) as
      | JsonObject
      | undefined;
    const name = String(content.toolName ?? result?.toolName ?? "unknown");
    const registration = registry.getRegistration(name);
    // Storage may reorder keys; history quotes them in the tool's schema order (D48).
    const args = orderLikeSchema(
      (call?.input ?? {}) as JsonObject,
      registration?.definition.inputSchema,
    ) as JsonObject;
    const policy = registration?.documentText;
    const documents = ((result?.metadata as JsonObject | undefined)?.documentRevisions ??
      []) as DocumentRevisionEvidence[];
    const isError = result?.isError === true;
    // Rows from before typed results carry only `output`.
    const typed = (result?.result ?? result?.output) as JsonValue | undefined;
    const kind = registration?.historyKind;
    const summary = !result
      ? undefined
      : isError
        ? failureCode(typed)
        : registration?.historySummary?.(args, typed ?? null);
    return {
      kind: "tool",
      tool: name,
      withheld: !call || registration?.capability === "return_result",
      ...(summary ? { summary } : {}),
      routine: typeof kind === "function" ? kind(args) === "routine" : kind === "routine",
      open: !result,
      isError,
      args,
      write: policy?.kind === "write",
      documents,
      ...(result
        ? {
            rawResult: stringify(result.output as JsonValue),
            result:
              (!call || !registration) && !isError
                ? `[tool result omitted: ${!call ? "call" : "tool"} unavailable]`
                : stringify(
                    !isError && policy
                      ? policy.elide(
                          { input: args, output: result.output as JsonValue },
                          documents,
                          "history",
                        ).output
                      : (result.output as JsonValue),
                  ),
          }
        : {}),
    };
  }
  if (block.blockType === "reasoning")
    return {
      kind: "thinking",
      text: block.textContent ?? String((block.content as JsonObject)?.text ?? ""),
    };
  const cardKind =
    block.blockType === "custom" && classifyHistoryItem(turn).kind === "assistant_response"
      ? String((block.content as JsonObject).kind)
      : null;
  const modelText =
    block.blockType === "custom"
      ? componentHistoryText(block.content as ComponentBlockContent)
      : null;
  const reference = referenceOccurrenceContent(block);
  let text: string;
  if (modelText) text = modelText;
  else if (reference) {
    const elidedRead = reference.read
      ? ((elideReferenceRead(reference, "history") as JsonObject).read as JsonObject)
      : null;
    text = `${reference.text}${elidedRead ? `\n${stringify({ result: elidedRead.result })}` : ""}`;
  } else if (block.blockType === "image")
    text = `[image: ${(block.content as JsonObject)?.name ?? (block.content as JsonObject)?.uri ?? "attachment"}]`;
  else text = block.textContent ?? stringify(block.content);
  const metadata = turn.metadata as JsonObject | null;
  if (classifyHistoryItem(turn).kind === "compaction" && typeof metadata?.instructions === "string")
    text = `instructions: ${metadata.instructions}${text ? `\n${text}` : ""}`;
  return cardKind
    ? { kind: "system", label: `system: ${cardKind}`, text }
    : { kind: "message", text };
}

const jsonObject = (value: JsonValue | undefined) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

/** A failed call's status (agent-edit, spawn) or error code (a refusal), from its typed result. */
function failureCode(value: JsonValue | undefined): string | undefined {
  const typed = jsonObject(value);
  if (!typed) return undefined;
  if (typeof typed.status === "string" && typed.status !== "error" && typed.status !== "success")
    return typed.status;
  const code = typed.code ?? jsonObject(typed.error)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Quoting a write's arguments is a record of an edit, never the document's current text. */
export function editRecord(turn: Turn, args: JsonObject) {
  return `edit record from ${historyTime(turn)}; the document may have changed since\n${JSON.stringify(args)}`;
}

/** Evidence for a quoted edit; revisions are dropped because the text may be stale. */
export function editEvidence(described: Extract<DescribedBlock, { kind: "tool" }>) {
  const evidence = described.documents.length
    ? described.documents
    : [
        {
          documentId: String(described.args.path ?? "unknown document"),
          uri: typeof described.args.path === "string" ? described.args.path : null,
          revision: null,
        },
      ];
  return evidence.map((ref) => ({ ...ref, revision: null }));
}

/** Display numbers for a whole turn: every block except a tool result shown on its call. */
export function displayIndexes(blocks: readonly Block[]): ReadonlyMap<number, number> {
  const calls = new Set(
    blocks
      .filter((block) => block.blockType === "tool_use")
      .map((block) => String((block.content as JsonObject).toolCallId)),
  );
  const indexes = new Map<number, number>();
  let index = 0;
  for (const block of [...blocks].sort((left, right) => left.sequence - right.sequence)) {
    if (
      block.blockType === "tool_result" &&
      calls.has(String((block.content as JsonObject).toolCallId))
    )
      continue;
    indexes.set(block.sequence, ++index);
  }
  return indexes;
}
