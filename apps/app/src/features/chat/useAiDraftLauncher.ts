/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * The chat card and the entry banner both call `openAiDraft(group, draftId)`
 * to route the writer into inline review. This hook owns the transient
 * side-effects that come with it: navigating to the Context view for the
 * affected doc (so the editor is mounted when review starts) and collapsing
 * the left rail + dock so the review surface gets the full page.
 *
 * Restoration is effect-driven: we watch `controller.inlineReview` and, when
 * it transitions back to `null`, put the shell surfaces back the way we
 * found them. The provider stays lean; this hook is the whole feature.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import {
  PROJECT_SURFACE_IDS,
  type SurfaceId,
  type SurfaceLayoutMap,
  useProjectLayout,
} from "@/features/project/layout";
import { useProjectSurfacePrefsActions } from "@/features/project/layout/surface-prefs-store";
import type { ScreenKey } from "@/features/project/shell/screens";

import { useDraftReview } from "./DraftReviewProvider";

interface RailSnapshot {
  left: boolean;
  dock: boolean;
}

// Snapshot lives at module scope because the surface that CAPTURES it
// (the chat card) unmounts as soon as `openAiDraft` navigates to Context
// view; the surface that RESTORES it (the entry banner) mounts fresh in
// the editor. A per-hook `useRef` would be discarded across that hop.
// A single-user client only ever has one review in flight, so a shared
// module ref is enough.
let priorRailSnapshot: RailSnapshot | null = null;

export function useAiDraftLauncher() {
  const { controller } = useDraftReview();
  const params = useParams({ strict: false }) as { projectId?: string };
  const search = useSearch({ strict: false }) as {
    screen?: ScreenKey;
    scheme?: string;
    path?: string;
  };
  const navigate = useNavigate();
  const layout = useProjectLayout((search.screen ?? "chat") as ScreenKey);
  const { setSurfaceCollapsed, setDockCollapsed } = useProjectSurfacePrefsActions();

  // Restore rails when review exits. The existence of `priorRailSnapshot`
  // is the flag — any consumer whose review has ended and whose snapshot
  // is still set is responsible for restoring. We don't track
  // `wasInReview` in a per-instance ref because the DraftReviewBar
  // remounts across enter/exit (the editor swaps rooms), which would
  // reset any ref-based flag. `priorRailSnapshot` at module scope
  // survives that hop.
  useEffect(() => {
    if (controller.inlineReview === null && priorRailSnapshot) {
      const snap = priorRailSnapshot;
      priorRailSnapshot = null;
      const leftId = occupantOf(layout, "rail-l");
      const dockId = occupantOf(layout, "dock");
      if (leftId) setSurfaceCollapsed(leftId, snap.left);
      if (dockId) setDockCollapsed(snap.dock);
    }
  }, [controller.inlineReview, layout, setDockCollapsed, setSurfaceCollapsed]);

  const openAiDraft = useCallback(
    (
      group: Pick<ThreadDraftGroup, "documentId"> &
        Partial<Pick<ThreadDraftGroup, "contextPath" | "documentName">>,
      draftId: string,
    ) => {
      const leftId = occupantOf(layout, "rail-l");
      const dockId = occupantOf(layout, "dock");
      // Capture rail state before collapsing so restore-on-exit puts things
      // back the way we found them.
      priorRailSnapshot = {
        left: leftId ? layout[leftId].collapsed : false,
        dock: dockId ? layout[dockId].collapsed : false,
      };

      if (leftId) setSurfaceCollapsed(leftId, true);
      if (dockId) setDockCollapsed(true);

      // Land the writer on the Context view for this doc so the editor is
      // mounted before we flip review on. The server sends the canonical
      // manuscript path; document names are not unique and lose folder context.
      const targetPath = group.contextPath ?? undefined;
      const needsNav =
        search.screen !== "context" || search.scheme !== "manuscript" || search.path !== targetPath;

      if (needsNav && params.projectId && targetPath) {
        void navigate({
          to: "/project/$projectId",
          params: { projectId: params.projectId },
          search: (prev) => ({
            ...prev,
            screen: "context" as const,
            scheme: "manuscript" as const,
            path: targetPath,
            results: undefined,
          }),
        });
      }

      controller.enterInlineReview(group.documentId, draftId);
    },
    [
      controller,
      layout,
      navigate,
      params.projectId,
      search.path,
      search.scheme,
      search.screen,
      setDockCollapsed,
      setSurfaceCollapsed,
    ],
  );

  return { openAiDraft };
}

/** Same rule as ProjectShell.occupantOf — first surface whose placement
 *  points at this slot. Kept local rather than exporting from ProjectShell
 *  so the launcher doesn't reach into shell internals. */
function occupantOf(
  layout: SurfaceLayoutMap,
  slot: "rail-l" | "center" | "dock",
): SurfaceId | null {
  return PROJECT_SURFACE_IDS.find((surfaceId) => layout[surfaceId].slot === slot) ?? null;
}
