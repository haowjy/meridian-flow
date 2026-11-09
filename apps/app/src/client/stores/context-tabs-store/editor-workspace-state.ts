/** Pure Editor workspace transitions and browser-local restoration codec. */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isRecord } from "@/client/storage/browser-record";
import {
  type ContextTab,
  DEFAULT_TAB_VIEW,
  isDraftOnly,
  isEditorContextTab,
  matchesTabInstance,
  type ProjectTabsSlice,
  type ReviewEntries,
  type ReviewPin,
  reviewEntriesOf,
  reviewEntryOf,
  selectedDocumentIdOf,
  selectingDocument,
  type TabState,
  tabKey,
  tabStateOf,
  withoutReviewEntry,
  withTabState,
  workReviewOwner,
} from "./editor-workspace-model";

export const EDITOR_WORKSPACE_STORAGE_KEY = "meridian:editor-workspace:v2";
export const EDITOR_WORKSPACE_VERSION = 2;
const EMPTY_PROJECT: ProjectTabsSlice = { tabs: [], selectedTabKey: null };
export type EditorWorkspaceSnapshot = Readonly<{
  version: 2;
  accountId: string;
  projects: Readonly<Record<string, ProjectTabsSlice>>;
}>;

export type EditorWorkspaceCommand =
  | {
      kind: "open";
      projectId: string;
      tab: ContextTab;
      /** Select the tab in the same commit. */
      select?: true;
    }
  | { kind: "close"; projectId: string; tabInstanceId: string }
  | { kind: "select"; projectId: string; tabInstanceId: string | null }
  | {
      /** The writer's choices on one tab: its view, whether it is the preview, its review pin. `null` clears a field. */
      kind: "set-tab-state";
      projectId: string;
      tabInstanceId: string;
      patch: {
        view?: Partial<NonNullable<TabState["view"]>>;
        preview?: boolean;
        reviewPin?: ReviewPin | null;
      };
    }
  | {
      /** A scope switch or a settled review drops every pin of the project. */
      kind: "clear-review-pins";
      projectId: string;
      workId?: string;
      itemKey?: string;
    }
  | {
      kind: "reconcile-resource";
      projectId: string;
      resourceHandle: string;
      tab: ContextTab;
    }
  | {
      kind: "reorder";
      projectId: string;
      expectedTabInstanceIds: readonly string[];
      nextTabInstanceIds: readonly string[];
    }
  | {
      kind: "reconcile-bootstrap";
      projectId: string;
      changes: readonly { prior: ContextTab; next: ContextTab | null }[];
    }
  | {
      kind: "apply-availability";
      projectId: string;
      removals: readonly ContextTab[];
      selection: { priorDocumentId: string | null; nextDocumentId: string | null } | null;
      updates: readonly { prior: ContextTab; next: ContextTab }[];
    }
  | {
      kind: "settle-draft";
      projectId: string;
      tab: ContextTab;
    }
  | {
      /** Discard in one Work: drops that Work's entry; the tab closes only when no Work reviews it. */
      kind: "drop-review";
      projectId: string;
      workId: string;
      tabInstanceId: string;
    }
  | {
      /** Live deleted the document; the Works whose drafts still have it keep the tab as draft-only (D79). */
      kind: "keep-for-drafts";
      projectId: string;
      documentId: string;
      reviews: ReviewEntries;
    };

export type EditorWorkspaceCommandResult =
  | { kind: "committed" | "already-committed"; snapshot: EditorWorkspaceSnapshot }
  | { kind: "stale" | "not-referenced"; snapshot: EditorWorkspaceSnapshot };

const DOCUMENT_FILE_TYPES = {
  docx: true,
  image: true,
  pdf: true,
  binary: true,
} as const satisfies Record<DocumentFileType, true>;
const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

