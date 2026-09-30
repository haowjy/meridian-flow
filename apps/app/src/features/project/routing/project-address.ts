/**
 * Browser project addresses. After `/p/<projectId>` the path names the screen and what
 * is open on it; the query holds context and overlays.
 */
import { validateContextEntryPath } from "@meridian/contracts/context-entry-validation";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type WorkAuthorityScheme,
} from "@meridian/contracts/protocol";
import { type ParsedRequestId, parseRequestId } from "@meridian/contracts/request-id";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";

export type AddressSelection =
  | { kind: "absent" }
  | { kind: "none" }
  | { kind: "id"; id: ParsedRequestId }
  | { kind: "malformed"; value: string };

export type ProjectDestination =
  | { kind: "chat-index" | "works" | "works-new" | "editor" }
  | { kind: "chat"; chatId: string }
  | { kind: "work"; workId: ParsedRequestId }
  | { kind: "browse"; scheme: ProjectContextTreeScheme | null; path: string }
  | { kind: "document"; scheme: ProjectContextTreeScheme; path: string };

export type ProjectAddress = {
  projectId: string;
  destination: ProjectDestination;
  /**
   * The Editor's Work. For Scratch and Uploads it is the resource's identity:
   * `none` is No Work and `absent` is not an address.
   */
  work: AddressSelection;
  /** Work detail's chats view is the default and is omitted from the address. */
  workView?: "files";
  /** The Work list's Active tab is the default and is omitted from the address. */
  worksView?: "archived" | "deleted";
  settings?: SettingsSection;
  results: boolean;
};
export type WorkView = "chats" | "files";
export type WorksView = "active" | "archived" | "deleted";
export type ParsedProjectAddress =
  | { kind: "valid"; address: ProjectAddress; href: string }
  | { kind: "invalid"; reason: string };
