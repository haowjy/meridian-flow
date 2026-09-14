/** Pure Editor workspace transitions and browser-local restoration codec. */
import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { sameServerContextTabLocator } from "./context-tab-locator";
import {
  type ContextTab,
  isEditorContextTab,
  type ProjectTabsSlice,
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
      disposition: "applied" | "discarded";
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

function parseTab(value: unknown): ContextTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  if (
    typeof tab.tabInstanceId !== "string" ||
    typeof tab.documentId !== "string" ||
    typeof tab.name !== "string" ||
    (tab.draftOnly !== undefined && typeof tab.draftOnly !== "boolean")
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
    tab.workId === ""
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

function parseProjectDesk(value: unknown): ProjectTabsSlice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.tabs) ||
    !record.selectedTabIdByWork ||
    typeof record.selectedTabIdByWork !== "object" ||
    Array.isArray(record.selectedTabIdByWork)
  )
    return null;
  const tabs = record.tabs.map(parseTab);
  if (tabs.some((tab) => tab === null)) return null;
  const resourceIds = new Set(
    tabs.filter((tab) => tab && !isEditorContextTab(tab)).map((tab) => tab?.documentId),
  );
  const parsedTabs = (tabs as ContextTab[]).filter((tab) => !resourceIds.has(tab.documentId));
  if (parsedTabs.some((tab) => tab.draftOnly)) return null;
  const instanceIds = parsedTabs.map((tab) => tab.tabInstanceId as string);
  if (new Set(instanceIds).size !== instanceIds.length) return null;
  const selections: Record<string, string> = {};
  const byId = new Map(parsedTabs.map((tab) => [tab.documentId, tab]));
  for (const [workId, documentId] of Object.entries(record.selectedTabIdByWork)) {
    if (typeof documentId !== "string") return null;
    if (resourceIds.has(documentId)) continue;
    const tab = byId.get(documentId);
    if (!tab || !isEditorContextTab(tab)) return null;
    selections[workId] = documentId;
  }
  return { tabs: parsedTabs, selectedTabIdByWork: selections };
}

export function parseEditorWorkspace(raw: string | null): EditorWorkspaceSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.accountId !== "string" ||
      !record.projects ||
      typeof record.projects !== "object" ||
      Array.isArray(record.projects)
    )
      return null;
    const projects: Record<string, ProjectTabsSlice> = {};
    for (const [projectId, desk] of Object.entries(record.projects)) {
      const parsed = parseProjectDesk(desk);
      if (!parsed) return null;
      projects[projectId] = parsed;
    }
    return {
      version: 1,
      accountId: record.accountId,
      projects,
    };
  } catch {
    return null;
  }
}

function durableTab(tab: ContextTab): ContextTab {
  const tabInstanceId = tab.tabInstanceId ?? crypto.randomUUID();
  if (tab.kind === "new") return { ...tab, tabInstanceId };
  const {
    draftOnly: _,
    reviewWorkId: _reviewWorkId,
    reviewDraftId: _reviewDraftId,
    tabInstanceToken: _tabInstanceToken,
    ...persisted
  } = tab;
  return { ...persisted, tabInstanceId } as ContextTab;
}

function sameTabIdentity(left: ContextTab, right: ContextTab): boolean {
  const leftDraft = left.kind === "new" ? null : left;
  const rightDraft = right.kind === "new" ? null : right;
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
        left.workId === right.workId)) &&
    leftDraft?.reviewDraftId === rightDraft?.reviewDraftId &&
    leftDraft?.tabInstanceToken === rightDraft?.tabInstanceToken
  );
}

