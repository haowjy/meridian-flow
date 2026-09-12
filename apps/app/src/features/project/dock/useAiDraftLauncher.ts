/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point supplies the draft's owning Work. The route-owned
 * handoff stages that identity, navigates to its manuscript in Editor, and lets
 * the matching Editor scope claim it after the route and document commit. The
 * launcher only reveals Changes chrome; it never commands an ambient review
 * controller or writes the writer's saved layout preferences.
 */
import { useCallback } from "react";

import { useDockViewStore } from "@/features/project/dock/dock-view-store";
import { useProjectSurfacePrefsActions } from "@/features/project/layout/surface-prefs-store";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { type AiDraftLaunchTarget, useOpenEditorReview } from "./editor-review-handoff";

export function useAiDraftLauncher() {
  const screen = useProjectScreen();
  const openEditorReview = useOpenEditorReview();
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
