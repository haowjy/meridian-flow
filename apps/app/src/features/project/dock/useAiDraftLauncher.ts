/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point supplies the draft's owning Work. The route-owned
 * handoff stages that identity, navigates to its manuscript in Editor, and lets
 * the matching Editor scope claim it after the route and document commit. The
 * launcher only reveals Changes chrome; it never commands an ambient review
 * controller or writes the writer's saved layout preferences.
 */
import { useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useDockViewStore } from "@/features/project/dock/dock-view-store";
import { useProjectSurfacePrefsActions } from "@/features/project/layout/surface-prefs-store";
import type { ScreenKey } from "@/features/project/shell/screens";
import { useOpenEditorReview } from "./editor-review-handoff";

export type AiDraftLaunchTarget = {
  workId: string;
  documentId: string;
  draftId: string;
  contextPath: string;
  documentName?: string;
  isNewDocument?: boolean;
};

export function useAiDraftLauncher() {
  const search = useSearch({ strict: false }) as {
    screen?: ScreenKey;
    thread?: string;
  };
  const openEditorReview = useOpenEditorReview();
  // Mirrors the route's screen resolution — the dock view is read off the
  // screen the writer is actually on.
  const screen: ScreenKey = search.screen ?? (search.thread ? "chat" : "home");
  const { setDockCollapsed } = useProjectSurfacePrefsActions();
  const setDockView = useDockViewStore((state) => state.setDockView);

  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      // Review appears where the writer is: the dock they can already see
      // switches to Changes, opened if they had it parked.
      setDockView(screen, "changes");
      setDockCollapsed(false);

      void openEditorReview(target).catch(() => undefined);
    },
    [openEditorReview, screen, setDockCollapsed, setDockView],
  );

  return { openAiDraft };
}
