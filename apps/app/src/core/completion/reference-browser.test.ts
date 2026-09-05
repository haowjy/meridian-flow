import type {
  CatalogAuthorityEntry,
  CatalogEntry,
  CatalogScope,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import {
  type CatalogCacheView,
  catalogViewFromSnapshot,
} from "@/client/query/context-catalog-cache";

import { createReferenceBrowserController, type ReferenceCatalogPort } from "./reference-browser";
import type { ReferenceRow } from "./reference-policy";

const project = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const user = { kind: "user", userId: "user-1" } as const satisfies CatalogScope;
const currentWork = {
  kind: "work",
  projectId: "project-1",
  workId: "work-current",
} as const satisfies CatalogScope;
const otherWork = {
  kind: "work",
  projectId: "project-1",
  workId: "work-other",
} as const satisfies CatalogScope;
const noWork = { kind: "none", projectId: "project-1" } as const satisfies CatalogScope;

function authority(workId: string, workSlug: string, name: string): CatalogAuthorityEntry {
  const decodedSlug = decodeWorkSlug(workSlug);
  if (!decodedSlug) throw new Error(`invalid fixture Work slug: ${workSlug}`);
  return {
    kind: "authority",
    entryId: workId,
    scope: project,
    authority: { kind: "work", workId, workSlug: decodedSlug },
    name,
    available: true,
    entityRevision: "1",
  };
}

function source(scope: CatalogScope, entryId: string, scheme: "manuscript" | "user" | "scratch") {
  const qualifier =
    scope.kind === "work"
      ? `@${scope.workId === "work-current" ? "current-draft" : "revision-pass"}/`
      : scope.kind === "none"
        ? "@/"
        : "";
  return {
    kind: "source" as const,
    entryId,
    scope,
    scheme,
    name: scheme === "scratch" ? "Scratch" : scheme === "user" ? "Library" : "Manuscript",
    uri: `${scheme}://${qualifier}`,
  };
}

function file(
  scope: CatalogScope,
  sourceId: string,
  entryId: string,
  name: string,
  parentId = sourceId,
): CatalogEntry {
  const scheme =
    scope.kind === "project" ? "manuscript" : scope.kind === "user" ? "user" : "scratch";
  const qualifier =
    scope.kind === "work"
      ? `@${scope.workId === "work-current" ? "current-draft" : "revision-pass"}/`
      : scope.kind === "none"
        ? "@/"
        : "";
  return {
    kind: "file",
    entryId,
    scope,
    sourceId,
    parentId,
    name,
    aliases: [],
    path: parentId === sourceId ? [name] : ["Folder", name],
    uri: `${scheme}://${qualifier}${parentId === sourceId ? name : `Folder/${name}`}`,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

function view(scope: CatalogScope, entries: CatalogEntry[]): CatalogCacheView {
  return catalogViewFromSnapshot({
    scope,
    generation: "generation-1",
    headRevision: "1",
    cursor: "cursor-1",
    entries,
  });
}

function fixtureViews(): Map<string, CatalogCacheView> {
  const projectSource = source(project, "source-project", "manuscript");
  const userSource = source(user, "source-user", "user");
  const currentSource = source(currentWork, "source-current", "scratch");
  const otherSource = source(otherWork, "source-other", "scratch");
  const noneSource = source(noWork, "source-none", "scratch");
  return new Map([
    [
      catalogScopeKey(project),
      view(project, [
        authority("work-current", "current-draft", "Current draft"),
        authority("work-other", "revision-pass", "Revision pass"),
        projectSource,
        file(project, projectSource.entryId, "project-chapter", "Project Chapter.md"),
      ]),
    ],
    [
      catalogScopeKey(user),
      view(user, [userSource, file(user, userSource.entryId, "user-chapter", "User Chapter.md")]),
    ],
    [
      catalogScopeKey(currentWork),
      view(currentWork, [
        currentSource,
        file(currentWork, currentSource.entryId, "current-chapter", "Current Chapter.md"),
      ]),
    ],
    [
      catalogScopeKey(otherWork),
      view(otherWork, [
        otherSource,
        {
          kind: "folder",
          entryId: "other-folder",
          scope: otherWork,
          sourceId: otherSource.entryId,
          parentId: otherSource.entryId,
          name: "Folder",
          path: ["Folder"],
          uri: "scratch://@revision-pass/Folder",
          hasChildren: true,
        },
        file(otherWork, otherSource.entryId, "other-chapter", "Other Chapter.md"),
      ]),
    ],
    [
      catalogScopeKey(noWork),
      view(noWork, [
        noneSource,
        file(noWork, noneSource.entryId, "none-chapter", "Loose Chapter.md"),
      ]),
    ],
  ]);
}

function createRig(overrides: { acquire?: ReferenceCatalogPort["acquire"] } = {}) {
  const views = fixtureViews();
  const selected: ReferenceRow[] = [];
  const completed: string[] = [];
  const dismissed = vi.fn();
  let openContext = { warmScopes: [project, user, currentWork] as readonly CatalogScope[] };
  const catalog: ReferenceCatalogPort = {
    read: (scope) => views.get(catalogScopeKey(scope)) ?? null,
    acquire:
      overrides.acquire ??
      (async (scope) => {
        const installed = views.get(catalogScopeKey(scope));
        if (!installed) throw new Error("missing fixture view");
        return installed;
      }),
  };
  const controller = createReferenceBrowserController({
    catalog,
    openContext: () => openContext,
    label: () => "References",
    onSelect: ({ row }) => selected.push(row),
    onCompleteSegment: ({ prefix }) => completed.push(prefix),
  });
  const start = (input: {
    warmScopes: readonly CatalogScope[];
    query: string;
    triggerRange: { from: number; to: number };
  }) => {
    openContext = { warmScopes: input.warmScopes };
    controller.start({
      query: input.query,
      text: `@${input.query}`,
      triggerRange: input.triggerRange,
      candidates: [],
      anchorRect: () => null,
      loading: false,
      requestExit: () => {
        dismissed();
        controller.exit();
      },
    });
  };
  return {
    views,
    catalog,
    controller,
    menu: controller.menu,
    start,
    selected,
    completed,
    dismissed,
  };
}

function fileIds(rows: readonly ReferenceRow[]): string[] {
  return rows.flatMap((row) => (row.kind === "file" ? [row.action.reference.documentId] : []));
}

describe("reference browser root and hierarchy", () => {
  it("merges project, user, and current Work warm rows while excluding every other Work file", () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "chapter",
      triggerRange: { from: 4, to: 12 },
    });
    const state = rig.controller.state();
    expect(state.kind).toBe("root");
    if (state.kind !== "root") return;
    expect(fileIds(state.rows)).toEqual(["project-chapter", "user-chapter", "current-chapter"]);
    expect(fileIds(state.rows)).not.toContain("other-chapter");
    const current = state.rows.find(
      (row) => row.kind === "file" && row.action.reference.documentId === "current-chapter",
    );
    expect(current).toMatchObject({
      action: {
        reference: {
          uri: "scratch://@current-draft/Current Chapter.md",
          authority: { kind: "work", workSlug: "current-draft" },
        },
      },
    });
  });

  it("uses explicit no-Work as the current authority instead of leaking a Work", () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, noWork],
      query: "chapter",
      triggerRange: { from: 0, to: 1 },
    });
    const state = rig.controller.state();
    if (state.kind !== "root") throw new Error("expected root");
    expect(fileIds(state.rows)).toEqual(["project-chapter", "user-chapter", "none-chapter"]);
    expect(state.rows).toContainEqual(
      expect.objectContaining({
        action: expect.objectContaining({
          reference: expect.objectContaining({ uri: "scratch://@/Loose Chapter.md" }),
        }),
      }),
    );
  });

  it("drills an authority and source, then backtracks exactly one level at a time", async () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "",
      triggerRange: { from: 0, to: 1 },
    });
    rig.menu.setActiveId("authority:work-other");
    expect(rig.menu.chooseActive("enter")).toBe(true);
    await Promise.resolve();
    let state = rig.controller.state();
    expect(state).toMatchObject({ kind: "drilled", activeScope: otherWork });
    if (state.kind !== "drilled") return;
    expect(state.rows.map((row) => row.kind)).toEqual(["source"]);

    rig.menu.setActiveId(state.rows[0]?.rowId ?? "");
    rig.menu.chooseActive("enter");
    state = rig.controller.state();
    if (state.kind !== "drilled") return;
    expect(state.rows.map((row) => row.kind)).toEqual(["folder", "file"]);
    expect(rig.menu.backtrack()).toBe(true);
    const authorityState = rig.controller.state();
    expect(authorityState.kind).toBe("drilled");
    expect("containerId" in authorityState).toBe(false);
    expect(rig.menu.backtrack()).toBe(true);
    expect(rig.controller.state().kind).toBe("root");
    expect(rig.menu.backtrack()).toBe(false);
    rig.menu.dismiss();
    expect(rig.dismissed).toHaveBeenCalledTimes(1);
    expect(rig.controller.state()).toEqual({ kind: "closed" });
  });
});

