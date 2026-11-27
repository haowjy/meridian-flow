import type { ClosedOwnerWhy } from "@meridian/contracts/commands";

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
    revokeOwner(ownerKey: string, why?: ClosedOwnerWhy): void {
      for (const registration of [...(byOwner.get(ownerKey) ?? [])]) {
        unregister(registration);
        registration.revoke(why);
      }
    },
  };
}
