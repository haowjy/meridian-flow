/**
 * useLiveTurnAnnouncements — routes live assistant turn transitions to a11y.
 *
 * Watches the canonical assistant `Turn` from ThreadStore (not a separate live
 * view model), announces thinking/tool/completion states, and restores composer
 * focus after terminal transitions.
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { announce, announceError } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { toolActivityAnnouncement, toolActivityPhrase } from "./command-descriptor";
import { reportChatError } from "./error-telemetry";
import { groupDeliverySegments, type ToolView } from "./group-delivery-segments";
import { isToolViewVisible } from "./tool-view-visibility";

function runningTool(turn: Turn | null): ToolView | null {
  const block = [...(turn?.blocks ?? [])]
    .reverse()
    .find((candidate) => candidate.blockType === "tool_use" && candidate.status === "partial");
  if (!block) return null;
  const segment = groupDeliverySegments([block])[0];
  if (segment?.kind !== "tool") return null;
  // Protocol primitives render their UX elsewhere; announcing them would
  // narrate a row the writer cannot see.
  return isToolViewVisible(segment.tool) ? segment.tool : null;
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
  const tool = useMemo(() => runningTool(liveTurn), [liveTurn]);
  const toolAnnouncement = tool
    ? toolActivityAnnouncement(toolActivityPhrase(tool, liveTurn?.writeMode ?? "direct"))
    : null;
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

    if (toolAnnouncement) {
      announce(toolAnnouncement);
    }

    if (status !== prevStatusRef.current) {
      if (status === "complete") {
        announce(t`Response complete`);
        const active = document.activeElement;
        if (!active || chatSurfaceRef.current?.contains(active) || active === document.body) {
          composerRef.current?.focus();
        }
      } else if (status === "cancelled") {
        announce(t`Stopped`);
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
  }, [chatSurfaceRef, composerRef, hasPartialText, liveTurn, status, threadId, toolAnnouncement]);
}
