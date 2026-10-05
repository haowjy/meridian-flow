/** No Work resolves by identity; loading never masquerades as a ready Editor. */
import { parseRequestId } from "@meridian/contracts/request-id";
import { expect, it } from "vitest";
import type { AddressableWork } from "@/client/query/useWorks";
import { collapseScreenWork, resolveRouteWork, type WorkCatalog } from "./work-route";

const id = parseRequestId("00000000-0000-4000-8000-000000000009");
if (!id) throw new Error("Invalid fixture");
const noWork = { id, isNoWork: true, name: "No Work" } as AddressableWork;
it("normalizes No Work selections and separates screen collapse from Editor readiness", () => {
  const catalog: WorkCatalog = {
    status: "ready",
    entries: [],
    creations: new Map(),
    isFetching: false,
    noWork,
  };
  for (const selection of [{ kind: "none" as const }, { kind: "id" as const, id }]) {
    expect(resolveRouteWork(selection, catalog)).toEqual({
      status: "present",
      workId: id,
      work: noWork,
    });
    expect(
      resolveRouteWork(selection, { ...catalog, status: "loading", noWork: null }),
    ).toMatchObject({ status: "unresolved", reason: "loading" });
  }
  const ready = resolveRouteWork({ kind: "none" }, catalog);
  expect(collapseScreenWork(ready, { kind: "work", workId: id })).toEqual({
    status: "unresolved",
    reason: "unavailable",
    workId: id,
  });
  expect(collapseScreenWork(ready, { kind: "editor" })).toEqual({ status: "absent" });
});
