/** Resolves address selections against an authorized project catalog without inventing IDs. */
import type { AddressSelection, ProjectAddress } from "./project-address";

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

/** Work-owned paths pin authority, including explicitly unassigned Scratch and Uploads. */
export function addressWorkSelection(address: ProjectAddress): AddressSelection {
  const d = address.destination;
  if (d.kind === "work") return { kind: "id", id: d.workId };
  if (
    (d.kind === "document" || d.kind === "browse") &&
    (d.scheme === "scratch" || d.scheme === "uploads")
  ) {
    return d.workId ? { kind: "id", id: d.workId } : { kind: "none" };
  }
  return address.work;
}

/** Repair optional query selectors only; path identities must never fall back. */
export function guardProjectQuerySelections(
  address: ProjectAddress,
  catalogs: {
    work: AddressCatalog<{ id: string }>;
  },
): ProjectAddress {
  const resolution = resolveAddressSelection(address.work, catalogs.work);
  if (resolution.status === "malformed" || resolution.status === "unavailable") {
    return { ...address, work: { kind: "none" } };
  }
  return address;
}
