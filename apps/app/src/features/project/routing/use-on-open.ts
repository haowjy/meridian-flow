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
