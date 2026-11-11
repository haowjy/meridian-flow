import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useLayoutEffect,
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
  const [node, setNode] = useState<HTMLElement | null>(null);
  // An editor swap (live to draft review) can mount the new row before the old one
  // unmounts: a row may only clear the slot while it still holds it.
  useLayoutEffect(() => {
    if (!setElement || !node) return;
    setElement(node);
    return () => setElement((current) => (current === node ? null : current));
  }, [node, setElement]);
  if (!setElement) return null;
  return <div ref={setNode} className="flex min-w-0 items-center" />;
}

/** Renders into the toolbar row when one is up; otherwise in place, so no state is ever lost. */
export function DocumentStatePortal({ children }: { children: ReactNode }) {
  const element = useContext(DocumentStateSlotContext)?.element;
  return element ? createPortal(children, element) : children;
}
