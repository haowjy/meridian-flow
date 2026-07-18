/** Device-local persistence for each project's ordered context-tab desk. */

import {
  classifyFiletype,
  type DocumentFileType,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";

import type { ContextTab } from "./context-tabs-store";

export const CONTEXT_DESK_STORAGE_KEY = "meridian:context-desk";

export type PersistedProjectDesk = {
  tabs: ContextTab[];
  activeTabId: string | null;
};

type PersistedContextDesks = {
  userId: string;
  projects: Record<string, PersistedProjectDesk>;
};

export type ContextDeskStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// Typed against the contracts union so the compiler forces this table to
// track DocumentFileType — a drifted literal set here would silently reject
// whole persisted desks.
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
    return {
      kind: "new",
      documentId: tab.documentId as string,
      name: tab.name as string,
      ...(tab.draftOnly === true ? { draftOnly: true } : {}),
    };
  }
  if (
    (tab.kind !== "tracked" && tab.kind !== "viewer") ||
    !isProjectContextTreeScheme(tab.scheme) ||
    typeof tab.path !== "string" ||
    !optionalString(tab.workId)
  ) {
    return null;
  }
  if (tab.kind === "tracked" && tab.editable === true) {
    // The contracts registry is the single validator: the filetype must be a
    // known tracked type AND carry the schemaType the registry assigns it.
    const classification = classifyFiletype(typeof tab.filetype === "string" ? tab.filetype : null);
    if (
      classification.kind === "tracked" &&
      classification.schemaType === tab.schemaType &&
      (tab.provisionalName === undefined || typeof tab.provisionalName === "boolean")
    ) {
      return value as ContextTab;
    }
    return null;
  }
  if (
    tab.kind === "viewer" &&
    tab.editable === false &&
    typeof tab.fileType === "string" &&
    tab.fileType in DOCUMENT_FILE_TYPES &&
    optionalString(tab.mimeType)
  ) {
    return value as ContextTab;
  }
  return null;
}

function parseProjectDesk(value: unknown): PersistedProjectDesk | null {
  if (!value || typeof value !== "object") return null;
  const { tabs, activeTabId } = value as Partial<PersistedProjectDesk>;
  if (!Array.isArray(tabs) || (activeTabId !== null && typeof activeTabId !== "string"))
    return null;
  const parsedTabs = tabs.map(parseTab);
  if (parsedTabs.some((tab) => tab === null)) return null;
  const uniqueIds = new Set(parsedTabs.map((tab) => tab?.documentId));
  if (uniqueIds.size !== parsedTabs.length) return null;
  return { tabs: parsedTabs as ContextTab[], activeTabId: activeTabId as string | null };
}

function parsePersisted(raw: string | null): PersistedContextDesks | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { userId, projects } = value as Partial<PersistedContextDesks>;
    if (typeof userId !== "string" || !projects || typeof projects !== "object") return null;
    const validProjects: Record<string, PersistedProjectDesk> = {};
    for (const [projectId, desk] of Object.entries(projects)) {
      const parsed = parseProjectDesk(desk);
      if (parsed) validProjects[projectId] = parsed;
    }
    return { userId, projects: validProjects };
  } catch {
    return null;
  }
}

export class DeviceContextDeskStore {
  private state: PersistedContextDesks | null = null;

  constructor(private readonly storage: ContextDeskStorage) {}

  setUser(
    userId: string,
    isUntitledPending: (documentId: string) => boolean,
  ): Record<string, PersistedProjectDesk> {
    if (this.state?.userId === userId) return this.filteredProjects(isUntitledPending);
    let persisted: PersistedContextDesks | null = null;
    try {
      persisted = parsePersisted(this.storage.getItem(CONTEXT_DESK_STORAGE_KEY));
    } catch {
      // Storage may be unavailable while the rest of the workspace remains usable.
    }
    if (persisted?.userId === userId) {
      this.state = persisted;
      return this.filteredProjects(isUntitledPending);
    }
    try {
      this.storage.removeItem(CONTEXT_DESK_STORAGE_KEY);
    } catch {
      // The in-memory identity boundary still prevents a cross-user read.
    }
    this.state = { userId, projects: {} };
    return this.state.projects;
  }

  replace(
    projects: Record<string, PersistedProjectDesk>,
    isUntitledPending: (documentId: string) => boolean,
  ): void {
    if (!this.state) return;
    this.state = { ...this.state, projects };
    const persistedProjects = this.filteredProjects(isUntitledPending);
    this.state = { ...this.state, projects: persistedProjects };
    try {
      this.storage.setItem(CONTEXT_DESK_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Persistence is best-effort; the live desk remains authoritative.
    }
  }

  private filteredProjects(
    isUntitledPending: (documentId: string) => boolean,
  ): Record<string, PersistedProjectDesk> {
    const projects: Record<string, PersistedProjectDesk> = {};
    for (const [projectId, desk] of Object.entries(this.state?.projects ?? {})) {
      const tabs = desk.tabs.filter(
        (tab) => !tab.draftOnly && (tab.kind !== "new" || isUntitledPending(tab.documentId)),
      );
      projects[projectId] = {
        tabs,
        activeTabId: tabs.some((tab) => tab.documentId === desk.activeTabId)
          ? desk.activeTabId
          : null,
      };
    }
    return projects;
  }
}
