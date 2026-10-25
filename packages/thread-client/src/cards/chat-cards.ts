/**
 * chatCards — the one place a chat failure becomes something the writer sees. Its inputs are facts,
 * not the view: the turns (normalized, with the latest row), the run-state record, the hand-back
 * operation's unresolved commands, failed Send nows, Retry outcomes, unadmitted sends, failed queued
 * commands and the handoff brief's failed Stop. Each card is anchored to a turn, a queued command, a
 * writer message or the composer, and keyed by its occurrence id. The app draws a card where it is
 * anchored and decides nothing; `./mf thread view` prints the same cards. A failure is temporary: a
 * card exists only while the writer can act on it, and the words a writer typed are never moot.
 */
import {
  classifyCommandFailure,
  classifyReplyFailure,
  type Failure,
  type FailureOccurrence,
  usageFailure,
} from "@meridian/contracts/failures";
import type { Turn } from "@meridian/contracts/protocol";
import { isProviderDeclined } from "@meridian/contracts/protocol";
import { type ControlBody, isHandoffSeed, readCompactionFacts } from "@meridian/contracts/threads";
import { type CommandFailure, occurrenceKey } from "../commands";
import type { UnresolvedHandBack } from "../hand-back/operation";
import type { FailedSendNow } from "../hand-back/send-now";
import { usageBlockedMessages } from "../run-state/fold-messages";
import type { RunStateView } from "../run-state/run-state-view";
import { latestRow } from "../view/latest-row";
import type { NormalizedTurns } from "../view/normalize-turns";
import { classifyTurn } from "../view/transcript-model";
import { handBackCards } from "./hand-back-cards";
import type { BriefStopFailure, ChatCard, ChatCardAnchor, ChatCards, RetryOutcome } from "./types";

/** Failed rows always carry their owner's occurrence fact. */
export type CardControl = { id: string; control: ControlBody } & (
  | { status: "sending" | "queued"; failure?: never }
  | { status: "failed" | "withdraw_failed"; failure: CommandFailure }
);

export type ChatCardsInput = {
  threadId: string;
  unavailable?: FailureOccurrence | null;
  /** The same turn facts `viewTranscript` takes, so both read one normalized sequence. */
  turns: NormalizedTurns;
  runState: RunStateView;
  handBack: readonly (UnresolvedHandBack | FailedSendNow)[];
  retries: readonly RetryOutcome[];
  briefStops: readonly BriefStopFailure[];
  controls: readonly CardControl[];
  /** Writer messages being moved back to the message box: their failure is not a card. */
  movingTurnIds?: ReadonlySet<string>;
  /** Unadmitted sends, with attempt identity retained by their submission owner. */
  sends: ReadonlyMap<string, CommandFailure>;
};

/** A failed turn's `Failure`, read the way the server classified it (`failureOfTurn`). */
function replyFailure(turn: Turn): Failure {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? turn.metadata
      : {};
  const provider = metadata.providerError;
  const status =
    provider && typeof provider === "object" && !Array.isArray(provider) ? provider.status : null;
  return classifyReplyFailure({
    reason: typeof metadata.reason === "string" ? metadata.reason : null,
    status: typeof status === "number" ? status : null,
  });
}

function card(
  fields: Pick<ChatCard, "key" | "failure" | "copy" | "action" | "anchor"> &
    Partial<Pick<ChatCard, "count" | "text" | "requestId">>,
): ChatCard {
  return { count: 1, text: null, requestId: null, ...fields };
}

