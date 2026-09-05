/** Closed, Web-Lock serialized commands for the device Context desk. */
import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { sameServerContextTabLocator } from "./context-tab-locator";
import {
  type ContextTab,
  contextTabMayBeSelectedForWork,
  type ProjectTabsSlice,
} from "./context-tabs-store";

export const CONTEXT_DESK_STORAGE_KEY = "meridian:context-desk";
export type PersistedProjectDesk = ProjectTabsSlice;
export type DeviceContextDeskV3 = Readonly<{
  version: 3;
  accountId: string;
  deskRevision: number;
  projects: Readonly<Record<string, PersistedProjectDesk>>;
}>;
export type ContextDeskStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type DeviceContextDeskCommand =
  | { kind: "install-local"; projectId: string; expectedDeskRevision: number; tab: ContextTab }
  | { kind: "open"; projectId: string; tab: ContextTab }
  | { kind: "close"; projectId: string; tabInstanceId: string }
  | { kind: "select"; projectId: string; workId: string; tabInstanceId: string | null }
  | {
      kind: "reorder";
      projectId: string;
      expectedTabInstanceIds: readonly string[];
      nextTabInstanceIds: readonly string[];
    }
  | {
      kind: "reconcile-bootstrap";
      projectId: string;
      priorTabs: readonly ContextTab[];
      nextTabs: readonly ContextTab[];
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
    }
  | {
      kind: "publish-remint";
      lineageHandle: string;
      minimumIdentityRevision: number;
      documentId: string;
    }
  | {
      kind: "publish-adoption";
      lineageHandle: string;
      adoptionRevision: number;
      trackedTab: ContextTab;
    }
  | { kind: "reset-account"; expectedAccountId: string; nextAccountId: string };

export type DeviceContextDeskCommandResult =
  | { kind: "committed" | "already-committed"; deskRevision: number; snapshot: DeviceContextDeskV3 }
  | { kind: "stale" | "not-referenced"; deskRevision: number; snapshot: DeviceContextDeskV3 };

type LockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>,
  ): Promise<T>;
};
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
    if (
      typeof tab.workId !== "string" ||
      typeof tab.lineageHandle !== "string" ||
      !Number.isSafeInteger(tab.identityRevision) ||
      tab.origin !== undefined
    )
      return null;
    return value as ContextTab;
  }
  if (
    (tab.kind !== "tracked" && tab.kind !== "viewer") ||
    !isProjectContextTreeScheme(tab.scheme) ||
    typeof tab.path !== "string" ||
    tab.path.length === 0 ||
    !optionalString(tab.workId) ||
    (isWorkScopedProjectContextScheme(tab.scheme) &&
      (typeof tab.workId !== "string" || tab.workId.length === 0))
  )
    return null;
  if (tab.kind === "tracked" && tab.editable === true) {
    const classification = classifyFiletype(typeof tab.filetype === "string" ? tab.filetype : null);
    if (
      classification.kind !== "tracked" ||
      classification.schemaType !== tab.schemaType ||
      (tab.provisionalName !== undefined && typeof tab.provisionalName !== "boolean") ||
      (tab.origin !== undefined && tab.origin !== "local-untitled")
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
    optionalString(tab.mimeType)
  )
    return value as ContextTab;
  return null;
}

function parseProjectDesk(value: unknown): PersistedProjectDesk | null {
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
  const parsedTabs = tabs as ContextTab[];
  if (parsedTabs.some((tab) => tab.draftOnly)) return null;
  const instanceIds = parsedTabs.map((tab) => tab.tabInstanceId as string);
  if (new Set(instanceIds).size !== instanceIds.length) return null;
  const selections: Record<string, string> = {};
  const byId = new Map(parsedTabs.map((tab) => [tab.documentId, tab]));
  for (const [workId, documentId] of Object.entries(record.selectedTabIdByWork)) {
    if (typeof documentId !== "string") return null;
    const tab = byId.get(documentId);
    if (!tab || !contextTabMayBeSelectedForWork(tab, workId)) return null;
    selections[workId] = documentId;
  }
  return { tabs: parsedTabs, selectedTabIdByWork: selections };
}

