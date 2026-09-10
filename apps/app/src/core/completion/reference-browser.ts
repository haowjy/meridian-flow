/** Hierarchical, renderer-neutral reference browser composed with the suggestion lifecycle. */
import { type ContextUriScheme, parseContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogAuthorityEntry,
  CatalogEntry,
  CatalogFileEntry,
  CatalogScope,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { type CatalogCacheView, catalogChildren } from "@/client/query/context-catalog-cache";
import {
  authoritativeReferenceForFile,
  canonicalReferenceUri,
  type ReferenceAuthorityIndex,
  type ReferenceKind,
  type ReferenceNavigationAction,
  type ReferenceRankingPriors,
  type ReferenceRow,
  rankReferenceRows,
  referenceAuthorityIndex,
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

export type ReferenceCatalogPort = {
  subscribe: (listener: () => void) => () => void;
  status: (scope: CatalogScope) => "loading" | "ready" | "error";
  /** Read the already-installed F1 normalized view. Missing means cold, not empty. */
  read: (scope: CatalogScope) => CatalogCacheView | null;
  /** Explicit authority activation delegates to the F1 acquisition owner. */
  acquire: (scope: CatalogScope, signal: AbortSignal) => Promise<CatalogCacheView>;
};

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

export type ReferenceBrowserState =
  | { kind: "closed" }
  | (ReferenceBrowserMeta & {
      kind: "root";
      query: string;
      warmScopes: readonly CatalogScope[];
      rows: readonly ReferenceRow[];
    })
  | (ReferenceBrowserMeta & {
      kind: "drilled";
      query: string;
      activeScope: CatalogScope;
      containerId?: string;
      rows: readonly ReferenceRow[];
    });

export type ReferenceBrowserOpenContext = Readonly<{
  warmScopes: readonly CatalogScope[];
  referenceKinds?: readonly ReferenceKind[];
}>;
export type ReferenceBrowserController = SuggestionDriver<
  never,
  ReferenceRow,
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
  onSelect: (input: {
    row: Extract<ReferenceRow, { kind: "file" }>;
    triggerRange: SuggestionTriggerRange;
  }) => void;
  onCompleteSegment: (input: { prefix: string; triggerRange: SuggestionTriggerRange }) => void;
};

type RootLocation = {
  kind: "root";
  warmScopes: readonly CatalogScope[];
};

type DrilledLocation = {
  kind: "drilled";
  activeScope: CatalogScope;
  containerId?: string;
  label?: string;
};

type Location = RootLocation | DrilledLocation;
type BrowsableCatalogEntry = Extract<CatalogEntry, { kind: "source" | "folder" | "file" }>;

/**
 * The sole browser state machine. It projects F1 views and publishes through
 * F3; it owns neither catalog storage nor host insertion/rendering.
 */
export function createReferenceBrowserController(
  options: ReferenceBrowserOptions,
): ReferenceBrowserController {
  const { menu, lifecycle } = createSuggestionDriverCore<ReferenceRow, ReferenceBrowserMeta>();
  let identity: InternalSuggestionGeneration | null = null;
  let location: Location | null = null;
  let history: Location[] = [];
  let query = "";
  let triggerRange = { from: 0, to: 0 };
  let completedPrefix = "";
  let rows: readonly ReferenceRow[] = [];
  let incomplete = false;
  let loadFailed = false;
  let queriedContainer: Extract<ReferenceRow, { kind: "source" | "folder" }> | null = null;
  let triggerPrefix = "";
  let acquisition: AbortController | null = null;
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

  const authorities = (): ReferenceAuthorityIndex => {
    const entries: CatalogAuthorityEntry[] = [];
    const scopes =
      location?.kind === "root"
        ? location.warmScopes
        : history[0]?.kind === "root"
          ? history[0].warmScopes
          : [];
    for (const scope of scopes) {
      const view = options.catalog.read(scope);
      if (!view) continue;
      for (const entry of view.entries.values())
        if (entry.kind === "authority") entries.push(entry);
    }
    return referenceAuthorityIndex(entries);
  };

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

  const session = (): InternalSuggestionSession<ReferenceRow, ReferenceBrowserMeta> => ({
    items: rows,
    keepOpenWhenEmpty: true,
    rowId: (row) => row.rowId,
    query,
    anchorRect,
    label: options.label(),
    meta: meta(),
    choose: chooseRow,
    backtrack,
    dismiss,
  });

  const project = (override?: CatalogCacheView): readonly ReferenceRow[] => {
    if (!location) return [];
    const authorityIndex = authorities();
    const root = location.kind === "root" ? location : history[0];
    const scopes = root?.kind === "root" ? [...root.warmScopes] : [];
    if (location.kind === "drilled") {
      const activeScope = location.activeScope;
      if (!scopes.some((scope) => catalogScopeKey(scope) === catalogScopeKey(activeScope)))
        scopes.push(activeScope);
    }
    const allRows = query.includes("://")
      ? rootRows(scopes, options.catalog, authorityIndex, referenceKinds, true)
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
    const namespaceScope = parsed
      ? scopes.find((scope) => {
          if (parsed.scheme === "kb" || parsed.scheme === "manuscript")
            return scope.kind === "project";
          if (parsed.scheme === "user") return scope.kind === "user";
          if (parsed.authority.kind === "none") return scope.kind === "none";
          if (parsed.authority.kind === "contextual")
            return scope.kind === "work" || scope.kind === "none";
          return (
            scope.kind === "work" &&
            [...authorityIndex.values()].some(
              (entry) =>
                entry.authority.kind === "work" &&
                entry.authority.workId === scope.workId &&
                parsed.authority.kind === "work" &&
                entry.authority.workSlug === parsed.authority.workSlug,
            )
          );
        })
      : undefined;
    const targetScope =
      queriedContainer?.action.scope ??
      namespaceScope ??
      (location.kind === "drilled" ? location.activeScope : undefined);
    if (targetScope) {
      const view = override ?? options.catalog.read(targetScope);
      const containerId =
        queriedContainer?.action.containerId ??
        (parsed
          ? view?.sourceIdsByScheme.get(parsed.scheme)
          : location.kind === "drilled"
            ? location.containerId
            : undefined);
      incomplete = acquisition !== null || containerIncomplete(view, containerId, parsed !== null);
      loadFailed = options.catalog.status(targetScope) === "error" || loadFailed;
      if (loadFailed) incomplete = false;
    } else {
      incomplete = scopes.some((scope) => catalogIncomplete(options.catalog.read(scope)));
      loadFailed = scopes.some((scope) => options.catalog.status(scope) === "error");
    }
    const candidates = queriedContainer
      ? drilledRows(
          {
            kind: "drilled",
            activeScope: queriedContainer.action.scope,
            containerId: queriedContainer.action.containerId,
          },
          options.catalog,
          authorityIndex,
          referenceKinds,
          override,
        )
      : namespaceScope
        ? []
        : location.kind === "root"
          ? rootRows(location.warmScopes, options.catalog, authorityIndex, referenceKinds)
          : drilledRows(location, options.catalog, authorityIndex, referenceKinds, override);
    const search = queriedContainer
      ? typedQuery.slice(queriedContainer.action.prefix.length)
      : query;
    hasSearch = search.length > 0 && !(parsed && parsed.path === "");
    return rankReferenceRows(candidates, search, { ...options.priors, kinds: referenceKinds });
  };

  const publish = (
    candidate: InternalSuggestionGeneration,
    selection: "reset" | "preserve-active",
    override?: CatalogCacheView,
  ): boolean => {
    rows = project(override);
    return lifecycle.update(candidate, session(), selection);
  };

  const advance = (): InternalSuggestionGeneration | null => {
    acquisition?.abort();
    acquisition = null;
    if (!identity) return null;
    identity = lifecycle.nextGeneration(identity.sessionId);
    return identity;
  };

  async function navigate(action: ReferenceNavigationAction, label: string): Promise<void> {
    if (!location || !identity) return;
    history.push(location);
    location = {
      kind: "drilled",
      activeScope: action.scope,
      label,
      ...(action.containerId ? { containerId: action.containerId } : {}),
    };
    query = "";
    incomplete = action.acquire;
    loadFailed = false;
    const candidate = advance();
    if (!candidate) return;
    const controller = action.acquire ? new AbortController() : null;
    acquisition = controller;
    publish(candidate, "reset");
    if (!controller) return;
    try {
      const view = await options.catalog.acquire(action.scope, controller.signal);
      if (controller.signal.aborted || identity !== candidate) return;
      incomplete = false;
      acquisition = null;
      publish(candidate, "preserve-active", view);
    } catch {
      if (controller.signal.aborted || identity !== candidate) return;
      incomplete = false;
      loadFailed = true;
      acquisition = null;
      publish(candidate, "preserve-active");
    }
  }

  function chooseRow(row: ReferenceRow, action: SuggestionChoiceAction): void {
    if (row.kind !== "file") {
      void navigate(row.action, row.label);
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
      acquisition?.abort();
      unsubscribe?.();
      requestExit = frame.requestExit;
      anchorRect = frame.anchorRect;
      lastText = frame.text;
      triggerPrefix = frame.text.slice(0, frame.text.length - frame.query.length);
      loadFailed = false;
      location = { kind: "root", warmScopes: context.warmScopes };
      history = [];
      query = frame.query;
      triggerRange = frame.triggerRange;
      completedPrefix = "";
      referenceKinds = context.referenceKinds;
      incomplete = context.warmScopes.some((scope) =>
        catalogIncomplete(options.catalog.read(scope)),
      );
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
      acquisition?.abort();
      acquisition = null;
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
      incomplete =
        location?.kind === "root"
          ? location.warmScopes.some((scope) => catalogIncomplete(options.catalog.read(scope)))
          : acquisition !== null ||
            (!loadFailed &&
              catalogIncomplete(location ? options.catalog.read(location.activeScope) : null));
      return publish(identity, "preserve-active");
    },
    state() {
      if (!location) return { kind: "closed" };
      const shared = { ...meta(), query, rows };
      return location.kind === "root"
        ? { ...shared, kind: "root", warmScopes: location.warmScopes }
        : {
            ...shared,
            kind: "drilled",
            activeScope: location.activeScope,
            ...(location.containerId ? { containerId: location.containerId } : {}),
          };
    },
  };
}

function rootRows(
  scopes: readonly CatalogScope[],
  catalog: ReferenceCatalogPort,
  authorities: ReferenceAuthorityIndex,
  kinds?: readonly ReferenceKind[],
  includeEmpty = false,
): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  const authorityRows = new Set<string>();
  for (const scope of scopes) {
    const view = catalog.read(scope);
    if (!view) continue;
    const populated = includeEmpty ? null : populatedContainers(view, authorities, kinds);
    for (const entry of view.entries.values()) {
      if (entry.kind === "authority") {
        if (!entry.available || authorityRows.has(entry.entryId)) continue;
        authorityRows.add(entry.entryId);
        const row = rowForAuthority(entry);
        const authorityView = catalog.read(row.action.scope);
        if (
          !includeEmpty &&
          authorityView &&
          !catalogIncomplete(authorityView) &&
          populatedContainers(authorityView, authorities, kinds).size === 0
        )
          continue;
        rows.push(row);
        continue;
      }
      if (entry.kind !== "source" || view.invalidatedEntryIds.has(entry.entryId)) continue;
      const sourceRow = rowForEntry(entry, authorities);
      if (sourceRow && (!populated || populated.has(entry.entryId))) rows.push(sourceRow);
      appendDescendants(rows, view, entry.entryId, authorities, populated);
    }
  }
  return rows;
}