export function parseContextTab(value: unknown): ContextTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  if (
    typeof tab.tabInstanceId !== "string" ||
    typeof tab.documentId !== "string" ||
    typeof tab.name !== "string"
  )
    return null;
  if (tab.kind === "new") {
    if (typeof tab.resourceHandle !== "string" || tab.resourceHandle.length === 0) return null;
    if (!validTabState(tab)) return null;
    const { workId: _priorWork, ...local } = tab;
    return local as ContextTab;
  }
  if (
    (tab.kind !== "tracked" && tab.kind !== "viewer") ||
    !isProjectContextTreeScheme(tab.scheme) ||
    typeof tab.path !== "string" ||
    tab.path.length === 0 ||
    !optionalString(tab.workId) ||
    !optionalString(tab.rootThreadId) ||
    !optionalString(tab.rootThreadRef) ||
    !optionalString(tab.chatId) ||
    !optionalString(tab.chatRef) ||
    tab.workId === "" ||
    tab.rootThreadId === "" ||
    // A chat's Scratch names its lineage and handle instead of a Work.
    (tab.rootThreadId !== undefined &&
      (tab.scheme !== "scratch" || tab.workId !== undefined || !tab.rootThreadRef)) ||
    // A chat's uploads name the chat and handle instead of a Work, and have no other owner.
    (tab.chatId !== undefined &&
      (tab.scheme !== "uploads" || tab.workId !== undefined || !tab.chatRef)) ||
    (tab.scheme === "uploads" && tab.chatId === undefined) ||
    (isWorkScopedScheme(tab.scheme) && !tab.workId && !tab.rootThreadId)
  )
    return null;
  if (!validTabState(tab)) return null;
  if (tab.kind === "tracked" && tab.editable === true) {
    const classification = classifyFiletype(typeof tab.filetype === "string" ? tab.filetype : null);
    if (
      classification.kind !== "tracked" ||
      classification.schemaType !== tab.schemaType ||
      !optionalString(tab.resourceHandle) ||
      (tab.provisionalName !== undefined && typeof tab.provisionalName !== "boolean") ||
      (tab.origin !== undefined && tab.origin !== "local-resource")
    )
      return null;
    return value as ContextTab;
  }
  if (
    tab.origin === undefined &&
    tab.kind === "viewer" &&
    tab.editable === false &&
    typeof tab.fileType === "string" &&
    tab.fileType in DOCUMENT_FILE_TYPES &&
    optionalString(tab.mimeType) &&
    optionalString(tab.resourceHandle)
  )
    return value as ContextTab;
  return null;
}

const isString = (value: unknown): value is string => typeof value === "string";

/** What a tab session written by this build holds; anything else means the record is not ours. */
function validTabState(tab: Record<string, unknown>): boolean {
  const { view, preview, reviewPin, reviews } = tab;
  if (
    view !== undefined &&
    !(
      isRecord(view) &&
      (view.version === "draft" || view.version === "live") &&
      typeof view.showChanges === "boolean"
    )
  )
    return false;
  if (preview !== undefined && preview !== true) return false;
  if (
    reviewPin !== undefined &&
    !(
      isRecord(reviewPin) &&
      isString(reviewPin.owner) &&
      isString(reviewPin.itemKey) &&
      (reviewPin.changeId === undefined || isString(reviewPin.changeId))
    )
  )
    return false;
  if (reviews !== undefined) {
    if (tab.kind !== "tracked" || !isRecord(reviews)) return false;
    for (const entry of Object.values(reviews))
      if (!isRecord(entry) || !isString(entry.itemKey) || !isString(entry.tabInstanceToken))
        return false;
  }
  return true;
}

function withoutResourceOwnership(tab: ContextTab): ContextTab {
  if (tab.kind === "tracked") {
    const { resourceHandle: _resourceHandle, origin: _origin, ...rest } = tab;
    return rest;
  }
  if (tab.kind === "viewer") {
    const { resourceHandle: _resourceHandle, ...rest } = tab;
    return rest;
  }
  return tab;
}

function parseProjectWorkspace(value: unknown): ProjectTabsSlice | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.tabs)) return null;
  if (value.selectedTabKey !== null && typeof value.selectedTabKey !== "string") return null;
  const tabs = value.tabs.map(parseContextTab);
  if (tabs.some((tab) => tab === null)) return null;
  const resourceIds = new Set(
    tabs.filter((tab) => tab && !isEditorContextTab(tab)).map((tab) => tab?.documentId),
  );
  const parsedTabs = (tabs as ContextTab[]).filter((tab) => !resourceIds.has(tab.documentId));
  const instanceIds = parsedTabs.map((tab) => tab.tabInstanceId as string);
  if (new Set(instanceIds).size !== instanceIds.length) return null;
  const previews = parsedTabs.filter((tab) => tab.preview).length;
  if (previews > 1) return null;
  const selected = parsedTabs.find((tab) => tabKey(tab) === value.selectedTabKey);
  return { tabs: parsedTabs, selectedTabKey: selected ? tabKey(selected) : null };
}

