/**
 * Browser project addresses. After `/p/<projectId>` the first segment is the kind of main's item
 * (`chats`, `editor` or `trash`) and the rest names it. The Work scope is not in the address; the
 * query holds the owner of a Scratch document or of a draft, and overlays.
 */
import {
  type DraftOwnerKey,
  draftOwnerKey,
  parseDraftOwnerKey,
} from "@meridian/contracts/branches";
import { validateContextEntryPath } from "@meridian/contracts/context-entry-validation";
import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";

export type ProjectDestination =
  | { kind: "new-chat" | "editor" }
  | { kind: "chat"; chatId: string }
  | { kind: "document"; scheme: ProjectContextTreeScheme; path: string }
  /** A document in Trash, by identity: it has no path while deleted. */
  | { kind: "trashed"; documentId: string };

export type ProjectAddress = {
  projectId: string;
  destination: ProjectDestination;
  /**
   * Who owns what the address names: a Scratch document's owner (its identity), and the owner of
   * the draft `itemKey` selects. A plain project document has none: the scope does not belong in a link.
   */
  owner?: DraftOwnerKey;
  /** Pending draft projected by the current manuscript Editor address. */
  itemKey?: string;
  /** Stable selected closure class within the addressed review. */
  changeId?: string;
  settings?: SettingsSection;
};
export type ParsedProjectAddress =
  | { kind: "valid"; address: ProjectAddress; href: string }
  | { kind: "invalid"; reason: string };
