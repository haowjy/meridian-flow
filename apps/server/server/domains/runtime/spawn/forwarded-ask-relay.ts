/**
 * The relay of a resolved forwarded ask: the parent's continuation sends the
 * answer to the child as a foreground `thread_message` bound to the child's
 * exact ask, then rewrites the forwarded ask's tool result with the child's
 * report. The relay record commits with the child's answer, so a replay after a
 * crash repeats this same call and waits on the same continuation.
 */
import type { TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult, TreeBudget } from "@meridian/contracts/spawn";
import type { JsonValue, QuestionAskPayload, Thread } from "@meridian/contracts/threads";
import { askToolResult } from "../../threads/domain/ask.js";
import type { LiveEventWriter, StoredAsk, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { type PersistenceDeps, persistAndAppendEvents } from "../loop/persistence.js";
import type { InvalidArgumentsResult } from "../tools/invalid-arguments.js";
import type { ChildRunOptions, ChildRunRequest } from "./child-run-coordinator.js";

export type ForwardedRelayInput = {
  parentThread: Thread;
  /** The parent continuation's reserved turn. */
  parentTurnId: TurnId;
  /** The parent's resolved forwarded ask. */
  ask: StoredAsk;
  budget: TreeBudget;
  signal?: AbortSignal;
};

export type ForwardedRelayDeps = {
  repos: PersistenceDeps["repos"] & Pick<ThreadRepositories, "asks">;
  eventWriter: LiveEventWriter;
  runChild(
    request: ChildRunRequest,
    options: ChildRunOptions,
  ): Promise<SpawnResult | InvalidArgumentsResult>;
};

export async function relayForwardedAnswer(
  deps: ForwardedRelayDeps,
  input: ForwardedRelayInput,
): Promise<void> {
  const { ask } = input;
  const forwarded = (ask.payload as QuestionAskPayload).forwardedFrom;
  if (ask.kind !== "question" || !forwarded) throw new Error("Ask is not a forwarded question");
  if (ask.relay && ask.relay.result !== null) return;
  const base = askToolResult(ask);
  const text =
    typeof base.answer === "string"
      ? base.answer
      : base.answer === null
        ? "Skipped"
        : String(base.answer);
  // An open child question is answered and driven in foreground; one that already
  // resolved gets the answer as an ordinary background message.
  const child = await deps.runChild(
    {
      kind: "message",
      parentThread: input.parentThread,
      parentTurnId: input.parentTurnId,
      ref: forwarded.handle,
      prompt: text,
      toolCallId: `forwarded-ask:${ask.id}`,
      boundAskId: forwarded.askId,
      relayFor: ask.id,
      budget: input.budget,
      signal: input.signal,
    },
    { mode: "foreground" },
  );
  if ("issues" in child) throw new Error("Forwarded child message was refused");
  const relayedTo = `@${forwarded.handle}`;
  const result: JsonValue =
    child.status === "background"
      ? { ...base, relayed_to: relayedTo, late: true }
      : {
          ...base,
          relayed_to: relayedTo,
          report: (child.status === "completed" ? child.report : child) as JsonValue,
        };
  const prior = (await deps.repos.blocks.listByTurn(ask.askingTurnId)).find(
    (block) =>
      block.blockType === "tool_result" &&
      typeof block.content === "object" &&
      block.content !== null &&
      !Array.isArray(block.content) &&
      block.content.toolCallId === ask.toolCallId,
  );
  if (!prior) throw new Error("Forwarded ask result block is unavailable");
  const block = contentForBlockInput({
    id: prior.id,
    turnId: prior.turnId as TurnId,
    blockType: "tool_result",
    sequence: prior.sequence,
    content: { toolCallId: ask.toolCallId, output: result, result, isError: false },
    status: "complete",
  });
  await persistAndAppendEvents(deps, ask.threadId, async () => {
    if (child.status === "background")
      await deps.repos.asks.recordRelayOnce(ask.id, {
        childAskId: forwarded.askId,
        mode: "late",
        messageId: `thread-message:forwarded-ask:${ask.id}`,
        result,
      });
    else await deps.repos.asks.completeRelay(ask.id, result);
    return { result: undefined, events: [{ type: "block.updated" as const, block }] };
  });
}
