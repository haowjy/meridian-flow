import type { ClosedOwnerWhy } from "@meridian/contracts/commands";

/**
 * Joined rooms by the owners (Works and lineages, keyed by `ownerAccessKey`) their file access depends on (file-access
 * §7). A Work's archive, unarchive, delete or restore reaches exactly the rooms
 * of its own files, its scratch and the documents only it has, and no manuscript, kb or user
 * room. A room is named by document, not by owner, so room names can't answer this.
 */

/** One admitted room of a socket; `revoke` ends it so the client rejoins. */
export type RoomRegistration = { revoke(why?: ClosedOwnerWhy): void };

export function createRoomAccessIndex() {
  const byOwner = new Map<string, Set<RoomRegistration>>();
  const ownersOf = new Map<RoomRegistration, readonly string[]>();

  function unregister(registration: RoomRegistration): void {
    for (const ownerKey of ownersOf.get(registration) ?? []) {
      const registrations = byOwner.get(ownerKey);
      registrations?.delete(registration);
      if (registrations?.size === 0) byOwner.delete(ownerKey);
    }
    ownersOf.delete(registration);
  }

  return {
    register(registration: RoomRegistration, ownerKeys: readonly string[]): void {
      unregister(registration);
      ownersOf.set(registration, ownerKeys);
      for (const ownerKey of ownerKeys) {
        const registrations = byOwner.get(ownerKey) ?? new Set();
        registrations.add(registration);
        byOwner.set(ownerKey, registrations);
      }
    },
    unregister,
    /** Closes every connection whose access this owner decides. */
    revokeOwner(ownerKey: string, why?: ClosedOwnerWhy): void {
      for (const registration of [...(byOwner.get(ownerKey) ?? [])]) {
        unregister(registration);
        registration.revoke(why);
      }
    },
  };
}