const RECOGNIZED_QUERY = new Set(["owner", "item", "change", "settings", "trash"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string | undefined): string | null {
  const normalized = value?.toLowerCase();
  return normalized && UUID.test(normalized) ? normalized : null;
}

/** The owner key a Scratch document's address carries: its Work, or the chat lineage of a No Work chat. */
export function scratchOwnerKey(target: { workId: string; rootThreadId?: string }): DraftOwnerKey {
  return target.rootThreadId
    ? draftOwnerKey({ kind: "lineage", rootThreadId: target.rootThreadId })
    : draftOwnerKey({ kind: "work", workId: target.workId });
}

/** The chat lineage the address's owner names, for a Scratch document or a lineage's draft. */
export function addressLineage(address: ProjectAddress): string | undefined {
  const owner = address.owner ? parseDraftOwnerKey(address.owner) : null;
  return owner?.kind === "lineage" ? owner.id : undefined;
}

/** The Work a Scratch address names as its owner: the document's identity, whatever the scope. */
export function addressScratchWorkId(address: ProjectAddress): string | undefined {
  const owner = address.owner ? parseDraftOwnerKey(address.owner) : null;
  return address.destination.kind === "document" &&
    address.destination.scheme === "scratch" &&
    owner?.kind === "work"
    ? owner.id
    : undefined;
}

/** The address with its review dropped: a draft's owner leaves with it, a Scratch document's does not. */
export function withoutReview(address: ProjectAddress): ProjectAddress {
  const scratch =
    address.destination.kind === "document" && address.destination.scheme === "scratch";
  return {
    ...address,
    itemKey: undefined,
    changeId: undefined,
    owner: scratch ? address.owner : undefined,
  };
}

/** The path names the kind of main's item, then which one. */
function parseDestination(parts: string[]): ProjectDestination | null {
  const [screen, ...rest] = parts;
  if (screen === undefined) return { kind: "new-chat" };
  if (screen === "chats") {
    if (rest.length === 0) return { kind: "new-chat" };
    const chatId = rest.length === 1 ? uuid(rest[0]) : null;
    return chatId ? { kind: "chat", chatId } : null;
  }
  if (screen === "trash") {
    const documentId = rest.length === 1 ? uuid(rest[0]) : null;
    return documentId ? { kind: "trashed", documentId } : null;
  }
  if (screen !== "editor") return null;
  if (rest.length === 0) return { kind: "editor" };
  const [scheme, ...segments] = rest;
  if (!isProjectContextTreeScheme(scheme)) return null;
  const path = segments.join("/");
  const validated = validateContextEntryPath(path, { allowRoot: false });
  // Browser addresses must not silently trim a different filename into existence.
  if (!validated.ok || validated.value !== path) return null;
  return { kind: "document", scheme, path };
}

/** Called with the router's original search string, before its default parser collapses duplicates. */
export function parseProjectAddress(pathname: string, rawSearch = ""): ParsedProjectAddress {
  let parts: string[];
  try {
    if (!pathname.startsWith("/") || /%2f|%5c/i.test(pathname) || pathname.includes("\\"))
      return { kind: "invalid", reason: "separator" };
    const canonicalPath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    parts = canonicalPath.slice(1).split("/").map(decodeURIComponent);
    // URLSearchParams otherwise silently repairs malformed percent escapes and UTF-8.
    for (const part of rawSearch.replace(/^\?/, "").split(/[&=]/))
      decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return { kind: "invalid", reason: "encoding" };
  }
  const projectId = uuid(parts[1]);
  if (parts[0] !== "p" || !projectId || parts.some((part) => !part))
    return { kind: "invalid", reason: "path" };
  const parsedDestination = parseDestination(parts.slice(2));
  if (!parsedDestination) return { kind: "invalid", reason: "destination" };
  const query = new URLSearchParams(rawSearch);
  for (const key of RECOGNIZED_QUERY) {
    if (query.getAll(key).length > 1) return { kind: "invalid", reason: `duplicate:${key}` };
  }
  // The Trash popup's links (`?trash=<id>` over any page) land on that document in main.
  const legacyTrash = uuid(query.get("trash") ?? undefined);
  const destination: ProjectDestination = legacyTrash
    ? { kind: "trashed", documentId: legacyTrash }
    : parsedDestination;
  const document = destination.kind === "document";
  const itemKey = document ? query.get("item") || undefined : undefined;
  const changeId = itemKey ? query.get("change") || undefined : undefined;
  const ownerParam = query.get("owner");
  const parsedOwner = ownerParam === null ? null : parseDraftOwnerKey(ownerParam);
  if (ownerParam !== null && !parsedOwner) return { kind: "invalid", reason: "owner" };
  // The owner is part of the address only where the path alone does not name the resource: Scratch,
  // and a draft item. Anywhere else a stray one is dropped from the canonical href.
  const needsOwner = document && (destination.scheme === "scratch" || itemKey !== undefined);
  if (needsOwner && !parsedOwner) return { kind: "invalid", reason: "owner" };
  const owner =
    needsOwner && parsedOwner
      ? draftOwnerKey(
          parsedOwner.kind === "work"
            ? { kind: "work", workId: parsedOwner.id.toLowerCase() }
            : { kind: "lineage", rootThreadId: parsedOwner.id.toLowerCase() },
        )
      : undefined;
  const settings = query.get("settings");
  const address: ProjectAddress = {
    projectId,
    destination,
    ...(owner ? { owner } : {}),
    ...(itemKey ? { itemKey } : {}),
    ...(changeId ? { changeId } : {}),
    ...(isSettingsSection(settings) ? { settings } : {}),
  };
  return { kind: "valid", address, href: projectAddressHref(address) };
}

export function projectAddressHref(address: ProjectAddress): string {
  const parts = ["p", address.projectId].map(encodeURIComponent);
  const push = (...segments: string[]) => parts.push(...segments.map(encodeURIComponent));
  const d = address.destination;
  switch (d.kind) {
    case "new-chat":
      push("chats");
      break;
    case "chat":
      push("chats", d.chatId);
      break;
    case "editor":
      push("editor");
      break;
    case "document":
      push("editor", d.scheme, ...(d.path ? d.path.split("/") : []));
      break;
    case "trashed":
      push("trash", d.documentId);
      break;
  }
  const query = new URLSearchParams();
  if (d.kind === "document") {
    if (address.owner) query.set("owner", address.owner);
    if (address.itemKey) {
      query.set("item", address.itemKey);
      if (address.changeId) query.set("change", address.changeId);
    }
  }
  if (address.settings) query.set("settings", address.settings);
  const search = query.toString();
  const path = parts.join("/");
  return `/${path}${search ? `?${search}` : ""}`;
}
