import { createContext, useContext } from "react";

/**
 * The pane a surface is drawn in: main or the side. Each host (a document host, the chat host, the
 * phone's sheet) provides it, so a link or a reveal knows where it was followed from
 * (`place` in `side/SideView.tsx`). Outside any host (the left sidebar) it is null, and an open
 * goes to main. A chat in main also takes focus when it opens; the side's follows main and
 * doesn't, and its new chat keeps its own draft.
 */
export type PanePlace = "main" | "side";

export const PanePlaceContext = createContext<PanePlace | null>(null);

/** Null outside a host. */
export const useOptionalPanePlace = () => useContext(PanePlaceContext);

export const usePanePlace = (): PanePlace => useOptionalPanePlace() ?? "main";

/**
 * Main's tab strip has the focus: a chat arriving in main must not take it, so a keyboard user
 * moving along the chat tabs stays on the strip, as in the document lane.
 */
export const mainTabStripHasFocus = () =>
  !!document.activeElement?.closest("[data-main-tab-strip]");
