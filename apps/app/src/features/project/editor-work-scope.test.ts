/** One shell-level Editor Work precedence contract. */
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";
import { resolveEditorWorkScope } from "./editor-work-scope";

const work = (id: string): Work =>
  ({ id, projectId: "project", name: id, slug: id, status: "active" }) as Work;

const routeWorkA = parseRequestId("11111111-1111-4111-8111-111111111111");
if (!routeWorkA) throw new Error("fixture must be a request id");

describe("resolveEditorWorkScope", () => {
  it("keeps explicit Editor A independent from dock Chat B", () => {
    const editorA = work(routeWorkA);
    expect(
      resolveEditorWorkScope({ status: "present", workId: routeWorkA, work: editorA }, "work-b", {
        status: "ready",
        work: work("fallback"),
      }),
    ).toEqual({ status: "ready", workId: routeWorkA, source: "route" });
  });

  it("blocks rather than falling back to Chat while explicit Work loads or errors", () => {
    const chatB = work("work-b");
    expect(
      resolveEditorWorkScope({ status: "loading", workId: routeWorkA }, chatB.id, {
        status: "ready",
        work: work("fallback"),
      }),
    ).toEqual({
      status: "loading",
      workId: routeWorkA,
    });
    expect(
      resolveEditorWorkScope({ status: "catalog-error", workId: routeWorkA }, chatB.id, {
        status: "ready",
        work: work("fallback"),
      }),
    ).toEqual({ status: "error", workId: routeWorkA });
  });

  it("uses selected Chat then the first available catalog Work only when no route Work exists", () => {
    const chatB = work("work-b");
    expect(
      resolveEditorWorkScope({ status: "absent" }, chatB.id, {
        status: "ready",
        work: work("fallback"),
      }),
    ).toMatchObject({
      status: "ready",
      workId: "work-b",
      source: "chat",
    });
    expect(
      resolveEditorWorkScope({ status: "absent" }, null, {
        status: "ready",
        work: work("fallback"),
      }),
    ).toMatchObject({
      status: "ready",
      workId: "fallback",
      source: "catalog",
    });
  });

  it("keeps an authoritative empty catalog distinct from loading", () => {
    expect(resolveEditorWorkScope({ status: "absent" }, null, { status: "empty" })).toEqual({
      status: "empty",
    });
  });

  it("never mounts malformed or confirmed-missing explicit Work under Chat B", () => {
    expect(
      resolveEditorWorkScope({ status: "malformed", value: "bad" }, "work-b", {
        status: "ready",
        work: work("fallback"),
      }),
    ).toEqual({ status: "normalizing", workId: "bad" });
    expect(
      resolveEditorWorkScope({ status: "not-found", workId: routeWorkA }, "work-b", {
        status: "ready",
        work: work("fallback"),
      }),
    ).toEqual({ status: "normalizing", workId: routeWorkA });
  });

  it("keeps authoritative Chat identity when display catalog fails", () => {
    expect(resolveEditorWorkScope({ status: "absent" }, "work-b", { status: "error" })).toEqual({
      status: "ready",
      workId: "work-b",
      source: "chat",
    });
    expect(resolveEditorWorkScope({ status: "absent" }, null, { status: "error" })).toEqual({
      status: "error",
      workId: "",
    });
  });
});
