import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { LockedWorkLifecycle } from "../../../shared/work-lifecycle-lock.js";
import { ThreadWorkUnavailableAdmissionError } from "./user-turn-admission.js";

type ThreadWorkLock = {
  primaryWorkId: WorkId | null;
  workStates: Map<WorkId, LockedWorkLifecycle>;
};

export async function requireWritableThread(
  lockThreadAndWorks: (threadId: ThreadId) => Promise<ThreadWorkLock | null>,
  threadId: ThreadId,
): Promise<void> {
  const locked = await lockThreadAndWorks(threadId);
  const state = locked?.primaryWorkId ? locked.workStates.get(locked.primaryWorkId) : "missing";
  if (state === "deleted" || state === "missing" || state === undefined) {
    throw new ThreadWorkUnavailableAdmissionError();
  }
}
