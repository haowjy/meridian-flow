/** Hierarchical, renderer-neutral reference browser composed with the suggestion lifecycle. */

import type { WorkHandle } from "@meridian/contracts";
import { matchDocumentPath } from "@meridian/contracts";
import {
  type ContextUriScheme,
  ownerSegment,
  type ParsedContextUri,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import { parseDocumentFilename, renderFilename } from "@meridian/contracts/protocol";
import type { TreeDirectory, TreeFile } from "@/core/project-tree/tree-view";
import {
  folderReferenceForEntry,
  locationOf,
  normalizeReferenceName,
  type ReferenceKind,
  type ReferenceNavigationAction,
  type ReferenceRankingPriors,
  type ReferenceRow,
  type ReferenceSourceView,
  type ReferenceTerminalRow,
  rankReferenceRows,
  referenceRowForFile,
  referenceRowForFolder,
  referenceUriForAuthority,
} from "./reference-policy";
import {
  createSuggestionDriverCore,
  type SuggestionDriver,
  type SuggestionTriggerRange,
} from "./suggestion-driver";
import type {
  InternalSuggestionGeneration,
  InternalSuggestionSession,
  SuggestionChoiceAction,
} from "./suggestion-menu-store";

/** What the browser reads: each source's tree by the source's id. */
export type ReferenceCatalogPort = {
  subscribe: (listener: () => void) => () => void;
  /**
   * `loading` while the source's list has not synced; `error` when the account has no access. An
   * id no source has answers for the lists as a whole.
   */
  status: (sourceId: string) => "loading" | "ready" | "error";
  /** The source's tree as the list holds it now; null where the source is not known. */
  read: (sourceId: string) => ReferenceSourceView | null;
};

/** A Work whose Scratch the browser can open into: listed beside the sources, by name and handle. */
export type ReferenceWork = { sourceId: string; name: string; handle: WorkHandle };

export type ReferenceBrowserMeta = {
  kind: "root" | "drilled";
  generation: number;
  triggerRange: { from: number; to: number };
  completedPrefix: string;
  incomplete: boolean;
  loadFailed: boolean;
  containerLabel: string | null;
  containerScheme: ContextUriScheme | null;
  canBacktrack: boolean;
};

/**
 * A host's row beside the tree rows: a link to a document nobody has
 * written yet, at an address the host computed. Only a host that can hold
 * such a link (the Editor) offers one; identity-bearing references never do.
 */
export type LinkAheadRow = {
  kind: "link-ahead";
  rowId: "link-ahead";
  /** The name as typed: the inserted link's text. */
  label: string;
  /** The canonical Context URI the link will address. */
  uri: string;
};

/** What the browser's menu lists: tree rows, then at most one link-ahead row. */
export type ReferenceMenuRow = ReferenceRow | LinkAheadRow;

export type ReferenceBrowserState =
  | { kind: "closed" }
  | (ReferenceBrowserMeta & {
      kind: "root";
      query: string;
      warmSources: readonly string[];
      rows: readonly ReferenceMenuRow[];
    })
  | (ReferenceBrowserMeta & {
      kind: "drilled";
      query: string;
      activeSource: string;
      containerId?: string;
      rows: readonly ReferenceMenuRow[];
    });

export type ReferenceBrowserOpenContext = Readonly<{
  /** The sources listed at the top, by id. */
  warmSources: readonly string[];
  works: readonly ReferenceWork[];
  referenceKinds?: readonly ReferenceKind[];
}>;
export type ReferenceBrowserController = SuggestionDriver<
  never,
  ReferenceMenuRow,
  ReferenceBrowserMeta
> & {
  refresh: () => boolean;
  state: () => ReferenceBrowserState;
};
export type ReferenceBrowserOptions = {
  catalog: ReferenceCatalogPort;
  openContext: () => ReferenceBrowserOpenContext | null;
  label: () => string;
  priors?: ReferenceRankingPriors;
  onSelect: (input: { row: ReferenceTerminalRow; triggerRange: SuggestionTriggerRange }) => void;
  onCompleteSegment: (input: { prefix: string; triggerRange: SuggestionTriggerRange }) => void;
  /**
   * Where a link to a not-yet-written document named `name` would point, or
   * null when the host offers none for it. Asked only for a root search that
   * names no existing document exactly.
   */
  linkAhead?: (name: string) => { uri: string } | null;
  onLinkAhead?: (input: { row: LinkAheadRow; triggerRange: SuggestionTriggerRange }) => void;
};

type RootLocation = {
  kind: "root";
  warmSources: readonly string[];
  works: readonly ReferenceWork[];
};

type DrilledLocation = {
  kind: "drilled";
  activeSource: string;
  containerId?: string;
  label?: string;
};

type Location = RootLocation | DrilledLocation;

/**
 * The sole browser state machine. It projects the sources' trees and publishes through the
 * suggestion lifecycle; it owns neither the trees nor host insertion/rendering.
 */
export function createReferenceBrowserController(
  options: ReferenceBrowserOptions,
): ReferenceBrowserController {
  const { menu, lifecycle } = createSuggestionDriverCore<ReferenceMenuRow, ReferenceBrowserMeta>();
  let identity: InternalSuggestionGeneration | null = null;
  let location: Location | null = null;
  let history: Location[] = [];
  let query = "";
  let triggerRange = { from: 0, to: 0 };
  let completedPrefix = "";
  let rows: readonly ReferenceMenuRow[] = [];
  let incomplete = false;
  let loadFailed = false;
  let queriedContainer: Extract<ReferenceRow, { kind: "source" | "folder" }> | null = null;
  let triggerPrefix = "";
  let settled = false;
  let awaitingSegmentEcho = false;
  let unsubscribe: (() => void) | null = null;
  let containerScheme: ContextUriScheme | null = null;
  let hasSearch = false;
  const explicitUri = () => {
    if (!query.includes("://")) return null;
    const parsed = parseContextUri(query.startsWith("@") ? query.slice(1) : query);
    return parsed.ok ? parsed.value : null;
  };
  let referenceKinds: readonly ReferenceKind[] | undefined;

  const meta = (): ReferenceBrowserMeta => ({
    kind: location?.kind === "drilled" ? "drilled" : "root",
    generation: identity?.generation ?? 0,
    triggerRange,
    completedPrefix,
    incomplete,
    loadFailed,
    containerLabel: hasSearch
      ? null
      : (queriedContainer?.label ??
        (location?.kind === "drilled" ? (location.label ?? null) : null)),
    containerScheme: hasSearch ? null : containerScheme,
    canBacktrack: explicitUri() !== null || location?.kind === "drilled",
  });

  const session = (): InternalSuggestionSession<ReferenceMenuRow, ReferenceBrowserMeta> => ({
    items: rows,
    keepOpenWhenEmpty: true,
    rowId: (row) => row.rowId,
    // A sentence after `@` that names no document must still end in a new
    // paragraph on Enter; the link-ahead row is reached by arrow or pointer.
    defaultActive: (row) => row.kind !== "link-ahead",
    query,
    anchorRect,
    label: options.label(),
    meta: meta(),
    choose: chooseRow,
    backtrack,
    dismiss,
  });

  const project = (): readonly ReferenceMenuRow[] => {
    if (!location) return [];
    const root = location.kind === "root" ? location : history[0];
    const rootLocation = root?.kind === "root" ? root : null;
    const sourceIds = rootLocation ? [...rootLocation.warmSources] : [];
    const works = rootLocation?.works ?? [];
    if (location.kind === "drilled" && !sourceIds.includes(location.activeSource))
      sourceIds.push(location.activeSource);
    const allRows = query.includes("://")
      ? rootRows(sourceIds, works, options.catalog, referenceKinds, true)
      : [];
    const typedQuery = query.startsWith("@") ? query.slice(1) : query;
    queriedContainer =
      allRows
        .filter(
          (row): row is Extract<ReferenceRow, { kind: "source" | "folder" }> =>
            (row.kind === "source" || row.kind === "folder") &&
            typedQuery.startsWith(row.action.prefix),
        )
        .sort((a, b) => b.action.prefix.length - a.action.prefix.length)[0] ?? null;
    const parsed = explicitUri();
    containerScheme = parsed?.path === "" ? parsed.scheme : null;
    const namespaceSource = parsed
      ? namespaceSourceOf(parsed, sourceIds, works, options.catalog)
      : undefined;
    const targetSource =
      queriedContainer?.action.sourceId ??
      namespaceSource ??
      (location.kind === "drilled" ? location.activeSource : undefined);
    if (targetSource) {
      incomplete = options.catalog.status(targetSource) === "loading";
      loadFailed = options.catalog.status(targetSource) === "error" || loadFailed;
      if (loadFailed) incomplete = false;
    } else {
      incomplete = sourceIds.some((id) => options.catalog.status(id) === "loading");
      loadFailed = sourceIds.some((id) => options.catalog.status(id) === "error");
    }
    const candidates = queriedContainer
      ? drilledRows(
          {
            kind: "drilled",
            activeSource: queriedContainer.action.sourceId,
            containerId: queriedContainer.action.containerId,
          },
          options.catalog,
          referenceKinds,
        )
      : namespaceSource
        ? []
        : location.kind === "root"
          ? rootRows(location.warmSources, location.works, options.catalog, referenceKinds)
          : drilledRows(location, options.catalog, referenceKinds);
    const search = queriedContainer
      ? typedQuery.slice(queriedContainer.action.prefix.length)
      : query;
    hasSearch = search.length > 0 && !(parsed && parsed.path === "");
    const ranked = rankReferenceRows(candidates, search, {
      ...options.priors,
      kinds: referenceKinds,
    });
    const ahead =
      options.linkAhead && location.kind === "root" && !parsed && !queriedContainer
        ? linkAheadRow(search, ranked, options.linkAhead)
        : null;
    // A folder's own listing opens with the folder itself, for a host that takes folders.
    const listed = queriedContainer
      ? {
          sourceId: queriedContainer.action.sourceId,
          containerId: queriedContainer.action.containerId,
        }
      : location.kind === "drilled"
        ? { sourceId: location.activeSource, containerId: location.containerId }
        : null;
    const mention =
      listed && !hasSearch && foldersMentionable(referenceKinds)
        ? folderMentionRow(listed, options.catalog)
        : null;
    return [...(mention ? [mention] : []), ...ranked, ...(ahead ? [ahead] : [])];
  };

  const publish = (
    candidate: InternalSuggestionGeneration,
    selection: "reset" | "preserve-active",
  ): boolean => {
    rows = project();
    return lifecycle.update(candidate, session(), selection);
  };

  const advance = (): InternalSuggestionGeneration | null => {
    if (!identity) return null;
    identity = lifecycle.nextGeneration(identity.sessionId);
    return identity;
  };

  function navigate(action: ReferenceNavigationAction, label: string): void {
    if (!location || !identity) return;
    history.push(location);
    location = {
      kind: "drilled",
      activeSource: action.sourceId,
      label,
      ...(action.containerId ? { containerId: action.containerId } : {}),
    };
    query = "";
    loadFailed = false;
    const candidate = advance();
    if (candidate) publish(candidate, "reset");
  }

  function chooseRow(row: ReferenceMenuRow, action: SuggestionChoiceAction): void {
    if (row.kind === "link-ahead") {
      if (settled || !identity) return;
      settled = true;
      options.onLinkAhead?.({ row, triggerRange });
      requestExit?.();
      return;
    }
    if (row.kind !== "file" && row.kind !== "folder-mention") {
      navigate(row.action, row.label);
      if (action === "tab") {
        completedPrefix = row.action.prefix;
        awaitingSegmentEcho = true;
        options.onCompleteSegment({ prefix: row.action.prefix, triggerRange });
      }
      return;
    }
    if (settled || !identity) return;
    settled = true;
    options.onSelect({ row, triggerRange });
    requestExit?.();
  }

  function backtrack(): boolean {
    if (!identity || !location) return false;
    if (explicitUri()) {
      location = history.find((entry) => entry.kind === "root") ?? location;
      history = [];
      query = "";
      completedPrefix = "";
      loadFailed = false;
      const candidate = advance();
      if (candidate) publish(candidate, "reset");
      awaitingSegmentEcho = true;
      options.onCompleteSegment({ prefix: triggerPrefix, triggerRange });
      return true;
    }
    if (location.kind === "root") return false;
    const previous = history.pop();
    if (!previous) return false;
    location = previous;
    query = "";
    incomplete = false;
    loadFailed = false;
    const candidate = advance();
    if (!candidate) return false;
    publish(candidate, "reset");
    return true;
  }

  function dismiss(): void {
    if (!identity || settled) return;
    settled = true;
    requestExit?.();
  }

  let requestExit: (() => void) | null = null;
  let anchorRect: () => DOMRect | null = () => null;
  let lastText = "";
  return {
    menu,
    start(frame) {
      const context = options.openContext();
      if (!context) return frame.requestExit();
      unsubscribe?.();
      requestExit = frame.requestExit;
      anchorRect = frame.anchorRect;
      lastText = frame.text;
      triggerPrefix = frame.text.slice(0, frame.text.length - frame.query.length);
      loadFailed = false;
      location = { kind: "root", warmSources: context.warmSources, works: context.works };
      history = [];
      query = frame.query;
      triggerRange = frame.triggerRange;
      completedPrefix = "";
      referenceKinds = context.referenceKinds;
      settled = false;
      awaitingSegmentEcho = false;
      rows = project();
      identity = lifecycle.open(session());
      unsubscribe = options.catalog.subscribe(() => {
        if (!identity) return;
        loadFailed = false;
        publish(identity, "preserve-active");
      });
    },
    update(frame) {
      if (!identity) return;
      requestExit = frame.requestExit;
      anchorRect = frame.anchorRect;
      triggerRange = frame.triggerRange;
      if (frame.text === lastText) return;
      lastText = frame.text;
      if (awaitingSegmentEcho) {
        awaitingSegmentEcho = false;
        return;
      }
      query = frame.query;
      const candidate = advance();
      if (candidate) publish(candidate, "reset");
    },
    exit() {
      unsubscribe?.();
      unsubscribe = null;
      requestExit = null;
      const closing = identity;
      identity = null;
      location = null;
      history = [];
      rows = [];
      settled = true;
      awaitingSegmentEcho = false;
      if (closing) lifecycle.close(closing);
    },
    refresh() {
      if (!identity) return false;
      return publish(identity, "preserve-active");
    },
    state() {
      if (!location) return { kind: "closed" };
      const shared = { ...meta(), query, rows };
      return location.kind === "root"
        ? { ...shared, kind: "root", warmSources: location.warmSources }
        : {
            ...shared,
            kind: "drilled",
            activeSource: location.activeSource,
            ...(location.containerId ? { containerId: location.containerId } : {}),
          };
    },
  };
}

function rootRows(
  sourceIds: readonly string[],
  works: readonly ReferenceWork[],
  catalog: ReferenceCatalogPort,
  kinds?: readonly ReferenceKind[],
  includeEmpty = false,
): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  for (const sourceId of sourceIds) {
    const view = catalog.read(sourceId);
    if (!view) continue;
    const populated = includeEmpty ? null : populatedContainers(view, catalog, kinds);
    const sourceRow = rowForSource(view);
    if (sourceRow && (!populated || populated.has(view.tree.root.entryId))) rows.push(sourceRow);
    appendDescendants(rows, view, view.tree.root.entryId, populated);
  }
  for (const work of works) {
    const view = catalog.read(work.sourceId);
    if (
      !includeEmpty &&
      view &&
      catalog.status(work.sourceId) === "ready" &&
      populatedContainers(view, catalog, kinds).size === 0
    )
      continue;
    const row = rowForWork(work);
    if (row) rows.push(row);
  }
  return rows;
}

