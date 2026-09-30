/**
 * The Work page's toolbar keeps one tab switch across both tabs, so a
 * keyboard switch keeps its focus; each tab fills the tools beside it from
 * its own tree, which owns that tab's state.
 */
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

const ToolbarSlot = createContext<HTMLElement | null>(null);

export const WorkToolbarSlotProvider = ToolbarSlot.Provider;

/** Renders its children in the Work toolbar, beside the tab switch. */
export function WorkToolbarTools({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot);
  return slot ? createPortal(children, slot) : null;
}
