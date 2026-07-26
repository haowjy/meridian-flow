/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point (chat card, entry banner, composer DraftDock strip,
 * dock Changes row) calls `openAiDraft(group, draftId)`. Review is a REVEAL,
 * not a destination: it opens the Changes view in the dock the writer is
 * already looking at and never changes `?screen`. Changes is a dock view on
 * every screen, and its proposal cards render from the server preview, so the
 * writer can settle AI edits from Home, Chat, or the Editor alike.
 *
 * On the Editor screen review also has a manuscript to land on, so there it
 * additionally points the editor at the drafted document (a tab switch inside
 * the same screen) and collapses the left rail to give the prose width. That
 * rail collapse is effect-restored: we watch `controller.inlineReview` and put
 * the rail back when it returns to `null`. The remembered dock view is left as
 * Changes — the writer switches back explicitly.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { useContextTabsActions } from "@/client/stores";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { useDockViewStore } from "@/features/project/dock/dock-view-store";
import { occupantOf, useProjectLayout } from "@/features/project/layout";
import { useProjectSurfacePrefsActions } from "@/features/project/layout/surface-prefs-store";
import type { ScreenKey } from "@/features/project/shell/screens";

import { useDraftReview } from "./DraftReviewProvider";

interface RailSnapshot {
  left: boolean;
}

// Snapshot lives at module scope because the surface that CAPTURES it may
// unmount before review ends — the editor surface remounts when review swaps
// rooms, and a tab switch inside the Editor screen replaces the pane that
// captured it. A per-hook `useRef` would be discarded across those hops. A
// single-user client only ever has one review in flight, so a shared module
// ref is enough.
let priorRailSnapshot: RailSnapshot | null = null;

export function useAiDraftLauncher() {
  const { controller } = useDraftReview();
  const params = useParams({ strict: false }) as { projectId?: string };
  const search = useSearch({ strict: false }) as {
    screen?: ScreenKey;
    thread?: string;
    scheme?: string;
    path?: string;
  };
  const navigate = useNavigate();
  // Mirrors the route's screen resolution — the dock view and rail occupant
  // are read off the screen the writer is actually on.
  const screen: ScreenKey = search.screen ?? (search.thread ? "chat" : "home");
  const layout = useProjectLayout(screen);
  const { setSurfaceCollapsed, setDockCollapsed } = useProjectSurfacePrefsActions();
  const setDockView = useDockViewStore((state) => state.setDockView);
  const { openTab } = useContextTabsActions();

  // Restore the left rail when review exits. The existence of
  // `priorRailSnapshot` is the flag — any consumer whose review has ended and
  // whose snapshot is still set is responsible for restoring. We don't track
  // `wasInReview` in a per-instance ref because the editor surface remounts
  // across enter/exit (the editor swaps rooms), which would reset any
  // ref-based flag. `priorRailSnapshot` at module scope survives that hop.
  useEffect(() => {
    if (controller.inlineReview === null && priorRailSnapshot) {
      const snap = priorRailSnapshot;
      priorRailSnapshot = null;
      const leftId = occupantOf(layout, "rail-l");
      if (leftId) setSurfaceCollapsed(leftId, snap.left);
    }
  }, [controller.inlineReview, layout, setSurfaceCollapsed]);

  const openAiDraft = useCallback(
    (
      group: Pick<ThreadDraftGroup, "documentId"> &
        Partial<Pick<ThreadDraftGroup, "contextPath" | "documentName">> & {
          /** Draft-created document — marks the synthesized tab `draftOnly`. */
          isNewDocument?: boolean;
        },
      draftId: string,
    ) => {
      // Review appears where the writer is: the dock they can already see
      // switches to Changes, opened if they had it parked.
      setDockView(screen, "changes");
      setDockCollapsed(false);

      // Open the tab from draft metadata regardless of screen, so the document
      // is waiting whenever the writer reaches the Editor. For draft-only NEW
      // documents there is no tree entry until accept, so the controller's
      // route→tab auto-open has nothing to match (#153); for existing docs
      // this is the same tab the auto-open would create, and the store merges
      // by documentId so nothing duplicates.
      if (params.projectId) {
        const tab = contextTabFromDraftGroup(group);
        if (tab) openTab(params.projectId, tab);
      }

      // Only the Editor screen has a manuscript for the inline diff to land on.
      // There, give review the prose width and point the editor at the drafted
      // document — a tab switch within this screen, never a screen change. The
      // server sends the canonical manuscript path; document names are not
      // unique and lose folder context.
      if (screen === "context") {
        const leftId = occupantOf(layout, "rail-l");
        // Capture the left rail before collapsing so restore-on-exit puts it
        // back the way we found it.
        priorRailSnapshot = { left: leftId ? layout[leftId].collapsed : false };
        if (leftId) setSurfaceCollapsed(leftId, true);

        const targetPath = group.contextPath ?? undefined;
        const showsTarget = search.scheme === "manuscript" && search.path === targetPath;
        if (!showsTarget && params.projectId && targetPath) {
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
      }

      controller.enterInlineReview(group.documentId, draftId);
    },
    [
      controller,
      layout,
      navigate,
      openTab,
      params.projectId,
      screen,
      search.path,
      search.scheme,
      setDockCollapsed,
      setDockView,
      setSurfaceCollapsed,
    ],
  );

  return { openAiDraft };
}
