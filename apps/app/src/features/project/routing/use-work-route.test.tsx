/**
 * useWorkRoute against the No Work row: it has no Work screen, and it is never
 * the remembered Work, while a named Work is.
 */
import { parseRequestId } from "@meridian/contracts/request-id";
import { beforeEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectAddress, ProjectDestination } from "./project-address";
import type { RouteWorkResolution } from "./project-route";
import { useWorkRoute } from "./work-route";

const { writeCurrentWork } = vi.hoisted(() => ({ writeCurrentWork: vi.fn() }));
vi.mock("@/client/current-work", () => ({
  readCurrentWork: () => null,
  writeCurrentWork,
}));
vi.mock("../context/account-feature-context", () => ({ useAccountId: () => "account" }));

const PROJECT = "550e8400-e29b-41d4-a716-446655440000";
const id = (value: string) => {
  const parsed = parseRequestId(value);
  if (!parsed) throw new Error("Invalid fixture");
  return parsed;
};
const NO_WORK = id("00000000-0000-4000-8000-000000000009");
const ARC = id("00000000-0000-4000-8000-000000000001");
const arc = { id: ARC, name: "Arc", slug: "arc", isNoWork: false };
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({
    status: "ready",
    works: [arc],
    creations: new Map(),
    isFetching: false,
    noWork: { id: NO_WORK, name: "No Work", slug: null, isNoWork: true },
  }),
}));

beforeEach(() => writeCurrentWork.mockReset());

async function routeFor(destination: ProjectDestination, work: ProjectAddress["work"]) {
  let routeWork: RouteWorkResolution | undefined;
  function Probe() {
    routeWork = useWorkRoute({
      projectId: PROJECT,
      address: { projectId: PROJECT, destination, work, results: false },
      navigation: null,
    }).routeWork;
    return null;
  }
  await withReactRoot(<Probe />, async () => undefined);
  return routeWork;
}

it("refuses the No Work row's id as a Work screen", async () => {
  expect(await routeFor({ kind: "work", workId: NO_WORK }, { kind: "absent" })).toEqual({
    status: "unresolved",
    reason: "unavailable",
    workId: NO_WORK,
  });
  expect(writeCurrentWork).not.toHaveBeenCalled();
});

it("reads a No Work Scratch address as No Work and never remembers it", async () => {
  expect(
    await routeFor(
      { kind: "document", scheme: "scratch", path: "side/note.md" },
      { kind: "id", id: NO_WORK },
    ),
  ).toEqual({ status: "none" });
  expect(writeCurrentWork).not.toHaveBeenCalled();
});

it("remembers a named Work it routes to", async () => {
  expect(await routeFor({ kind: "work", workId: ARC }, { kind: "absent" })).toMatchObject({
    status: "present",
    workId: ARC,
  });
  expect(writeCurrentWork).toHaveBeenCalledWith("account", PROJECT, ARC);
});