function withoutOwner(tab: ContextTab): ContextTab {
  if (tab.kind === "new") return tab;
  const {
    workId: _work,
    rootThreadId: _lineage,
    rootThreadRef: _handle,
    chatId: _chat,
    chatRef: _chatHandle,
    ...rest
  } = tab;
  return rest as ContextTab;
}

export function parseEditorWorkspace(
  value: unknown,
): EditorWorkspaceSnapshot["projects"] | undefined {
  if (!isRecord(value)) return undefined;
  const projects: Record<string, ProjectTabsSlice> = {};
  for (const [projectId, workspace] of Object.entries(value)) {
    const parsed = parseProjectWorkspace(workspace);
    if (!parsed) return undefined;
    projects[projectId] = parsed;
  }
  return projects;
}

export function durableContextTab(tab: ContextTab): ContextTab {
  const tabInstanceId = tab.tabInstanceId ?? crypto.randomUUID();
  if (tab.kind !== "tracked") return { ...tab, tabInstanceId };
  const { reviews: _reviews, ...persisted } = tab;
  return { ...persisted, tabInstanceId };
}

/** A tab is its document; the scheme, path and owner it carries are a refreshed display cache. */
function sameTabIdentity(left: ContextTab, right: ContextTab): boolean {
  return (
    left.tabInstanceId === right.tabInstanceId &&
    left.documentId === right.documentId &&
    left.kind === right.kind &&
    (left.kind !== "new" || left.resourceHandle === right.resourceHandle)
  );
}

function normalizeProject(workspace: ProjectTabsSlice): ProjectTabsSlice {
  const tabs = workspace.tabs.filter(isEditorContextTab);
  return {
    tabs,
    selectedTabKey: tabs.some((tab) => tabKey(tab) === workspace.selectedTabKey)
      ? workspace.selectedTabKey
      : null,
  };
}

/** The tab to select once `removed` is gone: it keeps the selection unless it was the selected one. */
function pinWithoutWork(tab: ContextTab, workId: string): ContextTab {
  if (tab.reviewPin?.owner !== workReviewOwner(workId)) return tab;
  const { reviewPin: _pin, ...rest } = tab;
  return rest as ContextTab;
}

function selectionAfterRemoval(
  workspace: ProjectTabsSlice,
  removed: readonly ContextTab[],
): string | null {
  return removed.some((tab) => tabKey(tab) === workspace.selectedTabKey)
    ? null
    : workspace.selectedTabKey;
}

function canonicalizeTabs(tabs: readonly ContextTab[]): ContextTab[] {
  const canonical: ContextTab[] = [];
  for (const tab of tabs) {
    const index = canonical.findIndex(
      (candidate) =>
        candidate.documentId === tab.documentId ||
        (candidate.resourceHandle !== undefined && candidate.resourceHandle === tab.resourceHandle),
    );
    if (index < 0) canonical.push(tab);
    else {
      const existing = canonical[index] as ContextTab;
      canonical[index] = {
        ...existing,
        ...tab,
        tabInstanceId: existing.tabInstanceId,
      } as ContextTab;
    }
  }
  return canonical;
}
function outcome(
  kind: EditorWorkspaceCommandResult["kind"],
  snapshot: EditorWorkspaceSnapshot,
): EditorWorkspaceCommandResult {
  return { kind, snapshot };
}
/** Only the changed project is rebuilt, so every other project's subscribers keep their slice. */
function replaceProject(
  current: EditorWorkspaceSnapshot,
  projectId: string,
  workspace: ProjectTabsSlice,
): EditorWorkspaceCommandResult {
  return outcome("committed", {
    ...current,
    projects: { ...current.projects, [projectId]: normalizeProject(workspace) },
  });
}

