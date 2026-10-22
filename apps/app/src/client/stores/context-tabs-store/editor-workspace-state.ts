/** Pure Editor workspace transitions and browser-local restoration codec. */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isRecord } from "@/client/storage/browser-record";
import { sameServerContextTabLocator } from "./context-tab-locator";
import {
  type ContextTab,
  isDraftOnly,
  isEditorContextTab,
  matchesTabInstance,
  type ProjectTabsSlice,
  type ReviewEntries,
  reviewEntriesOf,
  reviewEntryOf,
  withoutReviewEntry,
} from "./editor-workspace-model";

export const EDITOR_WORKSPACE_STORAGE_KEY = "meridian:editor-workspace:v1";
export type EditorWorkspaceSnapshot = Readonly<{
  version: 1;
  accountId: string;
  projects: Readonly<Record<string, ProjectTabsSlice>>;
}>;

export type EditorWorkspaceCommand =
  | { kind: "open"; projectId: string; tab: ContextTab }
  | { kind: "close"; projectId: string; tabInstanceId: string }
  | { kind: "select"; projectId: string; workId: string; tabInstanceId: string | null }
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
      selections: readonly {
        workId: string;
        priorDocumentId: string | null;
        nextDocumentId: string | null;
      }[];
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
  if (!Array.isArray(value.tabs) || !isRecord(value.selectedTabIdByWork)) return null;
  const tabs = value.tabs.map(parseContextTab);
  if (tabs.some((tab) => tab === null)) return null;
  const resourceIds = new Set(
    tabs.filter((tab) => tab && !isEditorContextTab(tab)).map((tab) => tab?.documentId),
  );
  const parsedTabs = (tabs as ContextTab[]).filter((tab) => !resourceIds.has(tab.documentId));
  if (parsedTabs.some(isDraftOnly)) return null;
  const instanceIds = parsedTabs.map((tab) => tab.tabInstanceId as string);
  if (new Set(instanceIds).size !== instanceIds.length) return null;
  const selections: Record<string, string> = {};
  const byId = new Map(parsedTabs.map((tab) => [tab.documentId, tab]));
  for (const [workId, documentId] of Object.entries(value.selectedTabIdByWork)) {
    if (!workId || typeof documentId !== "string") return null;
    if (resourceIds.has(documentId)) continue;
    const tab = byId.get(documentId);
    if (!tab || !isEditorContextTab(tab)) return null;
    selections[workId] = documentId;
  }
  return { tabs: parsedTabs, selectedTabIdByWork: selections };
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

function sameTabIdentity(left: ContextTab, right: ContextTab): boolean {
  return (
    left.tabInstanceId === right.tabInstanceId &&
    left.documentId === right.documentId &&
    left.kind === right.kind &&
    (left.kind !== "new" ||
      (right.kind === "new" && left.resourceHandle === right.resourceHandle)) &&
    (left.kind === "new" ||
      (right.kind !== "new" &&
        left.scheme === right.scheme &&
        left.path === right.path &&
        left.workId === right.workId &&
        left.rootThreadId === right.rootThreadId &&
        left.chatId === right.chatId))
  );
}

function normalizeProject(workspace: ProjectTabsSlice): ProjectTabsSlice {
  const tabs = workspace.tabs.filter(isEditorContextTab);
  return {
    tabs,
    selectedTabIdByWork: Object.fromEntries(
      Object.entries(workspace.selectedTabIdByWork).filter(([, documentId]) => {
        const tab = tabs.find((candidate) => candidate.documentId === documentId);
        return tab && isEditorContextTab(tab);
      }),
    ),
  };
}

function rewriteSelections(
  selections: Record<string, string>,
  from: string | undefined,
  to: string,
): Record<string, string> {
  if (!from || from === to) return selections;
  return Object.fromEntries(
    Object.entries(selections).map(([workId, documentId]) => [
      workId,
      documentId === from ? to : documentId,
    ]),
  );
}

