/** Request-scoped child-question evidence used to bind parent thread messages. */

import type { Block, JsonValue, Turn } from "@meridian/contracts/threads";
import type { AskRepository } from "../../threads/index.js";

type QuestionRef = { askId: string; childThreadId: string; handle: string };

export async function openChildQuestionsInRequest(input: {
  turns: readonly Turn[];
  blocks: readonly Block[];
  creditedBlockIds: ReadonlySet<string>;
  asks: Pick<AskRepository, "listByIds">;
}): Promise<ReadonlyMap<string, string>> {
  const visibleTurns = new Set(
    input.blocks
      .filter((block) => input.creditedBlockIds.has(block.id))
      .map((block) => block.turnId),
  );
  const refs: QuestionRef[] = [];
  for (const turn of input.turns) {
    if (!visibleTurns.has(turn.id)) continue;
    const metadata = record(turn.metadata);
    const question = record(metadata?.childQuestion);
    const askId = string(question?.id);
    const childThreadId = string(question?.childThreadId);
    const handle = string(question?.handle);
    if (askId && childThreadId && handle) refs.push({ askId, childThreadId, handle });
  }
  for (const block of input.blocks) {
    if (!input.creditedBlockIds.has(block.id) || block.blockType !== "tool_result") continue;
    const content = record(block.content);
    const result = record(content?.result);
    const ask = record(result?.ask);
    const askId = string(ask?.id);
    const childThreadId = string(result?.childThreadId);
    const handle = string(result?.handle);
    if (result?.status === "asked" && askId && childThreadId && handle)
      refs.push({ askId, childThreadId, handle });
  }
  const open = new Set(
    (await input.asks.listByIds([...new Set(refs.map((ref) => ref.askId))]))
      .filter((ask) => ask.status === "open")
      .map((ask) => `${ask.threadId}\0${ask.id}`),
  );
  const bound = new Map<string, string>();
  for (const ref of refs)
    if (open.has(`${ref.childThreadId}\0${ref.askId}`)) bound.set(ref.handle, ref.askId);
  return bound;
}

export async function openChildQuestionTurnIds(input: {
  turns: readonly Turn[];
  blocks: readonly Block[];
  asks: Pick<AskRepository, "listByIds">;
}): Promise<ReadonlySet<string>> {
  const references: Array<{ askId: string; turnId: string }> = [];
  for (const turn of input.turns) {
    const question = record(record(turn.metadata)?.childQuestion);
    const askId = string(question?.id);
    if (askId) references.push({ askId, turnId: turn.id });
  }
  for (const block of input.blocks) {
    if (block.blockType !== "tool_result") continue;
    const result = record(record(block.content)?.result);
    const askId = string(record(result?.ask)?.id);
    if (result?.status === "asked" && askId) references.push({ askId, turnId: block.turnId });
  }
  const open = new Set(
    (await input.asks.listByIds([...new Set(references.map(({ askId }) => askId))]))
      .filter((ask) => ask.status === "open")
      .map((ask) => ask.id),
  );
  return new Set(references.filter(({ askId }) => open.has(askId)).map(({ turnId }) => turnId));
}

function record(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function string(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}