/** Total reducer for every durable workspace writer class. */
export function reduceEditorWorkspace(
  current: EditorWorkspaceSnapshot,
  command: EditorWorkspaceCommand,
): EditorWorkspaceCommandResult {
  if (command.kind === "reconcile-bootstrap") {
    const workspace = current.projects[command.projectId] ?? EMPTY_PROJECT;
    const tabs = [...workspace.tabs];
    let selectedTabKey = workspace.selectedTabKey;
    const consumedMembers = new Set<string>();
    for (const change of command.changes) {
      const exactIndex = tabs.findIndex((tab) => sameTabIdentity(tab, change.prior));
      const reopenedIndex =
        exactIndex < 0 && change.prior.resourceHandle
          ? tabs.findIndex(
              (tab) =>
                tab.resourceHandle === change.prior.resourceHandle &&
                !consumedMembers.has(tab.tabInstanceId as string),
            )
          : -1;
      const index = exactIndex >= 0 ? exactIndex : reopenedIndex;
      const live = index >= 0 ? tabs[index] : undefined;
      if (!live || consumedMembers.has(live.tabInstanceId as string)) continue;
      consumedMembers.add(live.tabInstanceId as string);
      if (!change.next || isDraftOnly(change.next)) {
        tabs.splice(index, 1);
        if (selectedTabKey === tabKey(live)) selectedTabKey = null;
        continue;
      }
      const incoming = withTabState(
        durableContextTab({
          ...change.next,
          tabInstanceId: live.tabInstanceId,
        } as ContextTab),
        live,
      );
      const conflictIndex = tabs.findIndex(
        (tab, candidateIndex) =>
          candidateIndex !== index &&
          (tab.documentId === incoming.documentId ||
            (tab.resourceHandle !== undefined && tab.resourceHandle === incoming.resourceHandle)),
      );
      if (conflictIndex >= 0) {
        const winner = tabs[conflictIndex] as ContextTab;
        tabs.splice(index, 1);
        if (selectedTabKey === tabKey(live)) selectedTabKey = tabKey(winner);
        continue;
      }
      tabs[index] = incoming;
    }
    const next = normalizeProject({ tabs, selectedTabKey });
    if (JSON.stringify(next) === JSON.stringify(workspace))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "apply-availability") {
    const workspace = current.projects[command.projectId] ?? EMPTY_PROJECT;
    const tabs = workspace.tabs.filter(
      (tab) => !command.removals.some((prior) => sameTabIdentity(tab, prior)),
    );
    for (const update of command.updates) {
      const index = tabs.findIndex((tab) => sameTabIdentity(tab, update.prior));
      if (index < 0) continue;
      const prior = tabs[index] as ContextTab;
      tabs[index] = withTabState(
        durableContextTab({
          ...update.next,
          tabInstanceId: prior.tabInstanceId,
        } as ContextTab),
        prior,
      );
    }
    let next = normalizeProject({
      tabs: canonicalizeTabs(tabs),
      selectedTabKey: workspace.selectedTabKey,
    });
    // The writer's selection follows its tab; a planned selection applies only if nothing moved it since.
    if (command.selection && selectedDocumentIdOf(workspace) === command.selection.priorDocumentId)
      next = selectingDocument(next, command.selection.nextDocumentId);
    if (JSON.stringify(next) === JSON.stringify(workspace))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "settle-draft") {
    // The draft's document is live now: the same tab drops its review metadata in place.
    const workspace = current.projects[command.projectId] ?? EMPTY_PROJECT;
    const index = workspace.tabs.findIndex((tab) => matchesTabInstance(tab, command.tab));
    const prior = workspace.tabs[index];
    if (!prior) return outcome("stale", current);
    if (prior.kind === "new" || !isDraftOnly(prior)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      ...workspace,
      tabs: workspace.tabs.map((tab, candidateIndex) =>
        candidateIndex === index ? withTabState(durableContextTab(prior), prior) : tab,
      ),
    });
  }
  if (command.kind === "keep-for-drafts") {
    const workspace = current.projects[command.projectId];
    const index =
      workspace?.tabs.findIndex(
        (tab) => tab.kind === "tracked" && tab.documentId === command.documentId,
      ) ?? -1;
    const tab = workspace?.tabs[index];
    if (!workspace || !tab || tab.kind !== "tracked") return outcome("not-referenced", current);
    if (isDraftOnly(tab)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      ...workspace,
      tabs: workspace.tabs.map((candidate, candidateIndex) =>
        candidateIndex === index ? { ...tab, reviews: command.reviews } : candidate,
      ),
    });
  }
  if (command.kind === "drop-review") {
    const workspace = current.projects[command.projectId];
    const tab = workspace?.tabs.find(
      (candidate) => candidate.tabInstanceId === command.tabInstanceId,
    );
    if (!workspace || !tab || !reviewEntryOf(tab, command.workId)) return outcome("stale", current);
    const after = withoutReviewEntry(tab, command.workId);
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs.flatMap((candidate) =>
        candidate !== tab ? [candidate] : after ? [pinWithoutWork(after, command.workId)] : [],
      ),
      selectedTabKey: after ? workspace.selectedTabKey : selectionAfterRemoval(workspace, [tab]),
    });
  }
  if (command.kind === "reconcile-resource") {
    const workspace = current.projects[command.projectId];
    if (!workspace) return outcome("not-referenced", current);
    // The tab the caller projected comes first: its id may have become an alias of another tab's.
    const find = (matches: (tab: ContextTab) => boolean) => workspace.tabs.findIndex(matches);
    let index = find((tab) => tab.tabInstanceId === command.tab.tabInstanceId);
    if (index < 0) index = find((tab) => tab.resourceHandle === command.resourceHandle);
    if (index < 0) index = find((tab) => tab.documentId === command.tab.documentId);
    if (index < 0) return outcome("not-referenced", current);
    if (
      command.tab.resourceHandle !== undefined &&
      command.tab.resourceHandle !== command.resourceHandle
    )
      return outcome("stale", current);
    const prior = workspace.tabs[index] as ContextTab;
    // The join re-identifies one document: whatever other tab already shows
    // that document (the draft-only tab, or its promoted successor) is the same
    // document, so the resource's tab absorbs it.
    const absorbed = workspace.tabs.filter(
      (tab, candidateIndex) =>
        candidateIndex !== index && tab.documentId === command.tab.documentId,
    );
    const next = withTabState(
      durableContextTab({
        ...command.tab,
        tabInstanceId: prior.tabInstanceId,
      } as ContextTab),
      prior,
    );
    if (absorbed.length === 0 && JSON.stringify(next) === JSON.stringify(prior))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs
        .filter((tab) => !absorbed.includes(tab))
        .map((tab) => (tab === prior ? next : tab)),
      selectedTabKey: absorbed.some((tab) => tabKey(tab) === workspace.selectedTabKey)
        ? tabKey(next)
        : workspace.selectedTabKey,
    });
  }
  if (command.kind === "open") {
    const workspace = current.projects[command.projectId] ?? EMPTY_PROJECT;
    // A draft-only tab keeps its review metadata while it is the document's one tab.
    const incoming = isDraftOnly(command.tab)
      ? ({
          ...command.tab,
          tabInstanceId: command.tab.tabInstanceId ?? crypto.randomUUID(),
        } as ContextTab)
      : durableContextTab(command.tab);
    const index = workspace.tabs.findIndex(
      (candidate) =>
        candidate.tabInstanceId === incoming.tabInstanceId ||
        candidate.documentId === incoming.documentId,
    );
    const existing = index >= 0 ? workspace.tabs[index] : undefined;
    // A review launch never turns an ordinary tab back into a draft-only one.
    const tab =
      isDraftOnly(incoming) && existing && !isDraftOnly(existing)
        ? durableContextTab(incoming)
        : incoming;
    // The opened tab states its owner: a stale tab for the document must not
    // keep a Work or lineage the opened tab no longer names.
    const existingWithoutResourceOwnership = existing
      ? withoutOwner(withoutResourceOwnership(existing))
      : undefined;
    const merged = existing
      ? ({
          ...existingWithoutResourceOwnership,
          ...tab,
          tabInstanceId: existing.tabInstanceId,
          // What the writer did to the tab is not the opener's to undo.
          ...tabStateOf(existing),
          ...(tab.reviewPin ? { reviewPin: tab.reviewPin } : {}),
          // Each Work keeps the entry it first opened; another Work's draft adds its own.
          ...(existing.kind !== "new" && isDraftOnly(existing)
            ? {
                reviews: {
                  ...reviewEntriesOf(tab),
                  ...reviewEntriesOf(existing),
                },
              }
            : {}),
        } as ContextTab)
      : tab;
    const tabs =
      index < 0
        ? [...workspace.tabs, tab]
        : workspace.tabs.map((candidate, candidateIndex) =>
            candidateIndex === index ? merged : candidate,
          );
    const opened = tabs[index < 0 ? tabs.length - 1 : index] as ContextTab;
    const selectedTabKey = command.select ? tabKey(opened) : workspace.selectedTabKey;
    if (
      index >= 0 &&
      selectedTabKey === workspace.selectedTabKey &&
      JSON.stringify(tabs[index]) === JSON.stringify(workspace.tabs[index])
    )
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, { tabs, selectedTabKey });
  }
  if (command.kind === "close") {
    const workspace = current.projects[command.projectId];
    const closed = workspace?.tabs.find((tab) => tab.tabInstanceId === command.tabInstanceId);
    if (!workspace || !closed) return outcome("stale", current);
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs.filter((tab) => tab.tabInstanceId !== command.tabInstanceId),
      selectedTabKey: selectionAfterRemoval(workspace, [closed]),
    });
  }
  if (command.kind === "select") {
    const workspace = current.projects[command.projectId];
    if (!workspace) return outcome("stale", current);
    if (command.tabInstanceId !== null) {
      const tab = workspace.tabs.find(
        (candidate) => candidate.tabInstanceId === command.tabInstanceId,
      );
      if (!tab || !isEditorContextTab(tab)) return outcome("stale", current);
    }
    if (workspace.selectedTabKey === command.tabInstanceId)
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      ...workspace,
      selectedTabKey: command.tabInstanceId,
    });
  }
  if (command.kind === "set-tab-state") {
    const workspace = current.projects[command.projectId];
    const tab = workspace?.tabs.find(
      (candidate) => candidate.tabInstanceId === command.tabInstanceId,
    );
    if (!workspace || !tab) return outcome("stale", current);
    const { patch } = command;
    const next = { ...tab } as ContextTab;
    if (patch.view) next.view = { ...DEFAULT_TAB_VIEW, ...tab.view, ...patch.view };
    // Choosing Live ends an explicit review address: the pin would keep the review on screen.
    if (patch.reviewPin === null || patch.view?.version === "live") delete next.reviewPin;
    if (patch.reviewPin) next.reviewPin = patch.reviewPin;
    if (patch.preview === false) delete next.preview;
    const tabs = workspace.tabs.map((candidate) => {
      if (candidate === tab)
        return patch.preview ? ({ ...next, preview: true } as ContextTab) : next;
      if (!patch.preview || !candidate.preview) return candidate;
      const { preview: _preview, ...rest } = candidate;
      return rest as ContextTab;
    });
    if (JSON.stringify(tabs) === JSON.stringify(workspace.tabs))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, { ...workspace, tabs });
  }
  if (command.kind === "clear-review-pins") {
    const workspace = current.projects[command.projectId];
    if (!workspace) return outcome("not-referenced", current);
    const matches = (tab: ContextTab) =>
      tab.reviewPin !== undefined &&
      (command.workId === undefined || tab.reviewPin.owner === workReviewOwner(command.workId)) &&
      (command.itemKey === undefined || tab.reviewPin.itemKey === command.itemKey);
    if (!workspace.tabs.some(matches)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (!matches(tab)) return tab;
        const { reviewPin: _pin, ...rest } = tab;
        return rest as ContextTab;
      }),
    });
  }
  if (command.kind === "reorder") {
    const workspace = current.projects[command.projectId];
    const prior = workspace?.tabs.map((tab) => tab.tabInstanceId as string) ?? [];
    if (
      prior.length !== command.expectedTabInstanceIds.length ||
      prior.some((id, index) => id !== command.expectedTabInstanceIds[index]) ||
      command.nextTabInstanceIds.length !== prior.length ||
      new Set(command.nextTabInstanceIds).size !== prior.length ||
      command.nextTabInstanceIds.some((id) => !prior.includes(id))
    )
      return outcome("stale", current);
    if (prior.every((id, index) => id === command.nextTabInstanceIds[index]))
      return outcome("already-committed", current);
    const byInstance = new Map(workspace?.tabs.map((tab) => [tab.tabInstanceId, tab]));
    return replaceProject(current, command.projectId, {
      ...workspace,
      tabs: command.nextTabInstanceIds.map((id) => byInstance.get(id) as ContextTab),
    });
  }
  return outcome("stale", current);
}
