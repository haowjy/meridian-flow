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
  /** The toolbar's own place, while something holds it instead of the formatting controls. */
  toolbar: HTMLElement | null;
  setToolbar: Dispatch<SetStateAction<HTMLElement | null>>;
  taken: boolean;
  setTaken: Dispatch<SetStateAction<boolean>>;
};

const DocumentStateSlotContext = createContext<Slot | null>(null);

/**
 * The page's toolbar row carries the document's state after its formatting
 * controls. The active editor's row registers an element; the page chrome
 * renders the state into it with `DocumentStatePortal`, and can take the
 * formatting controls' place with `DocumentToolbarPortal`.
 */
export function DocumentStateSlotProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const [taken, setTaken] = useState(false);
  return (
    <DocumentStateSlotContext.Provider
      value={{ element, setElement, toolbar, setToolbar, taken, setTaken }}
    >
      {children}
    </DocumentStateSlotContext.Provider>
  );
}

/** The toolbar row's end, where the state lands. Only the active editor renders it. */
export function DocumentStateSlotHost() {
  return <SlotHost which="element" className="flex min-w-0 items-center" />;
}

/** The toolbar's place while `DocumentToolbarPortal` holds it. */
export function DocumentToolbarSlotHost() {
  return <SlotHost which="toolbar" className="flex min-w-0 flex-1 items-center" />;
}

function SlotHost({ which, className }: { which: "element" | "toolbar"; className: string }) {
  const slot = useContext(DocumentStateSlotContext);
  const set = which === "element" ? slot?.setElement : slot?.setToolbar;
  const [node, setNode] = useState<HTMLElement | null>(null);
  // An editor swap (live to draft review) can mount the new row before the old one
  // unmounts: a row may only clear the slot while it still holds it.
  useLayoutEffect(() => {
    if (!set || !node) return;
    set(node);
    return () => set((current) => (current === node ? null : current));
  }, [node, set]);
  if (!set) return null;
  return <div ref={setNode} className={className} />;
}

/** Renders into the toolbar row when one is up; otherwise in place, so no state is ever lost. */
export function DocumentStatePortal({ children }: { children: ReactNode }) {
  const element = useContext(DocumentStateSlotContext)?.element;
  return element ? createPortal(children, element) : children;
}

/** Whether `DocumentToolbarPortal` holds the toolbar's place. */
export function useToolbarTaken(): boolean {
  return useContext(DocumentStateSlotContext)?.taken ?? false;
}

/**
 * While mounted, the toolbar row shows `children` in place of the formatting controls (their
 * shortcuts still work). With no toolbar row up they render nowhere.
 */
export function DocumentToolbarPortal({ children }: { children: ReactNode }) {
  const slot = useContext(DocumentStateSlotContext);
  const setTaken = slot?.setTaken;
  useLayoutEffect(() => {
    if (!setTaken) return;
    setTaken(true);
    return () => setTaken(false);
  }, [setTaken]);
  return slot?.toolbar ? createPortal(children, slot.toolbar) : null;
}
