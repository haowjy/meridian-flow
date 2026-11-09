import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type Slot = {
  element: HTMLElement | null;
  setElement: Dispatch<SetStateAction<HTMLElement | null>>;
};

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
  const setElement = useContext(DocumentStateSlotContext)?.setElement;
  const mine = useRef<HTMLElement | null>(null);
  // An editor swap (live to draft review) mounts the new row before the old one
  // unmounts: the old row may only clear the slot while it still holds it.
  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (!setElement) return;
      if (node) {
        mine.current = node;
        setElement(node);
      } else {
        const previous = mine.current;
        mine.current = null;
        setElement((current) => (current === previous ? null : current));
      }
    },
    [setElement],
  );
  if (!setElement) return null;
  return <div ref={ref} className="flex min-w-0 items-center" />;
}

/** Renders into the toolbar row when one is up; otherwise in place, so no state is ever lost. */
export function DocumentStatePortal({ children }: { children: ReactNode }) {
  const element = useContext(DocumentStateSlotContext)?.element;
  return element ? createPortal(children, element) : children;
}
