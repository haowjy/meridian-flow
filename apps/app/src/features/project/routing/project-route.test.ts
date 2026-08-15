import type { Work } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  applyNormalizationIfCurrent,
  parseExplicitWork,
  parseProjectSearch,
  planWorkNormalization,
  resolveRouteWork,
  transitionProjectSearch,
} from "./project-route";

const LOWER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UPPER = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const parsedWorkId = parseExplicitWork(LOWER);
if (parsedWorkId.kind !== "valid") throw new Error("Invalid test Work ID");
const WORK_ID = parsedWorkId.id;

function work(id = LOWER, status: Work["status"] = "active"): Work {
  return { id, projectId: "project", name: "Work", description: null, goal: null, status } as Work;
}

describe("project search grammar", () => {
  it.each([
    [{}, { kind: "absent" }],
    [{ work: "" }, { kind: "malformed", value: "" }],
    [{ work: "not-a-uuid" }, { kind: "malformed", value: "not-a-uuid" }],
    [{ work: UPPER }, { kind: "valid", id: LOWER, canonical: false }],
    [{ work: LOWER }, { kind: "valid", id: LOWER, canonical: true }],
  ] as const)("preserves the explicit Work grammar for %o", (raw, expected) => {
    const search = parseProjectSearch(raw);
    expect(parseExplicitWork(search.work)).toEqual(expected);
  });

  it("rejects context subordinate values without a valid scheme", () => {
    expect(parseProjectSearch({ folder: "/one", path: "/one/two" })).toEqual({});
  });
});

describe("route Work resolution and normalization", () => {
  it("keeps loading and catalog failure distinct from successful absence", () => {
    const explicit = parseExplicitWork(LOWER);
    expect(resolveRouteWork(explicit, { status: "loading" }).status).toBe("loading");
    expect(resolveRouteWork(explicit, { status: "error" }).status).toBe("catalog-error");
    expect(resolveRouteWork(explicit, { status: "success", works: [] }).status).toBe("not-found");
  });

  it("confirms active and archived Works from the all-status catalog", () => {
    const explicit = parseExplicitWork(LOWER);
    expect(resolveRouteWork(explicit, { status: "success", works: [work()] }).status).toBe(
      "present",
    );
    expect(
      resolveRouteWork(explicit, { status: "success", works: [work(LOWER, "archived")] }).status,
    ).toBe("present");
  });

  it("canonicalizes uppercase without waiting for the catalog", () => {
    const search = parseProjectSearch({ screen: "context", work: UPPER, scheme: "scratch" });
    const explicit = parseExplicitWork(search.work);
    const resolution = resolveRouteWork(explicit, { status: "loading" });
    expect(planWorkNormalization(search, explicit, resolution)?.next).toEqual({
      screen: "context",
      work: LOWER,
      scheme: "scratch",
    });
  });

  it("normalizes malformed immediately and unknown only after catalog success", () => {
    const malformed = parseProjectSearch({ screen: "context", work: "bad", scheme: "scratch" });
    const malformedInput = parseExplicitWork(malformed.work);
    expect(
      planWorkNormalization(
        malformed,
        malformedInput,
        resolveRouteWork(malformedInput, { status: "loading" }),
      )?.next,
    ).toEqual({ screen: "work" });

    const valid = parseProjectSearch({ screen: "context", work: LOWER, scheme: "scratch" });
    const validInput = parseExplicitWork(valid.work);
    expect(
      planWorkNormalization(valid, validInput, resolveRouteWork(validInput, { status: "error" })),
    ).toBeNull();
    expect(
      planWorkNormalization(
        valid,
        validInput,
        resolveRouteWork(validInput, { status: "success", works: [] }),
      )?.next,
    ).toEqual({ screen: "work" });
  });

  it("does not let stale validation overwrite newer navigation", () => {
    const oldSearch = parseProjectSearch({ screen: "context", work: LOWER, scheme: "scratch" });
    const explicit = parseExplicitWork(oldSearch.work);
    const plan = planWorkNormalization(
      oldSearch,
      explicit,
      resolveRouteWork(explicit, { status: "success", works: [] }),
    );
    if (!plan) throw new Error("Expected unknown Work normalization");
    const newer = parseProjectSearch({ screen: "work", work: UPPER });
    expect(applyNormalizationIfCurrent(plan, newer)).toEqual(newer);
  });

  it("normalizes from latest search without overwriting a newer dock thread", () => {
    const oldSearch = parseProjectSearch({ screen: "context", work: UPPER, thread: "thread-a" });
    const explicit = parseExplicitWork(oldSearch.work);
    const plan = planWorkNormalization(
      oldSearch,
      explicit,
      resolveRouteWork(explicit, { status: "loading" }),
    );
    if (!plan) throw new Error("Expected canonicalization plan");
    const latest = { ...oldSearch, thread: "thread-b" };
    expect(applyNormalizationIfCurrent(plan, latest)).toEqual({
      screen: "context",
      work: LOWER,
      thread: "thread-b",
    });
  });

  it("treats concealed, externally deleted, and reload-missing IDs as confirmed absence", () => {
    const explicit = parseExplicitWork(LOWER);
    expect(resolveRouteWork(explicit, { status: "success", works: [] }).status).toBe("not-found");
    expect(resolveRouteWork(explicit, { status: "success", works: [work()] }).status).toBe(
      "present",
    );
    expect(resolveRouteWork(explicit, { status: "success", works: [] }).status).toBe("not-found");
    const reloaded = parseExplicitWork(parseProjectSearch({ work: LOWER }).work);
    expect(resolveRouteWork(reloaded, { status: "success", works: [] }).status).toBe("not-found");
  });
});

