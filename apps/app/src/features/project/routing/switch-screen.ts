/** The rail switch seam: capture what is displayed, then use the destination's one command owner. */
import type { ContextTab } from "@/client/stores";
import type { ScreenKey } from "../shell/screens";
import type { NavigationSettlement } from "./project-navigation";

export function switchScreen(
  next: ScreenKey,
  ports: {
    source: ScreenKey;
    capture: (next: ScreenKey) => { tab: ContextTab; commit: () => void } | undefined;
    showChatScreen: (onAccepted?: () => void) => Promise<void>;
    openInEditor: (
      tab: ContextTab,
      commit: () => void,
      onAccepted: () => void,
    ) => Promise<NavigationSettlement>;
    otherwise: (
      next: ScreenKey,
      onAccepted: () => void,
    ) => Promise<NavigationSettlement> | Promise<void>;
  },
  onAccepted: () => void,
) {
  if (next === ports.source && next !== "chat") return Promise.resolve();
  const handOff = ports.capture(next);
  if (handOff && next === "context")
    return ports.openInEditor(handOff.tab, handOff.commit, onAccepted);
  if (next === "chat")
    return ports.showChatScreen(() => {
      onAccepted();
      handOff?.commit();
    });
  return ports.otherwise(next, onAccepted);
}
