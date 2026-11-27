import { createContext, useContext } from "react";

export type PanePlace = "main" | "side";

export const PanePlaceContext = createContext<PanePlace | null>(null);

export const useOptionalPanePlace = () => useContext(PanePlaceContext);

export const usePanePlace = (): PanePlace => useOptionalPanePlace() ?? "main";

export const mainTabStripHasFocus = () =>
  !!document.activeElement?.closest("[data-main-tab-strip]");
