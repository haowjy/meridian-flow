/**
 * Review reads that first run the document derivations, which count each Work's suggestions. In
 * production they follow a write within seconds; a test that asserts membership right after a
 * write reads through this instead of sleeping.
 */
import type { CollabDomain } from "../contracts.js";

/** Every function member of `target` awaits `flush` before it runs. */
export function settleBefore<T extends object>(target: T, flush: () => Promise<void>): T {
  const members = target as unknown as Record<string, unknown>;
  for (const [name, member] of Object.entries(members))
    if (typeof member === "function") {
      const read = (member as (...args: unknown[]) => Promise<unknown>).bind(target);
      members[name] = async (...args: unknown[]) => {
        await flush();
        return read(...args);
      };
    }
  return target;
}

export function convergedReview<C extends CollabDomain>(collab: C): C {
  const flush = async () => {
    await collab.documentDerivations.sweep();
  };
  settleBefore(collab.draftReview, flush);
  return collab;
}