const ABSENT: AddressSelection = { kind: "absent" };
const RECOGNIZED_QUERY = new Set(["work", "settings", "results", "view"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string | undefined): string | null {
  const normalized = value?.toLowerCase();
  return normalized && UUID.test(normalized) ? normalized : null;
}

/** A nullable Work id as a selection: no id selects no Work. */
export function workIdSelection(workId: string | null): AddressSelection {
  if (workId === null) return { kind: "none" };
  const id = parseRequestId(workId);
  return id ? { kind: "id", id } : { kind: "malformed", value: workId };
}

/** The `?work=` query value: absent, empty for no Work, or a Work id. */
function selection(value: string | null): AddressSelection {
  return value === null ? ABSENT : workIdSelection(value || null);
}

/** Scratch and Uploads belong to a Work; every other scheme is the project's. */
export function isWorkScopedScheme(
  scheme: ProjectContextTreeScheme | null,
): scheme is WorkAuthorityScheme {
  return scheme !== null && isWorkScopedProjectContextScheme(scheme);
}

/** Whether `?work=` names the resource itself rather than an editing context. */
export function workIsIdentity(destination: ProjectDestination): boolean {
  return (
    (destination.kind === "document" || destination.kind === "browse") &&
    isWorkScopedScheme(destination.scheme)
  );
}

/** A folder to browse; its Work, if any, is the address's `work`. */
export function browseDestination(
  scheme: ProjectContextTreeScheme | null,
  path: string,
): ProjectDestination {
  return { kind: "browse", scheme, path: path.replace(/^\/+/, "") };
}

/** The path names the screen, then what is open on it. */
function parseDestination(parts: string[]): ProjectDestination | null {
  const [screen, ...rest] = parts;
  if (screen === undefined) return { kind: "chat-index" };
  if (screen === "chats") {
    if (rest.length === 0) return { kind: "chat-index" };
    const chatId = rest.length === 1 ? uuid(rest[0]) : null;
    return chatId ? { kind: "chat", chatId } : null;
  }
  if (screen === "works") {
    if (rest.length === 0) return { kind: "works" };
    if (rest.length !== 1) return null;
    if (rest[0] === "new") return { kind: "works-new" };
    const workId = parseRequestId(rest[0]);
    return workId ? { kind: "work", workId } : null;
  }
  if (screen !== "editor") return null;
  if (rest.length === 0) return { kind: "editor" };
  const browse = rest[0] === "browse";
  const [scheme, ...segments] = browse ? rest.slice(1) : rest;
  if (browse && scheme === undefined) return { kind: "browse", scheme: null, path: "" };
  if (!isProjectContextTreeScheme(scheme)) return null;
  const path = segments.join("/");
  const validated = validateContextEntryPath(path, { allowRoot: browse });
  // Browser addresses must not silently trim a different filename into existence.
  if (!validated.ok || validated.value !== path) return null;
  return { kind: browse ? "browse" : "document", scheme, path };
}

/** Called with the router's original search string, before its default parser collapses duplicates. */
export function parseProjectAddress(
  pathname: string,
  rawSearch = "",
  state: object = {},
): ParsedProjectAddress {
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
  const editor =
    destination.kind === "document" ||
    destination.kind === "browse" ||
    destination.kind === "editor";
  const work = editor ? selection(query.get("work")) : ABSENT;
  if (workIsIdentity(destination) && work.kind !== "id" && work.kind !== "none")
    return { kind: "invalid", reason: "work" };
  const settings = query.get("settings");
  const workView =
    destination.kind === "work" && query.get("view") === "files" ? "files" : undefined;
  const view = query.get("view");
  const worksView =
    destination.kind === "works" && (view === "archived" || view === "deleted") ? view : undefined;
  const address: ProjectAddress = {
    projectId,
    destination,
    work,
    ...(workView ? { workView } : {}),
    ...(worksView ? { worksView } : {}),
    ...(isSettingsSection(settings) ? { settings } : {}),
    results: (editor || destination.kind === "chat") && query.has("results"),
  };
  const href = projectAddressHref(address);
  const empty =
    "meridianProjectEmptySelection" in state ? state.meridianProjectEmptySelection : undefined;
  // History can pin no selection without leaking empty selectors into copied addresses.
  // A marker copied by unrelated navigation must never affect another address.
  if (
    empty &&
    typeof empty === "object" &&
    "href" in empty &&
    empty.href === projectAddressHref({ ...address, settings: undefined, results: false })
  ) {
    if (editor && address.work.kind === "absent") address.work = { kind: "none" };
  }
  return { kind: "valid", address, href };
}

function writeWork(query: URLSearchParams, address: ProjectAddress): void {
  const work = address.work;
  if (work.kind === "id") query.set("work", work.id);
  else if (work.kind === "malformed") query.set("work", work.value);
  // An Editor context of no Work is pinned by history state; a resource of No Work is `?work=`.
  else if (work.kind === "none" && workIsIdentity(address.destination)) query.set("work", "");
}

export function projectAddressHref(address: ProjectAddress): string {
  const parts = ["p", address.projectId].map(encodeURIComponent);
  const push = (...segments: string[]) => parts.push(...segments.map(encodeURIComponent));
  const d = address.destination;
  switch (d.kind) {
    case "chat-index":
      push("chats");
      break;
    case "chat":
      push("chats", d.chatId);
      break;
    case "work":
      push("works", d.workId);
      break;
    case "works":
    case "editor":
      push(d.kind);
      break;
    case "works-new":
      push("works", "new");
      break;
    case "browse":
    case "document":
      push("editor");
      if (d.kind === "browse") push("browse");
      if (d.scheme) push(d.scheme);
      if (d.path) push(...d.path.split("/"));
      break;
  }
  const query = new URLSearchParams();
  const context = d.kind === "editor" || d.kind === "document" || d.kind === "browse";
  if (context) writeWork(query, address);
  if ((context || d.kind === "chat") && address.results) query.set("results", "");
  if (d.kind === "work" && address.workView === "files") query.set("view", "files");
  if (d.kind === "works" && address.worksView) query.set("view", address.worksView);
  if (address.settings) query.set("settings", address.settings);
  const search = query.toString();
  const path = parts.join("/");
  return `/${path}${search ? `?${search}` : ""}`;
}

/** Entry-local no-selection intent; actual selections remain in the public address. */
export function projectAddressState(
  address: ProjectAddress,
  state: Record<string, unknown> = {},
): Record<string, unknown> {
  const destination = address.destination.kind;
  // Non-Editor destinations do not read an Editor Work selection back from history.
  const noWork =
    (destination === "editor" || destination === "document" || destination === "browse") &&
    address.work.kind === "none";
  return {
    ...state,
    meridianProjectEmptySelection: noWork
      ? { href: projectAddressHref({ ...address, settings: undefined, results: false }) }
      : undefined,
  };
}
