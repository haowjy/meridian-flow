/** A stable event callback that reads the latest committed render. */
import { useCallback, useLayoutEffect, useRef } from "react";

export function useCommittedEvent<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const committed = useRef(fn);
  useLayoutEffect(() => {
    committed.current = fn;
  }, [fn]);
  return useCallback((...args: Args) => committed.current(...args), []);
}
