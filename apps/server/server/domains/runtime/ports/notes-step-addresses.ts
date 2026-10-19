/** Side-effect-free proof that every tool address belongs to the caller's notes folder. */
import type { ThreadId } from "@meridian/contracts/runtime";

export interface NotesStepAddresses {
  admits(threadId: ThreadId, call: { name: string; arguments: unknown }): Promise<boolean>;
}
