/** Resolves address selections against an authorized project catalog without inventing IDs. */
import {
  type AddressSelection,
  type ProjectAddress,
  type ProjectDestination,
  workIdSelection,
  workIsIdentity,
} from "./project-address";

export type AddressCatalog<T> =
  | { status: "loading" | "error"; entries?: readonly T[] }
  | { status: "ready"; entries: readonly T[] };
export type AddressResolution<T> =
  | { status: "absent" | "none" }
  | { status: "malformed"; value: string }
  | { status: "loading" | "error" | "unavailable"; id: string }
  | { status: "resolved"; value: T };

export function resolveAddressSelection<T extends { id: string }>(
  selection: AddressSelection,
  catalog: AddressCatalog<T>,
): AddressResolution<T> {
  if (selection.kind === "absent" || selection.kind === "none") return { status: selection.kind };
  if (selection.kind === "malformed") return { status: "malformed", value: selection.value };
  const value = catalog.entries?.find((entry) => entry.id === selection.id);
  if (value) return { status: "resolved", value };
  if (catalog.status !== "ready") return { status: catalog.status, id: selection.id };
  return { status: "unavailable", id: selection.id };
}

/** The Work an address names: a Work page's own, else its `?work=`. */
export function addressWorkSelection(address: ProjectAddress): AddressSelection {
  const d = address.destination;
  return d.kind === "work" ? { kind: "id", id: d.workId } : address.work;
}

/** Repair an editing-context `?work=` only; a resource's Work is its identity and never falls back. */
export function guardProjectQuerySelections(
  address: ProjectAddress,
  catalogs: {
    work: AddressCatalog<{ id: string }>;
  },
): ProjectAddress {
  if (workIsIdentity(address.destination)) return address;
  const resolution = resolveAddressSelection(address.work, catalogs.work);
  if (resolution.status === "malformed" || resolution.status === "unavailable") {
    return { ...address, work: { kind: "none" } };
  }
  return address;
}

/** Project content spells No Work as none; identity destinations retain the row id. */
export function workSelectionFor(
  destination: ProjectDestination,
  workId: string,
  noWorkId: string | null,
): Exclude<AddressSelection, { kind: "absent" }>;
export function workSelectionFor(
  destination: ProjectDestination,
  workId: string | undefined,
  noWorkId: string | null,
): AddressSelection;
export function workSelectionFor(
  destination: ProjectDestination,
  workId: string | undefined,
  noWorkId: string | null,
): AddressSelection {
  if (workId === undefined) return { kind: "absent" };
  if (
    (destination.kind === "editor" ||
      destination.kind === "document" ||
      destination.kind === "browse") &&
    !workIsIdentity(destination) &&
    workId === noWorkId
  )
    return { kind: "none" };
  return workIdSelection(workId);
}
