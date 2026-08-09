import { useCallback, useState } from "react";
import {
  initialNavigationState,
  type NavigationEvent,
  reduceNavigation,
} from "./composer-toolbar-navigation";
import type { ToolbarNavigationInput } from "./types";

export function useComposerToolbarMachine(input: ToolbarNavigationInput) {
  const [stored, setStored] = useState(() => initialNavigationState(input));
  let state = stored;
  if (stored.input.revision !== input.revision) {
    state = reduceNavigation(stored, { type: "inputs.changed", input });
    setStored(state);
  }
  const dispatch = useCallback((event: NavigationEvent) => {
    setStored((current) => reduceNavigation(current, event));
  }, []);
  return [state, dispatch] as const;
}
