/**
 * Where a document opens, decided once at the shell boundary, and the one commit
 * into the dock.
 *
 * Two placement rules differ on purpose:
 * - A chat or Scratch pick (chat doors, Recent, the left tree, the rail's Scratch
 *   rows) goes *beside the chat*: into the dock only when the chat is in the
 *   middle (the Chat screen, wide). On the Editor and Work screens the chat is
 *   the dock, so a document there would cover the chat it was picked from.
 * - Work Files and the dock's own title menu may replace the dock document on the
 *   Work screen as well, where the dock holds Work Files.
 * The phone never holds a dock document.
 *
 * Every asynchronous attempt claims the dock at the start of its intent
 * (`useDockViewStore.claim`) and commits with that claim, so a slower, older
 * attempt can never replace a newer choice; a superseded commit is `cancelled`.
 */
import { useCallback } from "react";
import type { ContextTab } from "@/client/stores";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useProjectDocumentNavigationProjectId } from "../context/open-project-document";
import { useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import type { ScreenKey } from "../shell/screens";
import { useDockViewStore } from "./dock-view-store";

/** A chat/Scratch pick opens beside the chat: only when the chat is in the middle. */
export function opensBesideChat(screen: ScreenKey, phone: boolean): boolean {
  return screen === "chat" && !phone;
}

/** Work Files and the dock's own menu may use the dock on the Work screen too. */
export function dockHoldsDocument(screen: ScreenKey, phone: boolean): boolean {
  return (screen === "chat" || screen === "work") && !phone;
}

export type DockCommit = "opened" | "cancelled";

export function useDockPlacement() {
  const screen = useProjectScreen();
  const phone = usePhoneShell() === true;
  const projectId = useProjectDocumentNavigationProjectId();
  const { revealDock } = useChatNavigation();
  /** Show `tab` in the dock under `claim` (a fresh one when the caller has none). */
  const commit = useCallback(
    (tab: ContextTab, claim?: number): DockCommit => {
      if (!projectId || (screen !== "chat" && screen !== "work")) return "cancelled";
      return commitDockDocument(projectId, screen, tab, revealDock, claim);
    },
    [projectId, revealDock, screen],
  );
  return {
    screen,
    phone,
    besideChat: opensBesideChat(screen, phone),
    holdsDocument: dockHoldsDocument(screen, phone),
    commit,
  };
}

/** The shared commit boundary for document picks and a rail-switch hand-off. */
export function commitDockDocument(
  projectId: string,
  screen: "chat" | "work",
  tab: ContextTab,
  revealDock: (view: "document") => void,
  claim?: number,
): DockCommit {
  const store = useDockViewStore.getState();
  const attempt = claim ?? store.claim();
  if (!store.commit(attempt, { projectId, screen, tab })) return "cancelled";
  revealDock("document");
  return "opened";
}
