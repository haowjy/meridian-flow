/** Resolves readable selections against an authorized project catalog without inventing IDs. */
import type { AddressSelection, ProjectAddress } from "./project-address";

export type AddressCatalog<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; entries: readonly T[] };
export type AddressResolution<T> =
  | { status: "absent" | "none" }
  | { status: "malformed"; value: string }
  | { status: "loading" | "error" | "unavailable"; slug: string }
  | { status: "resolved"; value: T };

export function resolveAddressSelection<T extends { slug: string | null }>(
  selection: AddressSelection,
  catalog: AddressCatalog<T>,
): AddressResolution<T> {
  if (selection.kind === "absent" || selection.kind === "none") return { status: selection.kind };
  if (selection.kind === "malformed") return { status: "malformed", value: selection.value };
  if (catalog.status !== "ready") return { status: catalog.status, slug: selection.slug };
  const value = catalog.entries.find((entry) => entry.slug === selection.slug);
  return value ? { status: "resolved", value } : { status: "unavailable", slug: selection.slug };
}

/** Work-owned paths pin authority, including explicitly unassigned Scratch and Uploads. */
export function addressWorkSelection(address: ProjectAddress): AddressSelection {
  const d = address.destination;
  if (d.kind === "work") return { kind: "slug", slug: d.workSlug };
  if (
    (d.kind === "document" || d.kind === "browse") &&
    (d.scheme === "scratch" || d.scheme === "uploads")
  ) {
    return d.workSlug ? { kind: "slug", slug: d.workSlug } : { kind: "none" };
  }
  return address.work;
}

export function addressChatSelection(address: ProjectAddress): AddressSelection {
  const d = address.destination;
  if (d.kind === "chat") return { kind: "slug", slug: d.chatSlug };
  if (d.kind === "chats") return { kind: "none" };
  return address.chat;
}
