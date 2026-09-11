/** Readable selection is the only Editor authority; no catalog or Chat fallback. */
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { expect, it } from "vitest";
import { testWorkSlug } from "@/test-support/work-slug";
import { resolveEditorWorkScope } from "./editor-work-scope";

const id = parseRequestId("11111111-1111-4111-8111-111111111111");
if (!id) throw new Error("Invalid fixture");
it("admits explicit no Work without another selector", () => {
  expect(resolveEditorWorkScope({ status: "none" })).toEqual({
    status: "ready",
    workId: null,
    source: "route",
  });
});
it.each(["loading", "error", "unavailable"] as const)("keeps unresolved %s inert", (reason) => {
  expect(resolveEditorWorkScope({ status: "unresolved", reason, slug: "requested" })).toEqual({
    status: reason,
    workId: "requested",
  });
});
it.each(["active", "archived"] as const)("only admits active Work (%s)", (status) => {
  const work: Work = {
    id,
    status,
    projectId: "project",
    createdByUserId: "user",
    name: "Work",
    slug: testWorkSlug("work"),
    goal: null,
    description: null,
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: "1",
    createdAt: "",
    updatedAt: "",
    lastActivityAt: "",
    deletedAt: null,
  };
  expect(resolveEditorWorkScope({ status: "present", workId: id, work })).toEqual(
    status === "active"
      ? { status: "ready", workId: id, source: "route" }
      : { status: "unavailable", workId: id },
  );
});