function appendDescendants(
  rows: ReferenceRow[],
  view: CatalogCacheView,
  parentId: string,
  authorities: ReferenceAuthorityIndex,
  populated: ReadonlySet<string> | null,
): void {
  for (const entry of catalogChildren(view, parentId)) {
    if (entry.kind === "authority") continue;
    const row = rowForEntry(entry, authorities);
    if (row && (entry.kind === "file" || !populated || populated.has(entry.entryId)))
      rows.push(row);
    if (entry.kind === "folder")
      appendDescendants(rows, view, entry.entryId, authorities, populated);
  }
}

function drilledRows(
  location: DrilledLocation,
  catalog: ReferenceCatalogPort,
  authorities: ReferenceAuthorityIndex,
  kinds?: readonly ReferenceKind[],
  override?: CatalogCacheView,
): ReferenceRow[] {
  const view =
    override && catalogScopeKey(override.scope) === catalogScopeKey(location.activeScope)
      ? override
      : catalog.read(location.activeScope);
  if (!view) return [];
  const populated = populatedContainers(view, authorities, kinds);
  const entries = location.containerId
    ? catalogChildren(view, location.containerId)
    : [...view.entries.values()].filter(
        (entry): entry is Extract<CatalogEntry, { kind: "source" }> => entry.kind === "source",
      );
  return entries.flatMap((entry) => {
    if (entry.kind === "authority" || (entry.kind !== "file" && !populated.has(entry.entryId)))
      return [];
    const row = rowForEntry(entry, authorities);
    return row ? [row] : [];
  });
}

