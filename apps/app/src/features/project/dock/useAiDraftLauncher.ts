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
 * the same screen). The prose width review gets there is NOT set here — the
 * shell derives it from review being open (`review-prose-focus.ts`), so this
 * launcher never touches the writer's saved rail preference. The remembered
 * dock view is left as Changes — the writer switches back explicitly.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useContextTabsActions } from "@/client/stores";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { contextTabFromDraftGroup } from "@/features/project/context/context-tab-from-draft";
import { useDockViewStore } from "@/features/project/dock/dock-view-store";
import { useProjectSurfacePrefsActions } from "@/features/project/layout/surface-prefs-store";
import type { ScreenKey } from "@/features/project/shell/screens";

export type AiDraftLaunchTarget = {
  workId: string;
  documentId: string;
  draftId: string;
  contextPath: string;
  documentName?: string;
  isNewDocument?: boolean;
};

export function useAiDraftLauncher() {
  const { controller } = useDraftReview();
  const params = useParams({ strict: false }) as { projectId?: string };
  const search = useSearch({ strict: false }) as {
    screen?: ScreenKey;
    thread?: string;
    scheme?: string;
    path?: string;
    work?: string;
  };
  const navigate = useNavigate();
  // Mirrors the route's screen resolution — the dock view is read off the
  // screen the writer is actually on.
  const screen: ScreenKey = search.screen ?? (search.thread ? "chat" : "home");
  const { setDockCollapsed } = useProjectSurfacePrefsActions();
  const setDockView = useDockViewStore((state) => state.setDockView);
  const { openTab } = useContextTabsActions();

  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      // Review appears where the writer is: the dock they can already see
      // switches to Changes, opened if they had it parked.
      setDockView(screen, "changes");
      setDockCollapsed(false);

      // Open the tab from draft metadata regardless of screen, so the document
      // is waiting whenever the writer reaches the Editor. For draft-only NEW
      // documents there is no tree entry until Apply, so the controller's
      // route→tab auto-open has nothing to match (#153); for existing docs
      // this is the same tab the auto-open would create, and the store merges
      // by documentId so nothing duplicates.
      if (params.projectId) {
        const tab = contextTabFromDraftGroup(target);
        if (tab) openTab(params.projectId, tab);
      }

      // Only the Editor screen has a manuscript for the inline diff to land on.
      // There, point the editor at the drafted document — a tab switch within
      // this screen, never a screen change. The server sends the canonical
      // manuscript path; document names are not unique and lose folder context.
      if (screen === "context") {
        const targetPath = target.contextPath ?? undefined;
        const showsTarget =
          search.scheme === "manuscript" &&
          search.path === targetPath &&
          search.work === target.workId;
        if (!showsTarget && params.projectId && targetPath) {
          void navigate({
            to: "/project/$projectId",
            params: { projectId: params.projectId },
            search: (prev) => ({
              ...prev,
              screen: "context" as const,
              scheme: "manuscript" as const,
              work: target.workId,
              path: targetPath,
              results: undefined,
            }),
          });
        }
      }

      controller.enterInlineReview(target.documentId, target.draftId);
    },
    [
      controller,
      navigate,
      openTab,
      params.projectId,
      screen,
      search.path,
      search.scheme,
      search.work,
      setDockCollapsed,
      setDockView,
    ],
  );

  return { openAiDraft };
}
