/** Readable selection is the only Editor authority; no catalog or Chat fallback. */
import { parseRequestId } from "@meridian/contracts/request-id";
import { expect, it } from "vitest";
import type { AddressableWork } from "@/client/query/useWorks";
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
it.each(["loading"] as const)("keeps unresolved %s inert", (reason) => {
  expect(resolveEditorWorkScope({ status: "unresolved", reason, workId: id })).toEqual({
    status: reason,
    workId: id,
  });
});
it.each(["active", "archived"] as const)("admits readable Work (%s)", (status) => {
  const work: AddressableWork = {
    id,
    status,
    projectId: "project",
    createdByUserId: "user",
    name: "Work",
    slug: testWorkSlug("work"),
    isNoWork: false,
    goal: null,
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: "1",
    createdAt: "",
    updatedAt: "",
    lastActivityAt: "",
    deletedAt: null,
  };
  expect(resolveEditorWorkScope({ status: "present", workId: id, work })).toEqual({
    status: "ready",
    workId: id,
    source: "route",
  });
});