export function chatCards(input: ChatCardsInput): ChatCards {
  const normalized = input.turns;
  const { turns } = normalized;
  const latest = latestRow(turns);
  const cards: ChatCard[] = [];
  const anchored = new Set<string>();
  const onTurn = (id: string): ChatCardAnchor => {
    anchored.add(id);
    return { turn: id };
  };

  // Usage first: the composer's stack reads usage, then commands in command order.
  const blocked = usageBlockedMessages(input.runState);
  const oldest = blocked.reduce<number | null>(
    (seq, item) => (seq === null || item.seq < seq ? item.seq : seq),
    null,
  );
  if (oldest !== null)
    cards.push(
      card({
        key: `usage:${input.threadId}:${oldest}`,
        failure: usageFailure(input.runState.record?.blocked?.reason ?? "credits_exhausted"),
        copy: "usage-blocked",
        action: "add_usage",
        anchor: "composer",
      }),
    );
  if (input.unavailable)
    cards.push(
      card({
        key: input.unavailable.occurrenceId,
        failure: input.unavailable.failure,
        copy: "updates-disconnected",
        action: "reload",
        anchor: "composer",
      }),
    );
  cards.push(...handBackCards(input.handBack, input.runState));

  // A failure shows only while the writer can act on it: no closing row follows it.
  const eligible = new Set(turns.slice(latest?.index ?? 0));
  const current = (turn: Turn) => eligible.has(turn);
  const placedById = new Map(normalized.placed.map((turn) => [turn.id, turn]));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const newestSeed = [...turns].reverse().find((turn) => isHandoffSeed(turn)) ?? null;
  const compactQueued = input.controls.some((control) => control.control.kind === "compact");
  for (const turn of turns) {
    if (turn.status !== "error" || !current(turn)) continue;
    if (isHandoffSeed(turn)) {
      // The newest brief only; its Retry stays in the brief's own header.
      if (turn === newestSeed) {
        cards.push(
          card({
            key: turn.id,
            failure: replyFailure(turn),
            copy: "brief-failed",
            action: "retry_brief",
            anchor: onTurn(turn.id),
            text: turn.error,
          }),
        );
      }
    } else if (turn.role === "compaction") {
      // An autocompaction's failure stays quiet (R3): the failed reply under the newest message
      // carries it. A manual one is retried by sending `/compact` again, so it is moot once one is queued.
      if (readCompactionFacts(turn).trigger !== "manual") continue;
      if (compactQueued) continue;
      cards.push(
        card({
          key: turn.id,
          failure: replyFailure(turn),
          copy: "compaction-failed",
          action: "try_again",
          anchor: onTurn(turn.id),
          text: turn.error,
        }),
      );
    } else if (turn.role === "assistant" && classifyTurn(turn) === "bubble") {
      cards.push(
        card({
          key: turn.id,
          failure: replyFailure(turn),
          copy: isProviderDeclined(turn.metadata) ? "reply-declined" : "reply-failed",
          action: "retry",
          anchor: onTurn(turn.id),
        }),
      );
    }
  }

  // A Retry that did not start. A refusal stays on its reply even once another reply landed below it
  // (the writer's action still failed); a lost request is a card only while its reply is still the one to retry.
  for (const outcome of input.retries) {
    const target = placedById.get(outcome.turnId);
    if (!target) continue;
    const key = occurrenceKey(outcome);
    if (outcome.kind === "refused") {
      cards.push(
        card({
          key,
          failure: classifyCommandFailure({
            kind: "refused",
            status: outcome.cause === "another-reply" ? 409 : null,
          }),
          copy: outcome.cause === "another-reply" ? "retry-refused-another-reply" : "retry-refused",
          action: null,
          anchor: onTurn(target.id),
          requestId: outcome.requestId,
        }),
      );
    } else if (
      target.status === "error" &&
      current(target) &&
      (!isHandoffSeed(target) || target === newestSeed)
    ) {
      cards.push(
        card({
          key,
          failure: classifyCommandFailure({ kind: "lost" }),
          copy: isHandoffSeed(target) ? "brief-retry-lost" : "retry-lost",
          action: "try_again",
          anchor: onTurn(target.id),
          requestId: outcome.requestId,
        }),
      );
    }
  }

  for (const stop of input.briefStops) {
    const seed = turnsById.get(stop.turnId);
    if (!seed || (seed.status !== "pending" && seed.status !== "streaming")) continue;
    cards.push(
      card({
        key: occurrenceKey(stop),
        failure: classifyCommandFailure({ kind: "lost" }),
        copy: "brief-stop-failed",
        action: "try_again",
        anchor: onTurn(stop.turnId),
      }),
    );
  }

  // The writer's own words are never moot: their owner supplies each unadmitted failure.
  for (const [turnId, failure] of input.sends) {
    if (input.movingTurnIds?.has(turnId)) continue;
    cards.push(
      card({
        key: occurrenceKey(failure),
        failure: classifyCommandFailure(failure),
        copy: "send-failed",
        action: "edit_or_send",
        anchor: { message: turnId },
      }),
    );
  }

  for (const control of input.controls) {
    if (control.status === "failed") {
      const failure = control.failure;
      cards.push(
        card({
          key: occurrenceKey(failure),
          failure: classifyCommandFailure({ kind: failure.kind }),
          copy:
            control.control.kind === "compact"
              ? "compact-enqueue-failed"
              : control.control.mode === "draft"
                ? "switch-draft-failed"
                : "switch-direct-failed",
          action: "retry",
          anchor: { queuedControl: control.id },
        }),
      );
    } else if (control.status === "withdraw_failed") {
      const failure = control.failure;
      cards.push(
        card({
          key: occurrenceKey(failure),
          failure: classifyCommandFailure({ kind: failure.kind }),
          copy:
            control.control.kind === "compact"
              ? "compact-withdraw-failed"
              : "switch-withdraw-failed",
          action: "try_again",
          anchor: { queuedControl: control.id },
        }),
      );
    }
  }

  return { cards, anchoredTurnIds: anchored };
}
