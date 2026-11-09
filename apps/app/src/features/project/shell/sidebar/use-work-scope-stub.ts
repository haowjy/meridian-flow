import { useState } from "react";

/**
 * Stand-in for `useWorkScope` in `client/current-work.ts` (the tech lead's, in
 * progress). Same name and shape, so the swap is one import. Remembers the pick
 * in memory only and repaints nothing.
 */
export function useWorkScope(_projectId: string, seed: string | null) {
  const [picked, setWorkId] = useState<string | null>(null);
  return { workId: picked ?? seed, setWorkId };
}