describe("project search transitions", () => {
  const editor = parseProjectSearch({
    screen: "context",
    thread: "thread-1",
    work: LOWER,
    scheme: "scratch",
    folder: "/notes",
    path: "/notes/a.md",
    results: "",
  });

  it("preserves Work across Work and Context screen transitions", () => {
    expect(transitionProjectSearch(editor, { kind: "screen", screen: "work" })).toEqual({
      screen: "work",
      thread: "thread-1",
      work: LOWER,
    });
    expect(transitionProjectSearch(editor, { kind: "screen", screen: "context" }).work).toBe(LOWER);
  });

  it.each([
    {
      screen: "work" as const,
      covered: { screen: "work", work: LOWER, scheme: "manuscript", path: "" },
    },
    {
      screen: "home" as const,
      covered: { screen: "home", scheme: "manuscript", path: "" },
    },
    {
      screen: "chat" as const,
      covered: { screen: "chat", scheme: "manuscript", path: "" },
    },
  ] as const)("preserves an untitled-tab pin across generic $screen navigation", ({
    screen,
    covered,
  }) => {
    const untitled = parseProjectSearch({
      screen: "context",
      work: LOWER,
      scheme: "manuscript",
      path: "",
    });

    expect(transitionProjectSearch(untitled, { kind: "screen", screen })).toEqual(covered);
    expect(transitionProjectSearch(covered, { kind: "screen", screen: "context" })).toEqual({
      ...covered,
      screen: "context",
    });
  });

  it("fully clears the untitled-tab pin for intentional Home and Chat commands", () => {
    const untitled = parseProjectSearch({ work: LOWER, scheme: "manuscript", path: "" });

    expect(transitionProjectSearch(untitled, { kind: "home" })).toEqual({ screen: "home" });
    expect(transitionProjectSearch(untitled, { kind: "chat", threadId: "thread-2" })).toEqual({
      thread: "thread-2",
    });
  });

  it("normal chat clears Work and all Editor state", () => {
    expect(transitionProjectSearch(editor, { kind: "chat", threadId: "thread-2" })).toEqual({
      thread: "thread-2",
    });
  });

  it("dock selection preserves the current screen, Work, and Editor state", () => {
    expect(
      transitionProjectSearch(editor, {
        kind: "dock-thread",
        threadId: "thread-2",
        resolvedScreen: "context",
      }),
    ).toEqual({ ...editor, thread: "thread-2" });
  });

  it("Home clears Work and context state", () => {
    expect(transitionProjectSearch(editor, { kind: "home" })).toEqual({
      screen: "home",
      thread: "thread-1",
    });
  });

  it("opens Work detail and collection without context state", () => {
    expect(transitionProjectSearch(editor, { kind: "work-detail", workId: WORK_ID })).toEqual({
      screen: "work",
      thread: "thread-1",
      work: LOWER,
    });
    expect(transitionProjectSearch(editor, { kind: "work-collection" })).toEqual({
      screen: "work",
      thread: "thread-1",
    });
  });

  it("opens Work context atomically and clears Results", () => {
    expect(
      transitionProjectSearch(editor, {
        kind: "work-context",
        workId: WORK_ID,
        scheme: "uploads",
        path: "/sources/map.png",
      }),
    ).toEqual({
      screen: "context",
      thread: "thread-1",
      work: LOWER,
      scheme: "uploads",
      folder: "/sources",
      path: "/sources/map.png",
    });
  });

  it("reconstructs collection and detail destinations for Back and Forward", () => {
    const collection = transitionProjectSearch(editor, { kind: "work-collection" });
    const detail = transitionProjectSearch(collection, {
      kind: "work-detail",
      workId: WORK_ID,
    });
    expect(collection).toEqual({ screen: "work", thread: "thread-1" });
    expect(detail).toEqual({ screen: "work", thread: "thread-1", work: LOWER });
    expect(transitionProjectSearch(detail, { kind: "work-collection" })).toEqual(collection);
    expect(transitionProjectSearch(collection, { kind: "work-detail", workId: WORK_ID })).toEqual(
      detail,
    );
  });
});
