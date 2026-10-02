/**
 * No Work has one Editor identity: however the Editor was reached (seeded from
 * a No Work chat, which is bound to the No Work row, or opened with no Work),
 * it is No Work (`null`), address repair cannot flip it, and a No Work Scratch
 * tab stays in its strip.
 */
import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";

import { isEditorTab } from "@/client/stores/context-tabs-store/editor-workspace-model";
import type { ProjectAddress } from "./project-address";
import { workIdSelection } from "./project-address";
import { guardProjectQuerySelections } from "./project-address-resolution";
import type { RouteWorkResolution } from "./project-route";
import { resolveRouteWork, type WorkCatalog } from "./work-route";

const PROJECT = "550e8400-e29b-41d4-a716-446655440000";
const NO_WORK = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
if (!NO_WORK) throw new Error("Invalid fixture");

const catalog: WorkCatalog = {
  status: "ready",
  entries: [],
  creations: new Map(),
  isFetching: false,
  noWorkId: NO_WORK,
};

const editorWorkId = (route: RouteWorkResolution) =>
  route.status === "present" ? route.workId : null;

/** A No Work Scratch tab, as the address admission installs it. */
const scratchTab = { kind: "tracked" as const, scheme: "scratch" as const };

describe("No Work in the Editor", () => {
  it("is one identity from a No Work chat's seed and from no Work at all", () => {
    expect(editorWorkId(resolveRouteWork(workIdSelection(NO_WORK), catalog))).toBeNull();
    expect(editorWorkId(resolveRouteWork({ kind: "absent" }, catalog))).toBeNull();
  });

  it("opens a manuscript document at an address repair leaves alone, and keeps its Scratch tab", () => {
    // From a No Work chat: the Editor seed is the No Work row.
    const seeded = editorWorkId(resolveRouteWork(workIdSelection(NO_WORK), catalog));
    expect(isEditorTab(scratchTab, seeded)).toBe(true);

    // Opening a manuscript document writes the Editor's Work into the address.
    const opened: ProjectAddress = {
      projectId: PROJECT,
      destination: { kind: "document", scheme: "manuscript", path: "chapter-1.md" },
      work: workIdSelection(seeded),
      results: false,
    };
    const repaired = guardProjectQuerySelections(opened, { work: catalog });
    expect(repaired).toBe(opened);

    const after = editorWorkId(resolveRouteWork(repaired.work, catalog));
    expect(after).toBe(seeded);
    expect(isEditorTab(scratchTab, after)).toBe(true);
  });
});
