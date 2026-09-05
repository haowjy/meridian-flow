/** Hierarchical, renderer-neutral reference browser composed with the suggestion lifecycle. */
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
  let acquisition: AbortController | null = null;
  let settled = false;
  let awaitingSegmentEcho = false;
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
  });

  const session = (): InternalSuggestionSession<ReferenceRow, ReferenceBrowserMeta> => ({
    items: rows,
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
    const candidates =
      location.kind === "root"
        ? rootRows(location.warmScopes, options.catalog, authorityIndex)
        : drilledRows(location, options.catalog, authorityIndex, override);
    return rankReferenceRows(candidates, query, { ...options.priors, kinds: referenceKinds });
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

  async function navigate(action: ReferenceNavigationAction): Promise<void> {
    if (!location || !identity) return;
    history.push(location);
    location = {
      kind: "drilled",
      activeScope: action.scope,
      ...(action.containerId ? { containerId: action.containerId } : {}),
    };
    query = "";
    incomplete = action.acquire;
    const candidate = advance();
    if (!candidate) return;
    publish(candidate, "reset");
    if (!action.acquire) return;

    const controller = new AbortController();
    acquisition = controller;
    try {
      const view = await options.catalog.acquire(action.scope, controller.signal);
      if (controller.signal.aborted || identity !== candidate) return;
      incomplete = false;
      acquisition = null;
      publish(candidate, "preserve-active", view);
    } catch {
      if (controller.signal.aborted || identity !== candidate) return;
      incomplete = true;
      acquisition = null;
      publish(candidate, "preserve-active");
    }
  }

  function chooseRow(row: ReferenceRow, action: SuggestionChoiceAction): void {
    if (row.kind !== "file") {
      void navigate(row.action);
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
    if (!identity || !location || location.kind === "root") return false;
    const previous = history.pop();
    if (!previous) return false;
    location = previous;
    query = "";
    incomplete = false;
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
      requestExit = frame.requestExit;
      anchorRect = frame.anchorRect;
      lastText = frame.text;
      location = { kind: "root", warmScopes: context.warmScopes };
      history = [];
      query = frame.query;
      triggerRange = frame.triggerRange;
      completedPrefix = "";
      referenceKinds = context.referenceKinds;
      incomplete = context.warmScopes.some((scope) => options.catalog.read(scope) === null);
      settled = false;
      awaitingSegmentEcho = false;
      rows = project();
      identity = lifecycle.open(session());
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
          ? location.warmScopes.some((scope) => options.catalog.read(scope) === null)
          : incomplete;
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
): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  const authorityRows = new Set<string>();
  for (const scope of scopes) {
    const view = catalog.read(scope);
    if (!view) continue;
    for (const entry of view.entries.values()) {
      if (entry.kind === "authority") {
        if (!entry.available || authorityRows.has(entry.entryId)) continue;
        authorityRows.add(entry.entryId);
        rows.push(rowForAuthority(entry));
        continue;
      }
      if (entry.kind !== "source" || view.invalidatedEntryIds.has(entry.entryId)) continue;
      const sourceRow = rowForEntry(entry, authorities);
      if (sourceRow) rows.push(sourceRow);
      appendDescendants(rows, view, entry.entryId, authorities);
    }
  }
  return rows;
}

function appendDescendants(
  rows: ReferenceRow[],
  view: CatalogCacheView,
  parentId: string,
  authorities: ReferenceAuthorityIndex,
): void {
  for (const entry of catalogChildren(view, parentId)) {
    if (entry.kind === "authority") continue;
    const row = rowForEntry(entry, authorities);
    if (row) rows.push(row);
    if (entry.kind === "folder") appendDescendants(rows, view, entry.entryId, authorities);
  }
}

function drilledRows(
  location: DrilledLocation,
  catalog: ReferenceCatalogPort,
  authorities: ReferenceAuthorityIndex,
  override?: CatalogCacheView,
): ReferenceRow[] {
  const view =
    override && catalogScopeKey(override.scope) === catalogScopeKey(location.activeScope)
      ? override
      : catalog.read(location.activeScope);
  if (!view) return [];
  const entries = location.containerId
    ? catalogChildren(view, location.containerId)
    : [...view.entries.values()].filter(
        (entry): entry is Extract<CatalogEntry, { kind: "source" }> => entry.kind === "source",
      );
  return entries.flatMap((entry) => {
    if (entry.kind === "authority") return [];
    const row = rowForEntry(entry, authorities);
    return row ? [row] : [];
  });
}

function rowForAuthority(entry: CatalogAuthorityEntry): ReferenceRow {
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
      prefix,
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
