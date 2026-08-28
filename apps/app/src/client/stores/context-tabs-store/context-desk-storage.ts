/** Strict V2 device-local persistence for each Project's context desk. */

import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import {
  type ContextTab,
  contextTabMayBeSelectedForWork,
  type ProjectTabsSlice,
} from "./context-tabs-store";

export const CONTEXT_DESK_STORAGE_KEY = "meridian:context-desk";
export type PersistedProjectDesk = ProjectTabsSlice;
type PersistedContextDesksV2 = {
  version: 2;
  userId: string;
  projects: Record<string, PersistedProjectDesk>;
};
export type ContextDeskStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const DOCUMENT_FILE_TYPES = {
  docx: true,
  image: true,
  pdf: true,
  binary: true,
} as const satisfies Record<DocumentFileType, true>;

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
function baseTab(value: Record<string, unknown>): boolean {
  return (
    typeof value.documentId === "string" &&
    typeof value.name === "string" &&
    (value.draftOnly === undefined || typeof value.draftOnly === "boolean")
  );
}
function parseTab(value: unknown): ContextTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  if (!baseTab(tab)) return null;
  if (tab.kind === "new") {
    if (typeof tab.workId !== "string" || tab.origin !== undefined) return null;
    return {
      kind: "new",
      documentId: tab.documentId as string,
      name: tab.name as string,
      workId: tab.workId,
      ...(tab.draftOnly === true ? { draftOnly: true } : {}),
    };
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
  if (tab.origin !== undefined) return null;
  if (
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
    "activeTabId" in record ||
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
  if (new Set(parsedTabs.map((tab) => tab.documentId)).size !== parsedTabs.length) return null;
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

function parsePersisted(raw: string | null): PersistedContextDesksV2 | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 2 ||
      typeof record.userId !== "string" ||
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
    return { version: 2, userId: record.userId, projects };
  } catch {
    return null;
  }
}

function persistedProjects(projects: Record<string, PersistedProjectDesk>) {
  const filtered: Record<string, PersistedProjectDesk> = {};
  for (const [projectId, desk] of Object.entries(projects)) {
    const tabs = desk.tabs
      .filter((tab) => !tab.draftOnly)
      .map((tab) => {
        if (tab.kind === "new" || tab.reviewWorkId === undefined) return tab;
        const { reviewWorkId: _reviewWorkId, ...persisted } = tab;
        return persisted as ContextTab;
      });
    const retained = new Set(tabs.map((tab) => tab.documentId));
    filtered[projectId] = {
      tabs,
      selectedTabIdByWork: Object.fromEntries(
        Object.entries(desk.selectedTabIdByWork).filter(([, id]) => retained.has(id)),
      ),
    };
  }
  return filtered;
}

export class DeviceContextDeskStore {
  private state: PersistedContextDesksV2 | null = null;
  constructor(private readonly storage: ContextDeskStorage) {}

  setUser(userId: string): Record<string, PersistedProjectDesk> {
    if (this.state?.userId === userId) return persistedProjects(this.state.projects);
    let persisted: PersistedContextDesksV2 | null = null;
    try {
      persisted = parsePersisted(this.storage.getItem(CONTEXT_DESK_STORAGE_KEY));
    } catch {}
    if (persisted?.userId === userId) {
      this.state = persisted;
      return persistedProjects(persisted.projects);
    }
    try {
      this.storage.removeItem(CONTEXT_DESK_STORAGE_KEY);
    } catch {}
    this.state = { version: 2, userId, projects: {} };
    return {};
  }

  replace(projects: Record<string, PersistedProjectDesk>): void {
    if (!this.state) return;
    this.state = { ...this.state, projects: persistedProjects(projects) };
    try {
      this.storage.setItem(CONTEXT_DESK_STORAGE_KEY, JSON.stringify(this.state));
    } catch {}
  }
}
