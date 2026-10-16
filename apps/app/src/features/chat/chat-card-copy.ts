/**
 * The words of every chat card. `chatCards` (`@meridian/thread-client`) decides which cards exist; the
 * card's copy key, count and `text` pick the sentence here, for the card that draws it and for the
 * announcer that speaks it, so what a writer hears is what they see.
 */
import { plural, t } from "@lingui/core/macro";
import type { ChatCard } from "@meridian/thread-client";
import { controlStatusCopy, controlWithdrawFailedCopy } from "./thread-controls/control-copy";

export function chatCardText(card: ChatCard): string {
  switch (card.copy) {
    case "reply-failed":
      return t`This response failed.`;
    case "reply-declined":
      return t`The AI provider turned this request down.`;
    // The server owns the words of a compaction's and a brief's own failure.
    case "compaction-failed":
      return card.text ?? t`This conversation couldn't be compacted.`;
    case "brief-failed":
      return card.text ?? t`The handoff brief failed.`;
    case "retry-refused":
      return t`Couldn't retry.`;
    case "retry-refused-another-reply":
      return t`Couldn't retry. Another reply started first.`;
    case "retry-lost":
      return t`Couldn't start the retry.`;
    case "brief-retry-lost":
      return t`Couldn't start a new brief.`;
    case "brief-stop-failed":
      return t`Couldn't stop the brief.`;
    case "stop-failed":
      return t`Couldn't stop the reply.`;
    case "send-now-failed":
      return t`Couldn't send now.`;
    case "hand-back-refused":
      return plural(card.count, {
        one: "Couldn't move your queued message.",
        other: "Couldn't move your queued messages.",
      });
    case "hand-back-failed":
      return plural(card.count, {
        one: "Couldn't move your queued message to the message box.",
        other: "Couldn't move your queued messages to the message box.",
      });
    case "usage-blocked":
      return t`You're out of usage. Your messages will send when you add more.`;
    case "send-failed":
      return t`Couldn't send.`;
    case "compact-enqueue-failed":
      return controlStatusCopy({ kind: "compact" }, "failed");
    case "switch-draft-failed":
      return controlStatusCopy({ kind: "write_mode", mode: "draft" }, "failed");
    case "switch-direct-failed":
      return controlStatusCopy({ kind: "write_mode", mode: "direct" }, "failed");
    case "compact-withdraw-failed":
      return controlWithdrawFailedCopy({ kind: "compact" });
    case "switch-withdraw-failed":
      return controlWithdrawFailedCopy({ kind: "write_mode", mode: "draft" });
  }
}
