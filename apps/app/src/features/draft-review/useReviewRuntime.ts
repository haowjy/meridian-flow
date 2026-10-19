/** React holds the shared runtime for exactly as long as a surface holds its room. */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReviewRoom, ReviewRuntime } from "./review-runtime";
import { EMPTY_REVIEW_STATE, retainReviewRuntime } from "./review-runtime";

export function useReviewRuntime(room: ReviewRoom | null): ReviewRuntime | null {
  const [held, setHeld] = useState<{ room: ReviewRoom; runtime: ReviewRuntime } | null>(null);
  useEffect(() => {
    if (!room) return;
    const hold = retainReviewRuntime(room);
    setHeld({ room, runtime: hold.runtime });
    return hold.release;
  }, [room]);
  return held?.room === room ? held.runtime : null;
}
const noSubscribe = () => () => {};
const empty = () => EMPTY_REVIEW_STATE;
export function useReviewState(runtime: ReviewRuntime | null) {
  return useSyncExternalStore(runtime?.subscribe ?? noSubscribe, runtime?.state ?? empty, empty);
}
