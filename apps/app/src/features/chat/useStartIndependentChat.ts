import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useAgentCatalog } from "@/client/query/useAgentCatalog";
import {
  announceError,
  useProjectActions,
  useProjectStore,
  useThreadActions,
} from "@/client/stores";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { startIndependentChat } from "@/lib/optimistic-independent-chat";

/**
 * Start an independent (project-less) chat. Optionally seeds the first message;
 * empty text opens with the composer focused. Navigates to `/chat/:threadId`.
 */
export function useStartIndependentChat() {
  const navigate = useNavigate();
  const catalog = useAgentCatalog();
  const general = catalog.agents?.find(
    (agent) =>
      agent.ownership === "system" &&
      agent.slug === DEFAULT_AGENT_SLUG &&
      !agent.unavailableReasons.length,
  );
  const projectActions = useProjectActions();
  const threadActions = useThreadActions();
  const now = useProjectStore((s) => s.now);

  const start = useCallback(
    (text?: string) => {
      if (!general) {
        announceError("General is unavailable. Load the Agent catalog and try again.");
        return;
      }
      startIndependentChat({ agent: general, text, projectActions, threadActions, navigate, now });
    },
    [general, navigate, now, projectActions, threadActions],
  );
  return { start, ready: !!general };
}
