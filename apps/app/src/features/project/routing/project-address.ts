/**
 * Browser project addresses. After `/p/<projectId>` the first segment is the kind of main's item
 * (`chats`, `editor` or `trash`) and the rest names it: a chat by id, or `chats/recent`, the chat
 * lane's Recent chats page. The Work scope is not in the address; the
 * query holds the owner of a Scratch document, the draft the page shows (`item`, whose key names
 * the draft), whether Review changes is on and against what (`review`), the change in focus
 * there (`change`), and overlays. `review` is legal only with `item`, `change` only with `review`.
 */
import { validateContextEntryPath } from "@meridian/contracts/context-entry-validation";
import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";

export type ProjectDestination =
  | { kind: "new-chat" | "chat-recents" | "editor" }
  | { kind: "chat"; chatId: string }
  | { kind: "document"; scheme: ProjectContextTreeScheme; path: string }
  /** A document in Trash, by identity: it has no path while deleted. */
  | { kind: "trashed"; documentId: string };

export type ProjectAddress = {
  projectId: string;
  destination: ProjectDestination;
  /**
   * A Scratch document's owner (its identity). A project document has none: the scope does not
   * belong in a link.
   */
  owner?: ScratchOwnerKey;
  /** The draft the page shows: `${draftId}:${documentId}`, so it names its draft. No review. */
  itemKey?: string;
  /** Review changes is on, against this: `live`, a draft id, or `file:<documentId>`. */
  review?: ReviewTarget;
  /** The change in focus in Review changes: the id of one of its members. */
  changeId?: string;
  settings?: SettingsSection;
};
export type ParsedProjectAddress =
  | { kind: "valid"; address: ProjectAddress; href: string }
  | { kind: "invalid"; reason: string };
const RECOGNIZED_QUERY = new Set(["owner", "item", "review", "change", "settings"]);

/** What Review changes compares the draft against. */
export type ReviewTarget = "live" | `file:${string}` | (string & {});

/** The reference a review target names. */
export function parseReviewTarget(
  target: ReviewTarget,
): { kind: "live" } | { kind: "draft"; draftId: string } | { kind: "file"; documentId: string } {
  if (target === "live") return { kind: "live" };
  if (target.startsWith("file:")) return { kind: "file", documentId: target.slice(5) };
  return { kind: "draft", draftId: target };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string | undefined): string | null {
  const normalized = value?.toLowerCase();
  return normalized && UUID.test(normalized) ? normalized : null;
}

/** Who owns a Scratch document, as its address spells it: `work:<id>` or `lineage:<rootThreadId>`. */
export type ScratchOwnerKey = `work:${string}` | `lineage:${string}`;

/** The owner key a Scratch document's address carries: its Work, or the chat lineage of a No Work chat. */
export function scratchOwnerKey(target: {
  workId: string;
  rootThreadId?: string;
}): ScratchOwnerKey {
  return target.rootThreadId ? `lineage:${target.rootThreadId}` : `work:${target.workId}`;
}

function parseScratchOwner(key: string): { kind: "work" | "lineage"; id: string } | null {
  const match = /^(work|lineage):([0-9a-f-]{36})$/i.exec(key);
  return match
    ? { kind: match[1] as "work" | "lineage", id: (match[2] as string).toLowerCase() }
    : null;
}

/** The chat lineage a Scratch document's address names as its owner. */
export function addressLineage(address: ProjectAddress): string | undefined {
  const owner = address.owner ? parseScratchOwner(address.owner) : null;
  return owner?.kind === "lineage" ? owner.id : undefined;
}

/** The Work a Scratch address names as its owner: the document's identity, whatever the scope. */
export function addressScratchWorkId(address: ProjectAddress): string | undefined {
  const owner = address.owner ? parseScratchOwner(address.owner) : null;
  return address.destination.kind === "document" &&
    address.destination.scheme === "scratch" &&
    owner?.kind === "work"
    ? owner.id
    : undefined;
}

/** The address with Review changes off: the plain draft page it was on. */
export function withoutReview(address: ProjectAddress): ProjectAddress {
  return { ...address, review: undefined, changeId: undefined };
}

/** The address with its draft dropped: the page's Live address. */
export function withoutDraft(address: ProjectAddress): ProjectAddress {
  return { ...address, itemKey: undefined, review: undefined, changeId: undefined };
}

/** The path names the kind of main's item, then which one. */
function parseDestination(parts: string[]): ProjectDestination | null {
  const [screen, ...rest] = parts;
  if (screen === undefined) return { kind: "new-chat" };
  if (screen === "chats") {
    if (rest.length === 0) return { kind: "new-chat" };
    if (rest.length === 1 && rest[0] === "recent") return { kind: "chat-recents" };
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
  const destination = parseDestination(parts.slice(2));
  if (!destination) return { kind: "invalid", reason: "destination" };
  const query = new URLSearchParams(rawSearch);
  for (const key of RECOGNIZED_QUERY) {
    if (query.getAll(key).length > 1) return { kind: "invalid", reason: `duplicate:${key}` };
  }
  const document = destination.kind === "document";
  const itemKey = document ? query.get("item") || undefined : undefined;
  const review = itemKey ? query.get("review") || undefined : undefined;
  const changeId = review ? query.get("change") || undefined : undefined;
  const ownerParam = query.get("owner");
  const parsedOwner = ownerParam === null ? null : parseScratchOwner(ownerParam);
  // The owner is part of the address only where the path alone does not name the resource:
  // Scratch. Anywhere else a stray one is dropped from the canonical href.
  const needsOwner = document && destination.scheme === "scratch";
  if (needsOwner && !parsedOwner) return { kind: "invalid", reason: "owner" };
  const owner: ScratchOwnerKey | undefined =
    needsOwner && parsedOwner ? `${parsedOwner.kind}:${parsedOwner.id}` : undefined;
  const settings = query.get("settings");
  const address: ProjectAddress = {
    projectId,
    destination,
    ...(owner ? { owner } : {}),
    ...(itemKey ? { itemKey } : {}),
    ...(review ? { review } : {}),
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
    case "chat-recents":
      push("chats", "recent");
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
      if (address.review) {
        query.set("review", address.review);
        if (address.changeId) query.set("change", address.changeId);
      }
    }
  }
  if (address.settings) query.set("settings", address.settings);
  const search = query.toString();
  const path = parts.join("/");
  return `/${path}${search ? `?${search}` : ""}`;
}
