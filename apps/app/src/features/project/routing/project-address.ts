/** Readable browser grammar. Internal project, Work, chat, and document identities remain IDs. */
import { validateContextEntryPath } from "@meridian/contracts/context-entry-validation";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";

export type AddressSelection =
  | { kind: "absent" }
  | { kind: "none" }
  | { kind: "slug"; slug: string }
  | { kind: "malformed"; value: string };

export type ProjectDestination =
  | { kind: "home" | "chats" | "new-chat" | "works" | "editor" }
  | { kind: "chat"; chatSlug: string }
  | { kind: "work"; workSlug: string }
  | {
      kind: "browse";
      scheme: ProjectContextTreeScheme | null;
      path: string;
      workSlug: string | null;
    }
  | { kind: "document"; scheme: ProjectContextTreeScheme; path: string; workSlug: string | null };

export type ProjectAddress = {
  projectSlug: string;
  destination: ProjectDestination;
  chat: AddressSelection;
  work: AddressSelection;
  settings?: SettingsSection;
  results: boolean;
};
export type ParsedProjectAddress =
  | { kind: "valid"; address: ProjectAddress; href: string }
  | { kind: "invalid"; reason: string };
const ABSENT: AddressSelection = { kind: "absent" };
const RECOGNIZED_QUERY = new Set(["chat", "work", "settings", "results"]);
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function handle(value: string | undefined): string | null {
  const normalized = value?.toLowerCase();
  return normalized && HANDLE.test(normalized) ? normalized : null;
}

function selection(value: string | null): AddressSelection {
  if (value === null) return ABSENT;
  if (value === "") return { kind: "none" };
  const slug = handle(value);
  return slug ? { kind: "slug", slug } : { kind: "malformed", value };
}

function parseDestination(parts: string[]): ProjectDestination | null {
  if (parts.length === 0) return { kind: "home" };
  if (parts.length === 1) {
    if (parts[0] === "chats" || parts[0] === "works" || parts[0] === "editor")
      return { kind: parts[0] };
    if (parts[0] === "browse") return { kind: "browse", scheme: null, path: "", workSlug: null };
  }
  if (parts.length === 2 && parts[0] === "chats" && parts[1] === "new") return { kind: "new-chat" };
  if (parts.length === 2 && parts[0] === "chat") {
    const slug = handle(parts[1]);
    return slug ? { kind: "chat", chatSlug: slug } : null;
  }
  let workSlug: string | null = null;
  if (parts[0] === "work") {
    workSlug = handle(parts[1]);
    if (!workSlug) return null;
    if (parts.length === 2) return { kind: "work", workSlug };
    parts = parts.slice(2);
  }
  const browse = parts[0] === "browse";
  if (browse) parts = parts.slice(1);
  const scheme = parts[0];
  if (!isProjectContextTreeScheme(scheme)) return null;
  if (workSlug && !isWorkScopedProjectContextScheme(scheme)) return null;
  const path = parts.slice(1).join("/");
  const validated = validateContextEntryPath(path, { allowRoot: browse });
  // Browser addresses must not silently trim a different filename into existence.
  if (!validated.ok || validated.value !== path) return null;
  return { kind: browse ? "browse" : "document", scheme, workSlug, path };
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
  const projectSlug = handle(parts[1]);
  if (parts[0] !== "p" || !projectSlug || parts.some((part) => !part))
    return { kind: "invalid", reason: "path" };
  const destination = parseDestination(parts.slice(2));
  if (!destination) return { kind: "invalid", reason: "destination" };
  const query = new URLSearchParams(rawSearch);
  for (const key of RECOGNIZED_QUERY) {
    if (query.getAll(key).length > 1) return { kind: "invalid", reason: `duplicate:${key}` };
  }
  const editor =
    destination.kind === "document" ||
    destination.kind === "browse" ||
    destination.kind === "editor";
  let work = editor ? selection(query.get("work")) : ABSENT;
  if (
    (destination.kind === "document" || destination.kind === "browse") &&
    destination.scheme &&
    isWorkScopedProjectContextScheme(destination.scheme)
  ) {
    if (
      work.kind !== "absent" &&
      !(
        (work.kind === "none" && destination.workSlug === null) ||
        (work.kind === "slug" && work.slug === destination.workSlug)
      )
    )
      return { kind: "invalid", reason: "conflicting-work" };
    work = ABSENT;
  }
  const settings = query.get("settings");
  const address: ProjectAddress = {
    projectSlug,
    destination,
    chat:
      destination.kind === "chat" || destination.kind === "chats" || destination.kind === "new-chat"
        ? ABSENT
        : selection(query.get("chat")),
    work,
    ...(isSettingsSection(settings) ? { settings } : {}),
    results: (editor || destination.kind === "chat") && query.has("results"),
  };
  return { kind: "valid", address, href: projectAddressHref(address) };
}

function writeSelection(query: URLSearchParams, key: string, value: AddressSelection): void {
  if (value.kind === "none") query.set(key, "");
  else if (value.kind === "slug") query.set(key, value.slug);
  else if (value.kind === "malformed") query.set(key, value.value);
}

export function projectAddressHref(address: ProjectAddress): string {
  const parts = ["p", address.projectSlug];
  const d = address.destination;
  switch (d.kind) {
    case "home":
      break;
    case "chat":
      parts.push("chat", d.chatSlug);
      break;
    case "work":
      parts.push("work", d.workSlug);
      break;
    case "new-chat":
      parts.push("chats", "new");
      break;
    case "chats":
    case "works":
    case "editor":
      parts.push(d.kind);
      break;
    case "browse":
    case "document":
      if (d.workSlug) parts.push("work", d.workSlug);
      if (d.kind === "browse") parts.push("browse");
      if (d.scheme) parts.push(d.scheme);
      if (d.path) parts.push(...d.path.split("/"));
      break;
  }
  const query = new URLSearchParams();
  if (d.kind !== "chat" && d.kind !== "chats" && d.kind !== "new-chat")
    writeSelection(query, "chat", address.chat);
  const context = d.kind === "editor" || d.kind === "document" || d.kind === "browse";
  const pathOwnsWork =
    (d.kind === "document" || d.kind === "browse") &&
    d.scheme !== null &&
    isWorkScopedProjectContextScheme(d.scheme);
  if (context && !pathOwnsWork) writeSelection(query, "work", address.work);
  if ((context || d.kind === "chat") && address.results) query.set("results", "");
  if (address.settings) query.set("settings", address.settings);
  const search = query.toString();
  return `/${parts.map(encodeURIComponent).join("/")}${search ? `?${search}` : ""}`;
}
