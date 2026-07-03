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
import { useCallback, useEffect, useRef } from "react";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
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

  const priorRailStateRef = useRef<RailSnapshot | null>(null);
  const inReviewRef = useRef(controller.inlineReview !== null);

  // Restore rails when review exits. We use a ref-driven diff instead of
  // deps on setSurfaceCollapsed / setDockCollapsed so the effect only fires
  // on the transition; the setters are stable.
  useEffect(() => {
    const nowInReview = controller.inlineReview !== null;
    const wasInReview = inReviewRef.current;
    inReviewRef.current = nowInReview;
    if (wasInReview && !nowInReview && priorRailStateRef.current) {
      const snap = priorRailStateRef.current;
      priorRailStateRef.current = null;
      const leftId = occupantOf(layout, "rail-l");
      const dockId = occupantOf(layout, "dock");
      if (leftId) setSurfaceCollapsed(leftId, snap.left);
      if (dockId) setDockCollapsed(snap.dock);
    }
  }, [controller.inlineReview, layout, setDockCollapsed, setSurfaceCollapsed]);

  const openAiDraft = useCallback(
    (group: Pick<ThreadDraftGroup, "documentId" | "documentName">, draftId: string) => {
      const leftId = occupantOf(layout, "rail-l");
      const dockId = occupantOf(layout, "dock");
      // Capture rail state before collapsing so restore-on-exit puts things
      // back the way we found them.
      priorRailStateRef.current = {
        left: leftId ? layout[leftId].collapsed : false,
        dock: dockId ? layout[dockId].collapsed : false,
      };

      if (leftId) setSurfaceCollapsed(leftId, true);
      if (dockId) setDockCollapsed(true);

      // Land the writer on the Context view for this doc so the editor is
      // mounted before we flip review on. Path convention matches the route
      // search shape (`?screen=context&scheme=manuscript&path=/…`).
      // documentName is the file's flat name; manuscript files sit at the
      // scheme root today, so prepending `/` produces the right path. If
      // the flat convention changes, teach this hook the real documentId →
      // path lookup rather than growing another layer.
      const targetPath = group.documentName ? `/${group.documentName}` : undefined;
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
