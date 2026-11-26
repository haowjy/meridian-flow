import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

let switching = 0;
let switchedTo: number | undefined;

export function withoutOpen<T>(navigate: () => Promise<T>): Promise<T> {
  switching += 1;
  return navigate().finally(() => {
    switching -= 1;
    switchedTo = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index;
  });
}

/**
 * Runs `onOpen` each time the writer goes somewhere, so what lies over main (the phone's sheet,
 * a narrow window's sidebar) folds to show where they went. Arriving is not an open. The history
 * position, not the entry's key: an address repair (a rename, a stripped param) replaces the
 * entry in place. Settings (`?settings=`) is an overlay above everything, not a place, and a
 * mode switch (`withoutOpen`) is the sidebar's own navigation: neither is an open.
 */
export function useOnOpen(onOpen: () => void) {
  const position = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const settings = useRouterState({
    select: (state) => (state.location.search as { settings?: string }).settings,
  });
  const seen = useRef({ position, settings });
  const latest = useRef(onOpen);
  latest.current = onOpen;
  useEffect(() => {
    const was = seen.current;
    seen.current = { position, settings };
    if (was.position === position || was.settings !== settings) return;
    if (position === switchedTo) switchedTo = undefined;
    else if (switching === 0) latest.current();
  }, [position, settings]);
}
