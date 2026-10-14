/**
 * An instance-owned branch lease adapter that records the acquisitions it serves: each
 * attempt, and the entry and exit of the real callback. Only a test that builds the primitive
 * itself wraps it; production composition always builds its own and takes no observer.
 */
import {
  type BranchCriticalSections,
  createBranchCriticalSections,
} from "../domains/collab/domain/branch-critical-sections.js";

export type LeaseObserver = {
  sections: BranchCriticalSections;
  /** Acquisitions attempted whose callback has not yet entered. */
  waiting(): string[][];
  /** Callbacks that have entered and not yet exited. */
  holding(): string[][];
  /** Callbacks that have entered, ever. */
  entered(): number;
};

export function observeLeases(inner = createBranchCriticalSections()): LeaseObserver {
  const waiting = new Set<string[]>();
  const holding = new Set<string[]>();
  let entered = 0;
  return {
    sections: {
      withBranches(branchIds, run) {
        const ids = [...branchIds];
        waiting.add(ids);
        return inner
          .withBranches(ids, async (lease) => {
            waiting.delete(ids);
            holding.add(ids);
            entered += 1;
            try {
              return await run(lease);
            } finally {
              holding.delete(ids);
            }
          })
          .finally(() => waiting.delete(ids));
      },
    },
    waiting: () => [...waiting],
    holding: () => [...holding],
    entered: () => entered,
  };
}
