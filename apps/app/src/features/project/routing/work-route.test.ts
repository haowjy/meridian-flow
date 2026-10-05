/** One resolver decides which Work an address names: present, being created, or unresolved. */
import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";
import type { AddressableWork } from "@/client/query/useWorks";
import { resolveRouteWork, type WorkCatalog } from "./work-route";

const id = (value: string) => {
  const parsed = parseRequestId(value);
  if (!parsed) throw new Error("Invalid fixture");
  return parsed;
};
const ARC = id("00000000-0000-4000-8000-000000000001");
const DRAFT = id("00000000-0000-4000-8000-000000000002");
const work = { id: ARC, name: "Arc" } as AddressableWork;
const catalog = (status: WorkCatalog["status"]): WorkCatalog =>
  ({
    status,
    entries: status === "ready" ? [work] : [],
    creations: new Map([
      [
        DRAFT,
        { work: { id: DRAFT, name: "Draft", goal: null, lastActivityAt: "" }, phase: "pending" },
      ],
    ]),
    isFetching: false,
    noWork: null,
  }) as WorkCatalog;

describe("resolveRouteWork", () => {
  it("resolves a Work in the catalog, and one still being created", () => {
    expect(resolveRouteWork({ kind: "id", id: ARC }, catalog("ready"))).toEqual({
      status: "present",
      workId: ARC,
      work,
    });
    expect(resolveRouteWork({ kind: "id", id: DRAFT }, catalog("loading"))).toMatchObject({
      status: "creating",
      workId: DRAFT,
      name: "Draft",
      phase: "pending",
    });
  });

  it("keeps a missing Work's id while the catalog loads, and calls it unavailable once ready", () => {
    expect(resolveRouteWork({ kind: "id", id: ARC }, catalog("loading"))).toEqual({
      status: "unresolved",
      reason: "loading",
      workId: ARC,
    });
    const missing = id("00000000-0000-4000-8000-000000000003");
    expect(resolveRouteWork({ kind: "id", id: missing }, catalog("ready"))).toEqual({
      status: "unresolved",
      reason: "unavailable",
      workId: missing,
    });
  });

  it("names no Work for an absent or empty selection, and no id for a malformed one", () => {
    expect(resolveRouteWork({ kind: "absent" }, catalog("ready"))).toEqual({ status: "none" });
    expect(resolveRouteWork({ kind: "none" }, catalog("ready"))).toEqual({ status: "none" });
    expect(resolveRouteWork({ kind: "malformed", value: "arc" }, catalog("ready"))).toEqual({
      status: "unresolved",
      reason: "unavailable",
      workId: null,
    });
  });

  it("reads the No Work row's id as No Work, as a No Work chat or Scratch address names it", () => {
    const noWorkId = id("00000000-0000-4000-8000-000000000009");
    expect(
      resolveRouteWork(
        { kind: "id", id: noWorkId },
        { ...catalog("ready"), noWork: { id: noWorkId } as AddressableWork },
      ),
    ).toEqual({ status: "none" });
    // Before the row is known it is not claimed as No Work, nor called unavailable.
    expect(
      resolveRouteWork({ kind: "id", id: noWorkId }, { ...catalog("loading"), noWork: null }),
    ).toEqual({ status: "unresolved", reason: "loading", workId: noWorkId });
  });
});