function appendDescendants(
  rows: ReferenceRow[],
  view: ReferenceSourceView,
  parentId: string,
  populated: ReadonlySet<string> | null,
): void {
  for (const entry of view.tree.children(parentId)) {
    const row = rowForEntry(view, entry);
    if (row && (entry.kind === "file" || !populated || populated.has(entry.entryId)))
      rows.push(row);
    if (entry.kind === "dir") appendDescendants(rows, view, entry.entryId, populated);
  }
}

function drilledRows(
  location: DrilledLocation,
  catalog: ReferenceCatalogPort,
  kinds?: readonly ReferenceKind[],
): ReferenceRow[] {
  const view = catalog.read(location.activeSource);
  if (!view) return [];
  const populated = populatedContainers(view, catalog, kinds);
  if (!location.containerId) {
    const sourceRow = rowForSource(view);
    return sourceRow && populated.has(view.tree.root.entryId) ? [sourceRow] : [];
  }
  return view.tree.children(location.containerId).flatMap((entry) => {
    if (entry.kind !== "file" && !populated.has(entry.entryId)) return [];
    const row = rowForEntry(view, entry);
    return row ? [row] : [];
  });
}

function foldersMentionable(kinds: readonly ReferenceKind[] | undefined): boolean {
  return !kinds || kinds.includes("folder");
}