function catalogIncomplete(view: CatalogCacheView | null): boolean {
  return !view?.generation || view.invalidatedEntryIds.size > 0;
}

function containerIncomplete(
  view: CatalogCacheView | null,
  containerId: string | undefined,
  explicit: boolean,
): boolean {
  if (!view?.generation) return true;
  if (!containerId) return !explicit && view.invalidatedEntryIds.size > 0;
  for (const id of view.invalidatedEntryIds) {
    let entry = view.entries.get(id);
    while (entry) {
      if (entry.entryId === containerId) return true;
      entry =
        entry.kind === "folder" || entry.kind === "file"
          ? view.entries.get(entry.parentId)
          : undefined;
    }
  }
  return false;
}

/** Snapshot metadata proves emptiness; cold or invalidated containers must not disappear. */
function populatedContainers(
  view: CatalogCacheView,
  authorities: ReferenceAuthorityIndex,
  kinds?: readonly ReferenceKind[],
): Set<string> {
  const populated = new Set<string>();
  if (!view.generation) {
    for (const entry of view.entries.values())
      if (entry.kind === "source" || entry.kind === "folder") populated.add(entry.entryId);
    return populated;
  }
  for (const entry of view.entries.values()) {
    let parentId: string | undefined;
    if (view.invalidatedEntryIds.has(entry.entryId)) parentId = entry.entryId;
    else {
      if (entry.kind !== "file") continue;
      const row = rowForFile(entry, authorities);
      if (!row || (kinds && !kinds.includes(row.fileKind))) continue;
      parentId = entry.parentId;
    }
    while (parentId && !populated.has(parentId)) {
      populated.add(parentId);
      const parent = view.entries.get(parentId);
      parentId = parent?.kind === "folder" || parent?.kind === "file" ? parent.parentId : undefined;
    }
  }
  return populated;
}

