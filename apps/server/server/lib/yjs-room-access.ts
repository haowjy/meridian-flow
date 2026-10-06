/**
 * Live Yjs connections by the Works their file access depends on (file-access
 * §7). A Work's archive, unarchive, delete or restore reaches exactly the rooms
 * of its own files, its scratch and its drafts, and no manuscript, kb or user
 * room. Branch rooms are named by branch, so room names can't answer this.
 */
import type { WorkId } from "@meridian/contracts/runtime";

/** One admitted connection; `revoke` closes it so the client reconnects. */
export type YjsRoomRegistration = { revoke(): void };

export type YjsRoomAccessIndex = ReturnType<typeof createYjsRoomAccessIndex>;

export function createYjsRoomAccessIndex() {
  const byWork = new Map<WorkId, Set<YjsRoomRegistration>>();
  const worksOf = new Map<YjsRoomRegistration, readonly WorkId[]>();

  function unregister(registration: YjsRoomRegistration): void {
    for (const workId of worksOf.get(registration) ?? []) {
      const registrations = byWork.get(workId);
      registrations?.delete(registration);
      if (registrations?.size === 0) byWork.delete(workId);
    }
    worksOf.delete(registration);
  }

  return {
    register(registration: YjsRoomRegistration, workIds: readonly WorkId[]): void {
      unregister(registration);
      worksOf.set(registration, workIds);
      for (const workId of workIds) {
        const registrations = byWork.get(workId) ?? new Set();
        registrations.add(registration);
        byWork.set(workId, registrations);
      }
    },
    unregister,
    /** Closes every connection whose access this Work decides. */
    revokeWork(workId: WorkId): void {
      for (const registration of [...(byWork.get(workId) ?? [])]) {
        unregister(registration);
        registration.revoke();
      }
    },
  };
}