/** The row that mentions the folder a level lists; sources (area roots) list no such row. */
function folderMentionRow(
  listed: { sourceId: string; containerId?: string },
  catalog: ReferenceCatalogPort,
): Extract<ReferenceRow, { kind: "folder-mention" }> | null {
  if (!listed.containerId) return null;
  const view = catalog.read(listed.sourceId);
  const entry = view?.tree.entry(listed.containerId);
  return view && entry?.kind === "dir" ? referenceRowForFolder(entry, view.source) : null;
}

/**
 * The source an explicit address (`kb://`, `scratch://@w3/`) names among the ones listed, to say
 * whether its rows are still loading.
 */
function namespaceSourceOf(
  parsed: ParsedContextUri,
  sourceIds: readonly string[],
  works: readonly ReferenceWork[],
  catalog: ReferenceCatalogPort,
): string | undefined {
  const views = sourceIds.flatMap((id) => {
    const view = catalog.read(id);
    return view ? [view] : [];
  });
  const named = parsed.authority;
  if (named.kind === "work") {
    return works.find((work) => work.handle === named.workHandle)?.sourceId;
  }
  const sameScheme = views.filter(({ source }) => source.scheme === parsed.scheme);
  const byKind = (kind: string) =>
    sameScheme.find(({ source }) => source.authority.kind === kind)?.source.id;
  if (named.kind === "lineage") return byKind("lineage");
  if (named.kind === "chat") return byKind("chat");
  // A No Work chat's bare Scratch is its lineage's; the project's other schemes are its own.
  if (parsed.scheme === "scratch") return byKind("lineage") ?? byKind("work");
  return sameScheme[0]?.source.id;
}