function rowForAuthority(
  entry: CatalogAuthorityEntry,
): Extract<ReferenceRow, { kind: "authority" }> {
  const scope: CatalogScope =
    entry.authority.kind === "work"
      ? { kind: "work", projectId: entry.scope.projectId, workId: entry.authority.workId }
      : { kind: "none", projectId: entry.scope.projectId };
  return {
    kind: "authority",
    authorityKind: entry.authority.kind,
    rowId: `authority:${entry.entryId}`,
    label: entry.name,
    location: "",
    matchAliases: entry.authority.kind === "work" ? [entry.authority.workSlug] : ["@"],
    action: {
      type: "navigate",
      prefix: entry.authority.kind === "work" ? `@${entry.authority.workSlug}/` : "@/",
      scope,
      acquire: true,
    },
  };
}

function rowForEntry(
  entry: BrowsableCatalogEntry,
  authorities: ReferenceAuthorityIndex,
): ReferenceRow | null {
  if (entry.kind === "file") return rowForFile(entry, authorities);
  const prefix = canonicalReferenceUri(entry.scope, entry.uri, authorities);
  if (!prefix) return null;
  if (entry.kind === "source") {
    return {
      kind: "source",
      rowId: `source:${catalogScopeKey(entry.scope)}:${entry.entryId}`,
      label: entry.name,
      location: prefix,
      matchAliases: [entry.scheme],
      action: {
        type: "navigate",
        prefix,
        scope: entry.scope,
        containerId: entry.entryId,
        acquire: false,
      },
    };
  }
  return {
    kind: "folder",
    rowId: `folder:${catalogScopeKey(entry.scope)}:${entry.entryId}`,
    label: entry.name,
    location: entry.path.slice(0, -1).join("/"),
    matchAliases: [],
    action: {
      type: "navigate",
      prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
      scope: entry.scope,
      containerId: entry.entryId,
      acquire: false,
    },
  };
}

function rowForFile(
  entry: CatalogFileEntry,
  authorities: ReferenceAuthorityIndex,
): Extract<ReferenceRow, { kind: "file" }> | null {
  const reference = authoritativeReferenceForFile(entry, authorities);
  if (!reference) return null;
  return {
    kind: "file",
    rowId: `file:${entry.entryId}`,
    label: entry.name,
    location: entry.path.slice(0, -1).join("/"),
    fileKind: entry.editable ? "document" : "asset",
    aliases: entry.aliases,
    matchedAlias: null,
    ambiguous: false,
    action: { type: "select", reference },
  };
}
