/**
 * useLiveTurnAnnouncements — routes live assistant turn transitions to a11y.
 *
 * Watches the canonical assistant `Turn` from ThreadStore (not a separate live
 * view model), announces thinking/tool/completion states, and restores composer
 * focus after terminal transitions.
 *
 * A failure is announced to someone who can still act on it, and only for a failure seen to happen:
 * a turn first observed already failed (a reload, a history page) is not announced, and the alert is
 * taken down once the chat moves past the failure (`failureEnded`, from `chatMovedPast`).
 */
import { t } from "@lingui/core/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { groupDeliverySegments, isToolViewVisible, type ToolView } from "@meridian/thread-client";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { announce, announceError, clearAnnouncement } from "@/client/stores";
import type { ComposerHandle } from "@/components/app/composer";
import { toolActivityAnnouncement, toolActivityPhrase } from "./command-descriptor";
import { reportChatError } from "./error-telemetry";

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

const failureKey = (turnId: string) => `turn-failed:${turnId}`;

export function useLiveTurnAnnouncements(
  threadId: string,
  liveTurn: Turn | null,
  failureEnded: boolean,
  composerRef: RefObject<ComposerHandle | null>,
  chatSurfaceRef: RefObject<HTMLDivElement | null>,
): void {
  const announcedThinkingRef = useRef(false);
  const status = liveTurn?.status ?? "pending";
  const prevStatusRef = useRef(status);
  const observedTurnIdRef = useRef<string | null>(null);
  // The failure this hook published: its alert goes when that turn ends or leaves the chat (forgotten).
  const announcedFailureRef = useRef<string | null>(null);
  const tool = useMemo(() => runningTool(liveTurn), [liveTurn]);
  const toolAnnouncement = tool ? toolActivityAnnouncement(toolActivityPhrase(tool)) : null;
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
      } else if (
        status === "error" &&
        observedTurnIdRef.current === liveTurn?.id &&
        !failureEnded
      ) {
        if (liveTurn?.error) {
          announceError(liveTurn.error, { key: failureKey(liveTurn.id) });
          announcedFailureRef.current = liveTurn.id;
        }
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

    // The failure is over once the chat moved on or the turn left the chat; take its alert down, leaving any other alert alone.
    const announced = announcedFailureRef.current;
    if (announced && (liveTurn?.id !== announced || failureEnded)) {
      clearAnnouncement(failureKey(announced));
      announcedFailureRef.current = null;
    }

    prevStatusRef.current = status;
    observedTurnIdRef.current = liveTurn?.id ?? null;
  }, [
    chatSurfaceRef,
    composerRef,
    failureEnded,
    hasPartialText,
    liveTurn,
    status,
    threadId,
    toolAnnouncement,
  ]);
}