/**
 * The containers worth browsing into: each holds something selectable here. A
 * mentionable folder is selectable itself, so where folders are taken an empty
 * folder and its ancestors stay reachable. A list that has not synced proves nothing
 * empty: every container stays reachable.
 */
function populatedContainers(
  view: ReferenceSourceView,
  catalog: ReferenceCatalogPort,
  kinds?: readonly ReferenceKind[],
): Set<string> {
  const { tree, source } = view;
  const populated = new Set<string>();
  const ids = tree.descendants(tree.root.entryId);
  if (catalog.status(source.id) !== "ready") {
    populated.add(tree.root.entryId);
    for (const id of ids) if (tree.entry(id)?.kind === "dir") populated.add(id);
    return populated;
  }
  const folders = foldersMentionable(kinds);
  for (const id of ids) {
    const entry = tree.entry(id);
    let parentId: string | undefined;
    if (entry?.kind === "dir") {
      if (!folders || !folderReferenceForEntry(entry, source)) continue;
      parentId = entry.entryId;
    } else if (entry?.kind === "file") {
      const row = referenceRowForFile(entry, source);
      if (!row || (kinds && !kinds.includes(row.fileKind))) continue;
      parentId = entry.parentId;
    } else continue;
    while (parentId && !populated.has(parentId)) {
      populated.add(parentId);
      const parent = tree.entry(parentId);
      parentId = parent?.parentId ?? undefined;
    }
  }
  return populated;
}

