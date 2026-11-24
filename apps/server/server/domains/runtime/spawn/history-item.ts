import type { ComponentBlockContent } from "@meridian/contracts/components";
import {
  type DocumentRevisionEvidence,
  referenceOccurrenceContent,
} from "@meridian/contracts/protocol";
import type {
  Block,
  JsonObject,
  JsonValue,
  ToolContentPart,
  Turn,
} from "@meridian/contracts/threads";
import {
  isConversationTurn,
  isNotesStepHeldResult,
  toolContentText,
} from "@meridian/contracts/threads";
import { classifyHistoryItem } from "../../threads/index.js";
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

export function describeTurn(turn: Turn): Pick<HistoryTurn, "role" | "label" | "cancelled"> & {
  system: boolean;
} {
  const kind = classifyHistoryItem(turn);
  const metadata = turn.metadata as JsonObject | null;
  const base = turn.status === "cancelled" ? { cancelled: true as const } : {};
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

export type DescribedBlock =
  | { kind: "merged" }
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "system"; label: string; text: string }
  | {
      kind: "tool";
      tool: string;
      withheld: boolean;
      summary?: string;
      routine: boolean;
      open: boolean;
      isError: boolean;
      args: JsonObject;
      result?: string;
      rawResult?: string;
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
    const args = orderLikeSchema(
      (call?.input ?? {}) as JsonObject,
      registration?.definition.inputSchema,
    ) as JsonObject;
    const policy = registration?.documentText;
    const documents = ((result?.metadata as JsonObject | undefined)?.documentRevisions ??
      []) as DocumentRevisionEvidence[];
    const isError = result?.isError === true;
    const modelContent = (result?.content ?? []) as unknown as ToolContentPart[];
    const typed = result?.result as JsonValue | undefined;
    const held = isNotesStepHeldResult(typed);
    const kind = registration?.historyKind;
    const summary = !result
      ? undefined
      : held
        ? "not run before compaction"
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
      write: !held && policy?.kind === "write",
      documents,
      ...(result
        ? {
            rawResult: toolContentText(modelContent),
            result:
              (!call || !registration) && !isError
                ? `[tool result omitted: ${!call ? "call" : "tool"} unavailable]`
                : !held && !isError && policy
                  ? policy.elide({ input: args, result: typed }, documents, "history").text
                  : toolContentText(modelContent),
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
    const elidedRead =
      reference.kind === "document" && reference.read
        ? ((elideReferenceRead(reference, "history") as JsonObject).read as JsonObject)
        : null;
    text = `${reference.text}${elidedRead ? `\n${stringify({ result: elidedRead.result })}` : ""}`;
  } else if (block.blockType === "media")
    text = `[media: ${(block.content as JsonObject)?.name ?? (block.content as JsonObject)?.uri ?? "attachment"}]`;
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

function failureCode(value: JsonValue | undefined): string | undefined {
  const typed = jsonObject(value);
  if (!typed) return undefined;
  if (typeof typed.status === "string" && typed.status !== "error" && typed.status !== "success")
    return typed.status;
  const code = typed.code ?? jsonObject(typed.error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function editRecord(turn: Turn, args: JsonObject) {
  return `edit record from ${historyTime(turn)}; the document may have changed since\n${JSON.stringify(args)}`;
}

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
