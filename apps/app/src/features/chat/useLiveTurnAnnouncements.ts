/**
 * useLiveTurnAnnouncements — routes live assistant turn transitions to a11y.
 *
 * Watches the canonical assistant `Turn` from ThreadStore (not a separate live
 * view model), announces thinking/tool/completion states, and restores composer
 * focus after terminal transitions.
 */
import { t } from "@lingui/core/macro";
import { blockContentRecord, type Turn } from "@meridian/contracts/protocol";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { announce, announceError } from "@/client/stores";
import type { ComposerHandle } from "./Composer";
import { reportChatError } from "./error-telemetry";

function runningToolName(turn: Turn | null): string | null {
  const block = [...(turn?.blocks ?? [])]
    .reverse()
    .find((candidate) => candidate.blockType === "tool_use" && candidate.status === "partial");
  if (!block) return null;
  const toolName = blockContentRecord(block).toolName;
  return typeof toolName === "string" ? toolName : "tool";
}

export function useLiveTurnAnnouncements(
  threadId: string,
  liveTurn: Turn | null,
  composerRef: RefObject<ComposerHandle | null>,
  chatSurfaceRef: RefObject<HTMLDivElement | null>,
): void {
  const announcedThinkingRef = useRef(false);
  const status = liveTurn?.status ?? "pending";
  const prevStatusRef = useRef(status);
  const toolName = useMemo(() => runningToolName(liveTurn), [liveTurn]);
  const hasPartialText = Boolean(
    liveTurn?.blocks.some((block) => block.blockType === "text" && block.status === "partial"),
  );

  useEffect(() => {
    if (status === "streaming" && prevStatusRef.current !== "streaming") {
      announcedThinkingRef.current = false;
    }

    if (status === "streaming" && hasPartialText && !announcedThinkingRef.current) {
      announce(t`Assistant is thinking`);
      announcedThinkingRef.current = true;
    }

    if (toolName) {
      announce(t`Running ${toolName}`);
    }

    if (status !== prevStatusRef.current) {
      if (status === "complete") {
        announce(t`Response complete`);
        const active = document.activeElement;
        if (!active || chatSurfaceRef.current?.contains(active) || active === document.body) {
          composerRef.current?.focus();
        }
      } else if (status === "cancelled") {
        announce(t`Turn cancelled`);
      } else if (status === "error") {
        if (liveTurn?.error) announceError(liveTurn.error);
        reportChatError({
          turnId: liveTurn?.id ?? "unknown",
          threadId,
          category: "agent_run",
          userMessage: t`Something went wrong generating a response.`,
          raw: liveTurn?.error ?? "",
          occurredAt: new Date(),
        });
      }
    }

    prevStatusRef.current = status;
  }, [chatSurfaceRef, composerRef, hasPartialText, liveTurn, status, threadId, toolName]);
}