/** A Work's row in the browser: its Scratch opens beneath it. */
function rowForWork(work: ReferenceWork): Extract<ReferenceRow, { kind: "authority" }> {
  return {
    kind: "authority",
    authorityKind: "work",
    rowId: `authority:${work.sourceId}`,
    label: work.name,
    location: "",
    matchAliases: [work.handle],
    action: {
      type: "navigate",
      prefix: ownerSegment({ kind: "work", workHandle: work.handle }) ?? "",
      sourceId: work.sourceId,
    },
  };
}

function rowForSource(view: ReferenceSourceView): ReferenceRow | null {
  const { source, tree } = view;
  const prefix = referenceUriForAuthority(tree.root.uri, source.authority);
  if (!prefix) return null;
  return {
    kind: "source",
    rowId: `source:${source.id}`,
    label: tree.root.name,
    location: source.ownerLabel,
    matchAliases: [source.scheme],
    action: { type: "navigate", prefix, sourceId: source.id, containerId: tree.root.entryId },
  };
}

function rowForEntry(
  view: ReferenceSourceView,
  entry: TreeFile | TreeDirectory,
): ReferenceRow | null {
  if (entry.kind === "file") return referenceRowForFile(entry, view.source);
  const prefix = referenceUriForAuthority(entry.uri, view.source.authority);
  if (!prefix) return null;
  return {
    kind: "folder",
    rowId: `folder:${view.source.id}:${entry.entryId}`,
    label: entry.name,
    location: locationOf(entry.path),
    matchAliases: [],
    action: {
      type: "navigate",
      prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
      sourceId: view.source.id,
      containerId: entry.entryId,
    },
  };
}

/**
 * The link-ahead row for a search, when it names no document the rows already
 * offer exactly: by stored name (`Chapter 13.md` typed is `Chapter 13`), or
 * by a visible-extension file's name without the extension (`outline` for
 * `outline.json`), the way a link reaches it.
 */
function linkAheadRow(
  search: string,
  ranked: readonly ReferenceRow[],
  linkAhead: NonNullable<ReferenceBrowserOptions["linkAhead"]>,
): LinkAheadRow | null {
  const name = search.trim();
  if (!name) return null;
  const typed = parseDocumentFilename(name);
  const named = matchDocumentPath(
    ranked.filter((row) => row.kind === "file"),
    normalizeReferenceName(name),
    (row) => normalizeReferenceName(row.label),
  );
  if (named) return null;
  const target = linkAhead(name);
  return target
    ? {
        kind: "link-ahead",
        rowId: "link-ahead",
        label: typed.ok ? renderFilename(typed.value.name, typed.value.extension) : name,
        uri: target.uri,
      }
    : null;
}
