/**
 * Where a document opens, decided once at the shell boundary.
 *
 * A chat door (link chip, receipt, passage, `@` reference) or a Recent row opens *beside the
 * chat* only on the wide Chat screen, where the chat is in the middle: the tab store opens the
 * document as the project's preview tab and selects it, and the dock shows the selected tab. The
 * address stays on the chat. Elsewhere nothing is registered and a pick opens an Editor tab and
 * route. The phone never holds a dock document.
 *
 * Every asynchronous attempt claims first (`claimOpenIntent`) and commits with that claim, so a
 * slower, older attempt can never replace a newer choice; a superseded commit is `cancelled`.
 */
import { useCallback } from "react";
import { type ContextTab, getContextTabs, tabKey, useContextTabsStore } from "@/client/stores";
import { armEditorFocus } from "@/features/editor/focus-on-open";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { isCurrentOpenIntent } from "../context/open-intent";
import { useProjectDocumentNavigationProjectId } from "../context/open-project-document";
import { settleWriterClose } from "../context/use-follow-open-document-placement";
import type { ReviewAddress } from "../presented-document";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import type { ScreenKey } from "../shell/screens";

/** A chat/Scratch pick opens beside the chat: only when the chat is in the middle. */
export function opensBesideChat(screen: ScreenKey, phone: boolean): boolean {
  return screen === "chat" && !phone;
}

export type DockCommit = { kind: "opened"; tab: ContextTab } | { kind: "cancelled" };

/**
 * `mode` "peek" fills the project's one preview tab (the previous peek closes); "open" keeps a
 * normal tab. A document already open is only selected, so peeking never replaces the tab the
 * writer is working in.
 */
export type BesideCommit = (
  tab: ContextTab,
  claim?: number,
  focus?: true,
  review?: ReviewAddress,
  mode?: "peek" | "open",
) => DockCommit;

export function useDockPlacement() {
  const screen = useProjectScreen();
  const phone = usePhoneShell() === true;
  const projectId = useProjectDocumentNavigationProjectId();
  const { revealDock } = useChatNavigation();
  const coordinator = useContextRemovalCoordinator();
  const commit = useCallback<BesideCommit>(
    (tab, claim, focus, review, mode = "peek") => {
      if (!projectId || screen !== "chat") return { kind: "cancelled" };
      if (claim !== undefined && !isCurrentOpenIntent(claim)) return { kind: "cancelled" };
      const store = useContextTabsStore.getState();
      const previous = getContextTabs(projectId).tabs.find((t) => t.preview);
      const wasOpen = getContextTabs(projectId).tabs.some((t) => t.documentId === tab.documentId);
      store.openTab(projectId, tab, undefined, undefined, { select: true });
      const opened = getContextTabs(projectId).tabs.find((t) => t.documentId === tab.documentId);
      if (!opened) return { kind: "cancelled" };
      const key = tabKey(opened);
      if (review)
        store.setTabState(projectId, key, { reviewPin: review, view: { version: "draft" } });
      if (mode === "peek" && !wasOpen) {
        store.setTabState(projectId, key, { preview: true });
        if (previous) settleWriterClose(coordinator.writerClose(projectId, previous));
      }
      if (focus) armEditorFocus(key);
      revealDock("document");
      return { kind: "opened", tab: opened };
    },
    [projectId, revealDock, screen, coordinator],
  );
  return { screen, phone, besideChat: opensBesideChat(screen, phone), commit };
}
