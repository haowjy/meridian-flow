/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point supplies the draft's owning Work. The route-owned
 * handoff stages that identity, navigates to its manuscript in Editor, and lets
 * the matching Editor scope claim it after the route and document commit. The
 * launcher never commands an ambient review controller or changes dock state.
 * Review entry preserves the writer's collapsed/open dock and selected view.
 */
import { useCallback } from "react";

import { type AiDraftLaunchTarget, useOpenEditorReview } from "./editor-review-handoff";

export function useAiDraftLauncher() {
  const openEditorReview = useOpenEditorReview();

  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      void openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [openEditorReview],
  );

  return { openAiDraft };
}
