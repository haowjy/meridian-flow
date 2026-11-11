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
  setHosts: Dispatch<SetStateAction<readonly HTMLElement[]>>;
};

const DocumentStateSlotContext = createContext<Slot | null>(null);

/**
 * The page's toolbar row carries the document's state after its formatting
 * controls. The active editor's row registers an element; the page chrome
 * renders the state into it with `DocumentStatePortal`.
 */
export function DocumentStateSlotProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<readonly HTMLElement[]>([]);
  return (
    <DocumentStateSlotContext.Provider value={{ element: hosts.at(-1) ?? null, setHosts }}>
      {children}
    </DocumentStateSlotContext.Provider>
  );
}

/** The toolbar row's end, where the state lands. Only the active editor renders it. */
export function DocumentStateSlotHost() {
  const setHosts = useContext(DocumentStateSlotContext)?.setHosts;
  const [node, setNode] = useState<HTMLElement | null>(null);
  // Rows mount and unmount in any order (an editor swap, a pane loading behind the open
  // one): the newest row still mounted holds the slot, so one leaving hands it back.
  useLayoutEffect(() => {
    if (!setHosts || !node) return;
    setHosts((hosts) => [...hosts.filter((host) => host !== node), node]);
    return () => setHosts((hosts) => hosts.filter((host) => host !== node));
  }, [node, setHosts]);
  if (!setHosts) return null;
  return <div ref={setNode} className="flex min-w-0 items-center" />;
}

/** Renders into the toolbar row when one is up; otherwise in place, so no state is ever lost. */
export function DocumentStatePortal({ children }: { children: ReactNode }) {
  const element = useContext(DocumentStateSlotContext)?.element;
  return element ? createPortal(children, element) : children;
}