export function parseContextDesk(raw: string | null): DeviceContextDeskV3 | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 3 ||
      typeof record.accountId !== "string" ||
      !Number.isSafeInteger(record.deskRevision) ||
      !record.projects ||
      typeof record.projects !== "object" ||
      Array.isArray(record.projects)
    )
      return null;
    const projects: Record<string, PersistedProjectDesk> = {};
    for (const [projectId, desk] of Object.entries(record.projects)) {
      const parsed = parseProjectDesk(desk);
      if (!parsed) return null;
      projects[projectId] = parsed;
    }
    return {
      version: 3,
      accountId: record.accountId,
      deskRevision: record.deskRevision as number,
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
      (right.kind === "new" &&
        left.lineageHandle === right.lineageHandle &&
        left.identityRevision === right.identityRevision)) &&
    (left.kind === "new" ||
      (right.kind !== "new" &&
        left.scheme === right.scheme &&
        left.path === right.path &&
        left.workId === right.workId)) &&
    leftDraft?.reviewDraftId === rightDraft?.reviewDraftId &&
    leftDraft?.tabInstanceToken === rightDraft?.tabInstanceToken
  );
}

function normalizeProject(desk: PersistedProjectDesk): PersistedProjectDesk {
  return {
    ...desk,
    selectedTabIdByWork: Object.fromEntries(
      Object.entries(desk.selectedTabIdByWork).filter(([workId, documentId]) => {
        const tab = desk.tabs.find((candidate) => candidate.documentId === documentId);
        return tab && contextTabMayBeSelectedForWork(tab, workId);
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
  kind: DeviceContextDeskCommandResult["kind"],
  snapshot: DeviceContextDeskV3,
): DeviceContextDeskCommandResult {
  return { kind, deskRevision: snapshot.deskRevision, snapshot };
}
function committed(
  current: DeviceContextDeskV3,
  projects: Readonly<Record<string, PersistedProjectDesk>>,
): DeviceContextDeskCommandResult {
  return outcome("committed", { ...current, deskRevision: current.deskRevision + 1, projects });
}
function replaceProject(
  current: DeviceContextDeskV3,
  projectId: string,
  desk: PersistedProjectDesk,
): DeviceContextDeskCommandResult {
  return committed(current, { ...current.projects, [projectId]: normalizeProject(desk) });
}

/** Total reducer for every durable desk writer class. */
export function reduceContextDesk(
  current: DeviceContextDeskV3,
  command: DeviceContextDeskCommand,
): DeviceContextDeskCommandResult {
  if (command.kind === "reset-account") {
    if (current.accountId === command.nextAccountId) return outcome("already-committed", current);
    if (current.accountId !== command.expectedAccountId) return outcome("stale", current);
    return outcome("committed", {
      version: 3,
      accountId: command.nextAccountId,
      deskRevision: current.deskRevision + 1,
      projects: {},
    });
  }
  if (command.kind === "reconcile-bootstrap") {
    const desk = current.projects[command.projectId] ?? { tabs: [], selectedTabIdByWork: {} };
    const retained = desk.tabs.filter(
      (tab) => !command.priorTabs.some((prior) => sameTabIdentity(tab, prior)),
    );
    const tabs = [...retained];
    for (const incoming of command.nextTabs.filter((tab) => !tab.draftOnly).map(durableTab)) {
      const index = tabs.findIndex(
        (tab) =>
          tab.tabInstanceId === incoming.tabInstanceId || tab.documentId === incoming.documentId,
      );
      if (index < 0) tabs.push(incoming);
      else tabs[index] = { ...tabs[index], ...incoming } as ContextTab;
    }
    const next = normalizeProject({ tabs, selectedTabIdByWork: desk.selectedTabIdByWork });
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
  if (command.kind === "install-local" || command.kind === "open") {
    if (command.kind === "install-local" && current.deskRevision < command.expectedDeskRevision)
      return outcome("stale", current);
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
    const merged = existing
      ? ({
          ...existing,
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
      if (!tab || !contextTabMayBeSelectedForWork(tab, command.workId))
        return outcome("stale", current);
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

  let referenced = false;
  let changed = false;
  const projects = Object.fromEntries(
    Object.entries(current.projects).map(([projectId, desk]) => {
      const replacements = new Map<string, string>();
      const tabs = desk.tabs.map((tab) => {
        if (tab.kind !== "new" || tab.lineageHandle !== command.lineageHandle) return tab;
        referenced = true;
        if (command.kind === "publish-remint") {
          if (
            (tab.identityRevision ?? 0) >= command.minimumIdentityRevision &&
            tab.documentId === command.documentId
          )
            return tab;
          changed = true;
          replacements.set(tab.documentId, command.documentId);
          return {
            ...tab,
            documentId: command.documentId,
            identityRevision: command.minimumIdentityRevision,
          };
        }
        changed = true;
        replacements.set(tab.documentId, command.trackedTab.documentId);
        return { ...durableTab(command.trackedTab), tabInstanceId: tab.tabInstanceId };
      });
      const selectedTabIdByWork = Object.fromEntries(
        Object.entries(desk.selectedTabIdByWork).map(([workId, documentId]) => [
          workId,
          replacements.get(documentId) ?? documentId,
        ]),
      );
      return [projectId, replacements.size ? { tabs, selectedTabIdByWork } : desk];
    }),
  );
  if (!referenced) return outcome("not-referenced", current);
  if (!changed) return outcome("already-committed", current);
  return committed(current, projects);
}

function nativeLocks(): LockManager | null {
  return typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks as unknown as LockManager)
    : null;
}
export class DeviceContextDeskLedger {
  private state: DeviceContextDeskV3;
  private serial = Promise.resolve();
  constructor(
    private readonly storage: ContextDeskStorage,
    readonly accountId: string,
    private readonly locks: LockManager | null = nativeLocks(),
  ) {
    const persisted = parseContextDesk(storage.getItem(CONTEXT_DESK_STORAGE_KEY));
    this.state =
      persisted?.accountId === accountId
        ? persisted
        : { version: 3, accountId, deskRevision: 0, projects: {} };
  }
  snapshot(): DeviceContextDeskV3 {
    return this.state;
  }
  project(raw: string | null): DeviceContextDeskV3 | null {
    const persisted = parseContextDesk(raw);
    if (
      persisted?.accountId !== this.accountId ||
      persisted.deskRevision <= this.state.deskRevision
    )
      return null;
    this.state = persisted;
    return persisted;
  }
  apply(command: DeviceContextDeskCommand): Promise<DeviceContextDeskCommandResult> {
    const execute = async () => {
      const persisted = parseContextDesk(this.storage.getItem(CONTEXT_DESK_STORAGE_KEY));
      if (
        command.kind !== "reset-account" &&
        persisted !== null &&
        persisted.accountId !== this.accountId
      )
        return outcome("stale", persisted);
      const current = persisted ?? this.state;
      const reduced = reduceContextDesk(current, command);
      if (reduced.kind === "committed") {
        this.storage.setItem(CONTEXT_DESK_STORAGE_KEY, JSON.stringify(reduced.snapshot));
        this.state = reduced.snapshot;
        return reduced;
      } else if (
        reduced.snapshot.accountId === this.accountId &&
        reduced.deskRevision > this.state.deskRevision
      )
        this.state = reduced.snapshot;
      return reduced;
    };
    const lockAccount =
      command.kind === "reset-account" ? command.expectedAccountId : this.accountId;
    if (this.locks)
      return this.locks.request(
        `meridian:f1j:v2:context-desk/${encodeURIComponent(lockAccount)}`,
        { mode: "exclusive" },
        execute,
      );
    const applied = this.serial.then(execute, execute);
    this.serial = applied.then(
      () => undefined,
      () => undefined,
    );
    return applied;
  }
}