function normalizeProject(desk: ProjectTabsSlice): ProjectTabsSlice {
  const tabs = desk.tabs.filter(isEditorContextTab);
  return {
    tabs,
    selectedTabIdByWork: Object.fromEntries(
      Object.entries(desk.selectedTabIdByWork).filter(([, documentId]) => {
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
      Object.entries(projects).map(([id, desk]) => [id, normalizeProject(desk)]),
    ),
  });
}
function replaceProject(
  current: EditorWorkspaceSnapshot,
  projectId: string,
  desk: ProjectTabsSlice,
): EditorWorkspaceCommandResult {
  return committed(current, { ...current.projects, [projectId]: desk });
}

/** Total reducer for every durable desk writer class. */
export function reduceEditorWorkspace(
  current: EditorWorkspaceSnapshot,
  command: EditorWorkspaceCommand,
): EditorWorkspaceCommandResult {
  if (command.kind === "reconcile-bootstrap") {
    const desk = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const tabs = [...desk.tabs];
    let selections = { ...desk.selectedTabIdByWork };
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
      if (!change.next || change.next.draftOnly) {
        tabs.splice(index, 1);
        selections = Object.fromEntries(
          Object.entries(selections).filter(([, documentId]) => documentId !== live.documentId),
        );
        continue;
      }
      const incoming = durableTab({
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
    if (JSON.stringify(next) === JSON.stringify(desk)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "apply-availability") {
    const desk = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const tabs = desk.tabs.filter(
      (tab) => !command.removals.some((prior) => sameTabIdentity(tab, prior)),
    );
    let selections = { ...desk.selectedTabIdByWork };
    for (const update of command.updates) {
      const index = tabs.findIndex((tab) => sameTabIdentity(tab, update.prior));
      if (index < 0) continue;
      tabs[index] = durableTab({
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
    if (JSON.stringify(next) === JSON.stringify(desk)) return outcome("already-committed", current);
    return replaceProject(current, command.projectId, next);
  }
  if (command.kind === "settle-draft") {
    const desk = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const index = desk?.tabs.findIndex((tab) => sameTabIdentity(tab, command.tab)) ?? -1;
    if (command.disposition === "discarded") {
      if (index < 0) return outcome("already-committed", current);
      return replaceProject(
        current,
        command.projectId,
        normalizeProject({
          tabs: desk.tabs.filter((_tab, candidateIndex) => candidateIndex !== index),
          selectedTabIdByWork: desk.selectedTabIdByWork,
        }),
      );
    }
    if (command.tab.kind === "new") return outcome("stale", current);
    const settled = durableTab(command.tab);
    const conflicting = desk.tabs.find(
      (tab) =>
        tab.documentId === command.tab.documentId &&
        tab.tabInstanceId !== command.tab.tabInstanceId,
    );
    if (index < 0 && conflicting) return outcome("stale", current);
    const tabs =
      index < 0
        ? canonicalizeTabs([...desk.tabs, settled])
        : desk.tabs.map((candidate, candidateIndex) =>
            candidateIndex === index ? settled : candidate,
          );
    if (JSON.stringify(tabs) === JSON.stringify(desk.tabs))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, normalizeProject({ ...desk, tabs }));
  }
  if (command.kind === "reconcile-resource") {
    const desk = current.projects[command.projectId];
    const index = desk?.tabs.findIndex(
      (tab) =>
        tab.resourceHandle === command.resourceHandle || tab.documentId === command.tab.documentId,
    );
    if (!desk || index === undefined || index < 0) return outcome("not-referenced", current);
    if (
      command.tab.resourceHandle !== undefined &&
      command.tab.resourceHandle !== command.resourceHandle
    )
      return outcome("stale", current);
    const prior = desk.tabs[index] as ContextTab;
    const conflict = desk.tabs.some(
      (tab, candidateIndex) =>
        candidateIndex !== index &&
        (tab.documentId === command.tab.documentId ||
          (tab.kind !== "new" &&
            command.tab.kind !== "new" &&
            sameServerContextTabLocator(tab, command.tab))),
    );
    if (conflict) return outcome("stale", current);
    const next = durableTab({ ...command.tab, tabInstanceId: prior.tabInstanceId } as ContextTab);
    if (JSON.stringify(next) === JSON.stringify(prior))
      return outcome("already-committed", current);
    return replaceProject(current, command.projectId, {
      tabs: desk.tabs.map((tab, candidateIndex) => (candidateIndex === index ? next : tab)),
      selectedTabIdByWork: rewriteSelections(
        desk.selectedTabIdByWork,
        prior.documentId,
        next.documentId,
      ),
    });
  }
  if (command.kind === "open") {
    const desk = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    if (command.tab.draftOnly) return outcome("already-committed", current);
    const tab = durableTab(command.tab);
    const sameDocumentIndex = desk.tabs.findIndex(
      (candidate) =>
        candidate.tabInstanceId === tab.tabInstanceId || candidate.documentId === tab.documentId,
    );
    const occupiedLocatorIndex =
      tab.kind === "new"
        ? -1
        : desk.tabs.findIndex(
            (candidate) =>
              candidate.kind !== "new" &&
              candidate.documentId !== tab.documentId &&
              sameServerContextTabLocator(candidate, tab),
          );
    const index = sameDocumentIndex >= 0 ? sameDocumentIndex : occupiedLocatorIndex;
    const existing = index >= 0 ? desk.tabs[index] : undefined;
    const existingWithoutResourceOwnership = existing
      ? withoutResourceOwnership(existing)
      : undefined;
    const merged = existing
      ? ({
          ...existingWithoutResourceOwnership,
          ...tab,
          tabInstanceId: existing.tabInstanceId,
          ...(existing.kind !== "new" && existing.draftOnly
            ? {
                draftOnly: true,
                reviewWorkId: existing.reviewWorkId,
                reviewDraftId: existing.reviewDraftId,
                tabInstanceToken: existing.tabInstanceToken,
              }
            : {}),
        } as ContextTab)
      : tab;
    const tabs =
      index < 0
        ? [...desk.tabs, tab]
        : desk.tabs.map((candidate, candidateIndex) =>
            candidateIndex === index ? merged : candidate,
          );
    if (index >= 0 && JSON.stringify(tabs[index]) === JSON.stringify(desk.tabs[index]))
      return outcome("already-committed", current);
    return replaceProject(
      current,
      command.projectId,
      normalizeProject({
        ...desk,
        tabs,
        selectedTabIdByWork: rewriteSelections(
          desk.selectedTabIdByWork,
          occupiedLocatorIndex >= 0 ? desk.tabs[occupiedLocatorIndex]?.documentId : undefined,
          tab.documentId,
        ),
      }),
    );
  }
  if (command.kind === "close") {
    const desk = current.projects[command.projectId];
    const closed = desk?.tabs.find((tab) => tab.tabInstanceId === command.tabInstanceId);
    if (!desk || !closed) return outcome("stale", current);
    return replaceProject(current, command.projectId, {
      tabs: desk.tabs.filter((tab) => tab.tabInstanceId !== command.tabInstanceId),
      selectedTabIdByWork: Object.fromEntries(
        Object.entries(desk.selectedTabIdByWork).filter(([, id]) => id !== closed.documentId),
      ),
    });
  }
  if (command.kind === "select") {
    const desk = current.projects[command.projectId];
    if (!desk) return outcome("stale", current);
    const selections = { ...desk.selectedTabIdByWork };
    if (command.tabInstanceId === null) {
      if (!(command.workId in selections)) return outcome("already-committed", current);
      delete selections[command.workId];
    } else {
      const tab = desk.tabs.find((candidate) => candidate.tabInstanceId === command.tabInstanceId);
      if (!tab || !isEditorContextTab(tab)) return outcome("stale", current);
      if (selections[command.workId] === tab.documentId)
        return outcome("already-committed", current);
      selections[command.workId] = tab.documentId;
    }
    return replaceProject(current, command.projectId, { ...desk, selectedTabIdByWork: selections });
  }
  if (command.kind === "reorder") {
    const desk = current.projects[command.projectId];
    const prior = desk?.tabs.map((tab) => tab.tabInstanceId as string) ?? [];
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
    const byInstance = new Map(desk?.tabs.map((tab) => [tab.tabInstanceId, tab]));
    return replaceProject(current, command.projectId, {
      ...desk,
      tabs: command.nextTabInstanceIds.map((id) => byInstance.get(id) as ContextTab),
    });
  }
  return outcome("stale", current);
}
