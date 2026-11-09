import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

type ToolbarSlot = {
  element: HTMLElement | null;
  setElement: (element: HTMLElement | null) => void;
};

const ToolbarSlotContext = createContext<ToolbarSlot | null>(null);

/**
 * Lets a pane's chrome row host the document toolbar. The row registers an
 * element with `useToolbarSlotRef`; the active editor portals its toolbar there.
 * Without a provider (the dock, the phone) the toolbar stays above the page.
 */
export function ToolbarSlotProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  return (
    <ToolbarSlotContext.Provider value={{ element, setElement }}>
      {children}
    </ToolbarSlotContext.Provider>
  );
}

export function useToolbarSlotRef(): ((element: HTMLElement | null) => void) | undefined {
  return useContext(ToolbarSlotContext)?.setElement;
}

/**
 * Where `toolbar` renders: inline when the pane has no slot, portaled into the
 * slot when this editor is the active one, nowhere for a warm background editor.
 */
export function usePlacedToolbar(toolbar: ReactNode, active: boolean) {
  const slot = useContext(ToolbarSlotContext);
  if (!slot) return { inline: toolbar, portal: null };
  if (!slot.element || !active || !toolbar) return { inline: undefined, portal: null };
  return { inline: undefined, portal: createPortal(toolbar, slot.element) };
}
