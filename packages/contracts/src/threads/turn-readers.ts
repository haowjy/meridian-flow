/**
 * Defensive client reads of durable turn metadata that the transcript shows: compaction dividers,
 * handoff seeds and the `from` sources a spawned child names. The server's codecs own each shape;
 * a reader picks only the fields the writer sees and never throws on a malformed record.
 * Subagent update metadata has its own parser in `../spawn`.
 */

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
  /** The writer command this divider ran (`controlMessageId`); null for an automatic one. */
  controlId: string | null;
  /** The writer's `/compact <instructions>`, verbatim; null for a plain `/compact`. */
  instructions: string | null;
  summary: string | null;
  /** The model that wrote the summary: the summary block's, else the turn's. */
  model: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
};

/** Writer instructions are shown verbatim; only whitespace-only text counts as none. */
export function instructionsText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function isCompactionTurn(turn: Turn): boolean {
  return turn.role === "compaction";
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

/** Every writer command a divider already answers: a queued item for one is no longer queued. */
export function answeredControlIds(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    const id = turn.role === "compaction" ? readCompactionFacts(turn).controlId : null;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * R4: a context-window overflow completes the running assistant turn empty
 * before the compaction that recovers it. It says nothing to the writer.
 */
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
  /**
   * The source's title when S was created, for display only: it names a
   * source the writer can no longer read (in the trash). Null when the
   * source was untitled.
   */
  sourceTitle: string | null;
  cutoffTurnId: string | null;
};

/** The seed's facts, or null when the turn is not a handoff seed. */
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

/** The brief text from the completed seed's `handoff-brief` block. */
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

/** A source chat the child was pointed at. Its ref is a model handle, never writer copy. */
export type ThreadReference = { threadId: string; title: string | null };

/** The `thread-reference` blocks a spawned child's first message carries, in block order. */
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
