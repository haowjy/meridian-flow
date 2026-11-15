import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/**
 * Runs `onOpen` each time the writer goes somewhere, so what lies over main (the phone's sheet,
 * a narrow window's sidebar) folds to show where they went. Arriving is not an open. The history
 * position, not the entry's key: an address repair (a rename, a stripped param) replaces the
 * entry in place. Settings (`?settings=`) is an overlay above everything, not a place: opening or
 * closing it is not an open.
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
    latest.current();
  }, [position, settings]);
}