function canonicalizeTabs(tabs: readonly ContextTab[]): ContextTab[] {
  const canonical: ContextTab[] = [];
  for (const tab of tabs) {
    const index = canonical.findIndex(
      (candidate) =>
        candidate.documentId === tab.documentId ||
        (candidate.kind !== "new" &&
          tab.kind !== "new" &&
          sameServerContextTabLocator(candidate, tab)),
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
function committed(
  current: EditorWorkspaceSnapshot,
  projects: Readonly<Record<string, ProjectTabsSlice>>,
): EditorWorkspaceCommandResult {
  return outcome("committed", {
    ...current,
    projects: Object.fromEntries(
      Object.entries(projects).map(([id, workspace]) => [id, normalizeProject(workspace)]),
    ),
  });
}
function replaceProject(
  current: EditorWorkspaceSnapshot,
  projectId: string,
  workspace: ProjectTabsSlice,
): EditorWorkspaceCommandResult {
  return committed(current, { ...current.projects, [projectId]: workspace });
}

/** Total reducer for every durable workspace writer class. */
export function reduceEditorWorkspace(
  current: EditorWorkspaceSnapshot,
  command: EditorWorkspaceCommand,
): EditorWorkspaceCommandResult {
  if (command.kind === "reconcile-bootstrap") {
    const workspace = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const tabs = [...workspace.tabs];
    let selections = { ...workspace.selectedTabIdByWork };
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
        selections = Object.fromEntries(
          Object.entries(selections).filter(([, documentId]) => documentId !== live.documentId),
        );
        continue;
      }
      const incoming = durableContextTab({
        ...change.next,
        tabInstanceId: live.tabInstanceId,
      } as ContextTab);
      const conflictIndex = tabs.findIndex(
        (tab, candidateIndex) =>
          candidateIndex !== index &&
          (tab.documentId === incoming.documentId ||
            (tab.resourceHandle !== undefined && tab.resourceHandle === incoming.resourceHandle) ||
            (tab.kind !== "new" &&
              incoming.kind !== "new" &&
              sameServerContextTabLocator(tab, incoming))),
      );
      if (conflictIndex >= 0) {
        const winner = tabs[conflictIndex] as ContextTab;
        tabs.splice(index, 1);
        selections = rewriteSelections(selections, live.documentId, winner.documentId);
        continue;
      }
      tabs[index] = incoming;
      selections = rewriteSelections(selections, live.documentId, incoming.documentId);
    }
    const next = normalizeProject({ tabs, selectedTabIdByWork: selections });
    if (JSON.stringify(next) === JSON.stringify(workspace))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "apply-availability") {
    const workspace = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const tabs = workspace.tabs.filter(
      (tab) => !command.removals.some((prior) => sameTabIdentity(tab, prior)),
    );
    let selections = { ...workspace.selectedTabIdByWork };
    for (const update of command.updates) {
      const index = tabs.findIndex((tab) => sameTabIdentity(tab, update.prior));
      if (index < 0) continue;
      tabs[index] = durableContextTab({
        ...update.next,
        tabInstanceId: tabs[index]?.tabInstanceId,
      } as ContextTab);
      selections = rewriteSelections(selections, update.prior.documentId, update.next.documentId);
    }
    for (const selection of command.selections) {
      if ((selections[selection.workId] ?? null) !== selection.priorDocumentId) continue;
      if (selection.nextDocumentId === null) delete selections[selection.workId];
      else selections[selection.workId] = selection.nextDocumentId;
    }
    const next = normalizeProject({
      tabs: canonicalizeTabs(tabs),
      selectedTabIdByWork: selections,
    });
    if (JSON.stringify(next) === JSON.stringify(workspace))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "settle-draft") {
    // The draft's document is live now: the same tab drops its review metadata in place.
    const workspace = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const index = workspace.tabs.findIndex((tab) => matchesTabInstance(tab, command.tab));
    const prior = workspace.tabs[index];
    if (!prior) return outcome("stale", current);
    if (prior.kind === "new" || !isDraftOnly(prior)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      ...workspace,
      tabs: workspace.tabs.map((tab, candidateIndex) =>
        candidateIndex === index ? durableContextTab(prior) : tab,
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
    const selections = Object.fromEntries(
      Object.entries(workspace.selectedTabIdByWork).filter(
        ([workId, documentId]) =>
          documentId !== tab.documentId || (after !== null && workId !== command.workId),
      ),
    );
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs.flatMap((candidate) =>
        candidate !== tab ? [candidate] : after ? [after] : [],
      ),
      selectedTabIdByWork: selections,
    });
  }
  if (command.kind === "reconcile-resource") {
    const workspace = current.projects[command.projectId];
    if (!workspace) return outcome("not-referenced", current);
    const byHandle = workspace.tabs.findIndex(
      (tab) => tab.resourceHandle === command.resourceHandle,
    );
    const index =
      byHandle >= 0
        ? byHandle
        : workspace.tabs.findIndex((tab) => tab.documentId === command.tab.documentId);
    if (index < 0) return outcome("not-referenced", current);
    if (
      command.tab.resourceHandle !== undefined &&
      command.tab.resourceHandle !== command.resourceHandle
    )
      return outcome("stale", current);
    const prior = workspace.tabs[index] as ContextTab;
    const conflicts = workspace.tabs.filter(
      (tab, candidateIndex) =>
        candidateIndex !== index &&
        (tab.documentId === command.tab.documentId ||
          (tab.kind !== "new" &&
            command.tab.kind !== "new" &&
            sameServerContextTabLocator(tab, command.tab))),
    );
    // The join re-identifies one document: whatever other tab already shows
    // that document (the draft-only tab, or its promoted successor) is the same
    // document, so the resource's tab absorbs it.
    const absorbed = conflicts.filter((tab) => tab.documentId === command.tab.documentId);
    if (conflicts.length > absorbed.length) return outcome("stale", current);
    const next = durableContextTab({
      ...command.tab,
      tabInstanceId: prior.tabInstanceId,
    } as ContextTab);
    if (absorbed.length === 0 && JSON.stringify(next) === JSON.stringify(prior))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs
        .filter((tab) => !absorbed.includes(tab))
        .map((tab) => (tab === prior ? next : tab)),
      selectedTabIdByWork: rewriteSelections(
        workspace.selectedTabIdByWork,
        prior.documentId,
        next.documentId,
      ),
    });
  }
  if (command.kind === "open") {
    const workspace = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    // A draft-only tab keeps its review metadata while it is the document's one tab.
    const incoming = isDraftOnly(command.tab)
      ? ({
          ...command.tab,
          tabInstanceId: command.tab.tabInstanceId ?? crypto.randomUUID(),
        } as ContextTab)
      : durableContextTab(command.tab);
    const sameDocumentIndex = workspace.tabs.findIndex(
      (candidate) =>
        candidate.tabInstanceId === incoming.tabInstanceId ||
        candidate.documentId === incoming.documentId,
    );
    const sameDocument = sameDocumentIndex >= 0 ? workspace.tabs[sameDocumentIndex] : undefined;
    // A review launch never turns an ordinary tab back into a draft-only one.
    const tab =
      isDraftOnly(incoming) && sameDocument && !isDraftOnly(sameDocument)
        ? durableContextTab(incoming)
        : incoming;
    const occupiedLocatorIndex =
      tab.kind === "new"
        ? -1
        : workspace.tabs.findIndex(
            (candidate) =>
              candidate.kind !== "new" &&
              !isDraftOnly(candidate) &&
              candidate.documentId !== tab.documentId &&
              sameServerContextTabLocator(candidate, tab),
          );
    const index = sameDocumentIndex >= 0 ? sameDocumentIndex : occupiedLocatorIndex;
    const existing = index >= 0 ? workspace.tabs[index] : undefined;
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
    if (index >= 0 && JSON.stringify(tabs[index]) === JSON.stringify(workspace.tabs[index]))
      return outcome("already-committed", current);
    return replaceProject(
      current,
      command.projectId,
      normalizeProject({
        ...workspace,
        tabs,
        selectedTabIdByWork: rewriteSelections(
          workspace.selectedTabIdByWork,
          occupiedLocatorIndex >= 0 ? workspace.tabs[occupiedLocatorIndex]?.documentId : undefined,
          tab.documentId,
        ),
      }),
    );
  }
  if (command.kind === "close") {
    const workspace = current.projects[command.projectId];
    const closed = workspace?.tabs.find((tab) => tab.tabInstanceId === command.tabInstanceId);
    if (!workspace || !closed) return outcome("stale", current);
    return replaceProject(current, command.projectId, {
      tabs: workspace.tabs.filter((tab) => tab.tabInstanceId !== command.tabInstanceId),
      selectedTabIdByWork: Object.fromEntries(
        Object.entries(workspace.selectedTabIdByWork).filter(([, id]) => id !== closed.documentId),
      ),
    });
  }
  if (command.kind === "select") {
    const workspace = current.projects[command.projectId];
    if (!workspace) return outcome("stale", current);
    const selections = { ...workspace.selectedTabIdByWork };
    if (command.tabInstanceId === null) {
      if (!(command.workId in selections)) return outcome("already-committed", current);
      delete selections[command.workId];
    } else {
      const tab = workspace.tabs.find(
        (candidate) => candidate.tabInstanceId === command.tabInstanceId,
      );
      if (!tab || !isEditorContextTab(tab)) return outcome("stale", current);
      if (selections[command.workId] === tab.documentId)
        return outcome("already-committed", current);
      selections[command.workId] = tab.documentId;
    }
    return replaceProject(current, command.projectId, {
      ...workspace,
      selectedTabIdByWork: selections,
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
