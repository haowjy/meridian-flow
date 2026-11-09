import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

type Slot = { element: HTMLElement | null; setElement: (element: HTMLElement | null) => void };

const DocumentStateSlotContext = createContext<Slot | null>(null);

/**
 * The page's toolbar row carries the document's state after its formatting
 * controls. The active editor's row registers an element; the page chrome
 * renders the state into it with `DocumentStatePortal`.
 */
export function DocumentStateSlotProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  return (
    <DocumentStateSlotContext.Provider value={{ element, setElement }}>
      {children}
    </DocumentStateSlotContext.Provider>
  );
}

/** The toolbar row's end, where the state lands. Only the active editor renders it. */
export function DocumentStateSlotHost() {
  const slot = useContext(DocumentStateSlotContext);
  if (!slot) return null;
  return <div ref={slot.setElement} className="flex min-w-0 items-center" />;
}

/** Renders into the toolbar row when one is up; otherwise in place, so no state is ever lost. */
export function DocumentStatePortal({ children }: { children: ReactNode }) {
  const element = useContext(DocumentStateSlotContext)?.element;
  return element ? createPortal(children, element) : children;
}
