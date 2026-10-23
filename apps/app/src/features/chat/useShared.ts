/** Keeps a projection's previous object while its value is unchanged. */
import { useState } from "react";

export function useShared<T>(next: T, same: (left: T, right: T) => boolean): T {
  const [stored, setStored] = useState(next);
  if (same(stored, next)) return stored;
  setStored(next);
  return next;
}
