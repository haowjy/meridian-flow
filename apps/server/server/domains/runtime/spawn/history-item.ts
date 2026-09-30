/** Model-only history item projection. Copies are elided before any size trimming. */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import {
  type DocumentRevisionEvidence,
  referenceOccurrenceContent,
} from "@meridian/contracts/protocol";
import type { Block, JsonObject, JsonValue, Turn } from "@meridian/contracts/threads";
import { classifyHistoryItem } from "../../threads/index.js";
import type { BlockRepository } from "../../threads/ports/repositories.js";
import { componentHistoryText } from "../loop/component-model-text.js";
import { elideReferenceRead } from "../loop/reference-context.js";
import type { ToolRegistry } from "../tools/types.js";

export type HistoryInclude =
  | "thinking"
  | "tool_args"
  | "tool_results"
  | "system_messages"
  | "system_prompt";
export interface HistoryItem {
  text: string;
  documents: DocumentRevisionEvidence[];
  position: number;
  sequence: number;
}
const stringify = (value: JsonValue | undefined) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);
const toolKey = (turnId: string, toolCallId: string, type: string) =>
  JSON.stringify([turnId, toolCallId, type]);

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
  return new Map(
    pairs.map((block) => [
      toolKey(block.turnId, String((block.content as JsonObject).toolCallId), block.blockType),
      block,
    ]),
  );
}

export function renderHistoryItem(input: {
  turn: Turn;
  block: Block | null;
  ownerRef?: string;
  include: ReadonlySet<HistoryInclude>;
  expand?: boolean;
  registry: ToolRegistry;
  toolPairs: ReadonlyMap<string, Block>;
}): HistoryItem | null {
  const { turn, block, ownerRef, include, expand, registry, toolPairs } = input;
  const kind = classifyHistoryItem(turn);
  const sequence = block?.sequence ?? -1;
  const handle = `${turn.position}${sequence < 0 ? "" : `.${sequence}`}`;
  const documents: DocumentRevisionEvidence[] = [];
  const metadata = turn.metadata as JsonObject | null;
  const failureReason =
    turn.status === "error" && typeof metadata?.reason === "string" ? metadata.reason : undefined;
  const cardKind =
    block?.blockType === "custom" && kind.kind === "assistant_response"
      ? String((block.content as JsonObject).kind)
      : null;
  const systemLabel = cardKind
    ? `system: ${cardKind}`
    : kind.kind === "child_completion"
      ? `system: child ${metadata?.handle} finished (${metadata?.outcome})`
      : kind.kind === "work_update"
        ? "system: Work update"
        : `system: ${kind.kind}`;
  let label: string;
  let body = "";
  const system =
    cardKind !== null ||
    !["writer_request", "agent_request", "assistant_response"].includes(kind.kind);
  if (system && !expand && !include.has("system_messages")) return null;
  if (!block) {
    label = system
      ? systemLabel
      : turn.role === "assistant"
        ? "assistant"
        : kind.kind === "writer_request"
          ? "user"
          : "agent";
    body = `${turn.status}${turn.error ? `: ${turn.error}` : ""}${failureReason ? `\nfailure reason: ${failureReason}` : ""}`;
  } else if (block.blockType === "tool_use" || block.blockType === "tool_result") {
    if (block.blockType === "tool_result" && !expand && !include.has("tool_results")) return null;
    const content = block.content as JsonObject;
    const pair = toolPairs.get(
      toolKey(
        turn.id,
        String(content.toolCallId),
        block.blockType === "tool_use" ? "tool_result" : "tool_use",
      ),
    );
    const call = (block.blockType === "tool_use" ? content : pair?.content) as
      | JsonObject
      | undefined;
    const result = (block.blockType === "tool_result" ? content : pair?.content) as
      | JsonObject
      | undefined;
    const name = String(call?.toolName ?? content.toolName);
    const args = (call?.input ?? {}) as JsonObject;
    const registration = registry.getRegistration(name);
    const policy = registration?.documentText;
    const refs = ((result?.metadata as JsonObject | undefined)?.documentRevisions ??
      []) as DocumentRevisionEvidence[];
    if (block.blockType === "tool_result") {
      label = `tool_result ${name}`;
      body =
        (!call || !registration) && !result?.isError
          ? `[tool result omitted: ${!call ? "call" : "tool"} unavailable]`
          : stringify(
              !result?.isError && policy && policy.kind(args) !== "none"
                ? policy.elide({ input: args, output: result?.output }, refs, "history").output
                : result?.output,
            );
    } else {
      label = `tool_call ${name}`;
      if (expand || include.has("tool_args")) {
        body = JSON.stringify(args);
        if (policy?.kind(args) === "write") {
          body = `edit record from ${turn.createdAt.slice(0, 16).replace("T", " ")}; the document may have changed since\n${body}`;
          const evidence = refs.length
            ? refs
            : [
                {
                  documentId: String(args.document_id ?? args.path ?? "unknown document"),
                  uri: typeof args.path === "string" ? args.path : null,
                  revision: null,
                },
              ];
          documents.push(...evidence.map((ref) => ({ ...ref, revision: null })));
        }
      } else
        label += ` ${registration?.historyPreview?.(args, result?.output) ?? JSON.stringify(args).slice(0, 80)}`;
    }
  } else if (block.blockType === "reasoning") {
    if (!expand && !include.has("thinking")) return null;
    label = "thinking";
    body = block.textContent ?? String((block.content as JsonObject)?.text ?? "");
  } else {
    label = cardKind
      ? systemLabel
      : kind.kind === "writer_request"
        ? `user${kind.delivery === "steer" ? ", steer" : ""}`
        : kind.kind === "agent_request"
          ? `agent${kind.source === "child_seed" ? ", spawn prompt" : ""}`
          : kind.kind === "assistant_response"
            ? "assistant"
            : systemLabel;
    const modelText =
      block.blockType === "custom"
        ? componentHistoryText(block.content as ComponentBlockContent)
        : null;
    const reference = referenceOccurrenceContent(block);
    if (modelText) body = modelText;
    else if (reference) {
      const elidedRead = reference.read
        ? ((elideReferenceRead(reference, "history") as JsonObject).read as JsonObject)
        : null;
      body = `${reference.text}${elidedRead ? `\n${stringify({ result: elidedRead.result })}` : ""}`;
    } else if (block.blockType === "image")
      body = `[image: ${(block.content as JsonObject)?.name ?? (block.content as JsonObject)?.uri ?? "attachment"}]`;
    else body = block.textContent ?? stringify(block.content);
  }
  if (kind.kind === "compaction" && typeof metadata?.instructions === "string") {
    body = `instructions: ${metadata.instructions}${body ? `\n${body}` : ""}`;
  }
  return {
    position: turn.position,
    sequence,
    documents,
    text: `[${handle}] ${label}${ownerRef ? ` (from ${ownerRef})` : ""}  ${turn.createdAt.slice(0, 16).replace("T", " ")}${body ? `\n${body}` : ""}${turn.error && block ? `\n${turn.status}: ${turn.error}` : ""}${failureReason && block ? `\nfailure reason: ${failureReason}` : ""}`,
  };
}