describe("reference browser actions and freshness", () => {
  it("Tab completes one navigable URI segment and keeps the browser open", async () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "revision-pass",
      triggerRange: { from: 0, to: 14 },
    });
    expect(rig.menu.chooseActive("tab")).toBe(true);
    await Promise.resolve();
    expect(rig.completed).toEqual(["@revision-pass/"]);
    expect(rig.controller.state()).toMatchObject({
      kind: "drilled",
      completedPrefix: "@revision-pass/",
    });
    const beforeEcho = rig.controller.state();
    const generation = beforeEcho.kind === "closed" ? -1 : beforeEcho.generation;
    rig.controller.update({
      query: "@revision-pass/",
      text: "@revision-pass/",
      triggerRange: { from: 0, to: 15 },
      candidates: [],
      anchorRect: () => null,
      loading: false,
      requestExit: () => rig.controller.exit(),
    });
    expect(rig.controller.state()).toMatchObject({ kind: "drilled", generation });
    expect(rig.menu.snapshot().open).toBe(true);
    expect(rig.selected).toEqual([]);
  });

  it.each(["enter", "tab"] as const)("selects one terminal exactly once for %s", (action) => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "Project Chapter.md",
      triggerRange: { from: 0, to: 19 },
    });
    expect(rig.menu.chooseActive(action)).toBe(true);
    expect(rig.menu.chooseActive(action)).toBe(false);
    expect(rig.selected).toHaveLength(1);
    expect(rig.controller.state()).toEqual({ kind: "closed" });
  });

  it("preserves active stable identity across metadata refresh", () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "chapter",
      triggerRange: { from: 0, to: 1 },
    });
    rig.menu.setActiveId("file:user-chapter");
    const userView = rig.views.get(catalogScopeKey(user));
    if (!userView) throw new Error("missing user view");
    const renamed = [...userView.entries.values()].map((entry) =>
      entry.kind === "file" ? { ...entry, name: "User Chapter revised.md" } : entry,
    );
    rig.views.set(catalogScopeKey(user), view(user, renamed));
    expect(rig.controller.refresh()).toBe(true);
    expect(rig.menu.snapshot().activeId).toBe("file:user-chapter");
  });

  it("falls back when the active stable row disappears on refresh", () => {
    const rig = createRig();
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "chapter",
      triggerRange: { from: 0, to: 8 },
    });
    rig.menu.setActiveId("file:user-chapter");
    rig.views.delete(catalogScopeKey(user));
    expect(rig.controller.refresh()).toBe(true);
    expect(rig.menu.snapshot().activeId).toBe("file:project-chapter");
  });

  it("aborts and generation-fences a stale authority acquisition", async () => {
    let resolve!: (view: CatalogCacheView) => void;
    const observedSignals: AbortSignal[] = [];
    const pending = new Promise<CatalogCacheView>((done) => {
      resolve = done;
    });
    const rig = createRig({
      acquire: async (_scope, signal) => {
        observedSignals.push(signal);
        return pending;
      },
    });
    rig.start({
      warmScopes: [project, user, currentWork],
      query: "revision",
      triggerRange: { from: 0, to: 9 },
    });
    rig.menu.chooseActive("enter");
    expect(rig.controller.state()).toMatchObject({ kind: "drilled", incomplete: true });
    expect(rig.menu.snapshot().items.map((row) => row.kind)).toEqual(["source"]);
    expect(rig.menu.backtrack()).toBe(true);
    expect(observedSignals[0]?.aborted).toBe(true);
    const other = rig.views.get(catalogScopeKey(otherWork));
    if (!other) throw new Error("missing other Work view");
    resolve(other);
    await pending;
    await Promise.resolve();
    expect(rig.controller.state().kind).toBe("root");
    expect(fileIds(rig.menu.snapshot().items)).not.toContain("other-chapter");
  });
});
