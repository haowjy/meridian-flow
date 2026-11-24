import type { AiWriteMode } from "../works/index.js";
import type { Block, Turn } from "./index.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export type CompactionTrigger = "auto" | "manual";

export type CompactionFacts = {
  trigger: CompactionTrigger;
  controlId: string | null;
  instructions: string | null;
  summary: string | null;
  model: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
};

export function instructionsText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readCompactionFacts(turn: Turn): CompactionFacts {
  const metadata = record(turn.metadata);
  const controlMessageId = text(metadata?.controlMessageId);
  const trigger: CompactionTrigger =
    metadata?.trigger === "manual" || (metadata?.trigger === undefined && controlMessageId)
      ? "manual"
      : "auto";
  const summaryBlock = (turn.blocks ?? []).find(
    (block) => block.blockType === "custom" && record(block.content)?.kind === "compaction",
  );
  const props = record(record(summaryBlock?.content)?.props);
  return {
    trigger,
    controlId: controlMessageId,
    instructions: instructionsText(metadata?.instructions),
    summary: text(props?.summary),
    model: text(props?.model) ?? text(turn.model),
    tokensBefore: count(props?.tokensBefore),
    tokensAfter: count(props?.tokensAfter),
  };
}

export function answeredControlIds(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    const id =
      turn.role === "compaction"
        ? readCompactionFacts(turn).controlId
        : (readWriteModeSwitch(turn)?.controlId ?? null);
    if (id) ids.add(id);
  }
  return ids;
}

export function isOverflowShell(turn: Turn, next: Turn | undefined): boolean {
  return (
    next?.role === "compaction" &&
    turn.role === "assistant" &&
    turn.status === "complete" &&
    (turn.blocks ?? []).length === 0
  );
}

export type HandoffSeedFacts = {
  sourceThreadId: string;
  sourceRef: string | null;
  sourceTitle: string | null;
  cutoffTurnId: string | null;
};

export function readHandoffSeed(turn: Turn): HandoffSeedFacts | null {
  if (turn.role !== "system") return null;
  const metadata = record(turn.metadata);
  if (metadata?.kind !== "derivation_seed" || metadata.derivation !== "handoff") return null;
  const sourceThreadId = text(metadata.sourceThreadId);
  if (!sourceThreadId) return null;
  return {
    sourceThreadId,
    sourceRef: text(metadata.sourceRef),
    sourceTitle: text(metadata.sourceTitle),
    cutoffTurnId: text(metadata.cutoffTurnId),
  };
}

export function isHandoffSeed(turn: Turn): boolean {
  return readHandoffSeed(turn) !== null;
}

export function readHandoffBrief(turn: Turn): string | null {
  for (const block of turn.blocks ?? []) {
    if (block.blockType !== "custom") continue;
    const content = record(block.content);
    if (content?.kind !== "handoff-brief") continue;
    const props = record(content.props);
    return props?.state === "available" ? text(props.brief) : null;
  }
  return null;
}

export type ThreadReference = { threadId: string; title: string | null };

export function readThreadReferences(blocks: readonly Block[]): ThreadReference[] {
  return [...blocks]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((block) => {
      if (block.blockType !== "custom") return [];
      const content = record(block.content);
      if (content?.kind !== "thread-reference") return [];
      const props = record(content.props);
      const threadId = typeof props?.threadId === "string" ? props.threadId : null;
      if (!threadId) return [];
      return [
        {
          threadId,
          title: typeof props?.title === "string" ? props.title : null,
        },
      ];
    });
}

export type WriteModeSwitchFacts = {
  mode: AiWriteMode;
  controlId: string | null;
};

export function readWriteModeSwitch(turn: Turn): WriteModeSwitchFacts | null {
  const metadata = record(turn.metadata);
  if (turn.role !== "system" || !metadata) return null;
  if (metadata.kind !== "write_mode_switch") return null;
  if (metadata.mode !== "draft" && metadata.mode !== "direct") return null;
  return { mode: metadata.mode, controlId: text(metadata.controlMessageId) };
}

export function retryTargetOf(turn: Turn): string | null {
  const target = record(turn.metadata)?.retryOf;
  return typeof target === "string" ? target : null;
}

export const SYSTEM_TURN_KINDS = ["system_update", "derivation_seed", "subagent_update"] as const;

export function isConversationTurn(turn: Pick<Turn, "role" | "origin" | "metadata">): boolean {
  const kind = record(turn.metadata)?.kind;
  if ((SYSTEM_TURN_KINDS as readonly unknown[]).includes(kind)) return false;
  if (turn.role === "user")
    return turn.origin === "writer" || (turn.origin === "system" && kind === "inbox_message");
  return turn.role === "assistant" && turn.origin === "assistant";
}

export function isClosingRow(turn: Pick<Turn, "role" | "origin" | "metadata">): boolean {
  return turn.role === "compaction" || isConversationTurn(turn);
}

export function inConversation(turn: Pick<Turn, "forgottenBy">): boolean {
  return turn.forgottenBy == null;
}
