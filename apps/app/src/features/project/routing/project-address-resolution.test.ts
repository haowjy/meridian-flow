/** Catalog errors, omission, and explicit unavailability remain separate route facts. */

import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";
import {
  addressWorkSelection,
  guardProjectQuerySelections,
  resolveAddressSelection,
  workSelectionFor,
} from "./project-address-resolution";

function address(href: string) {
  const [path, query] = href.split("?");
  const parsed = parseProjectAddress(path, query);
  if (parsed.kind !== "valid") throw new Error(parsed.reason);
  return parsed.address;
}

describe("authorized address resolution", () => {
  const existingId = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
  const missingId = parseRequestId("123e4567-e89b-42d3-a456-426614174001");
  if (!existingId || !missingId) throw new Error("Invalid Work ID fixture");

  it.each([
    "loading",
    "error",
    "ready",
  ] as const)("does not load defaults for an empty selection when catalog is %s", (status) => {
    const catalog =
      status === "ready"
        ? { status, entries: [{ id: "123e4567-e89b-42d3-a456-426614174000" }] }
        : { status };
    expect(resolveAddressSelection({ kind: "none" }, catalog)).toEqual({ status: "none" });
    expect(resolveAddressSelection({ kind: "absent" }, catalog)).toEqual({ status: "absent" });
    expect(resolveAddressSelection({ kind: "malformed", value: "bad work" }, catalog)).toEqual({
      status: "malformed",
      value: "bad work",
    });
    expect(resolveAddressSelection({ kind: "id", id: missingId }, catalog)).toEqual({
      status: status === "ready" ? "unavailable" : status,
      id: missingId,
    });
  });
  it("returns only the exact persisted handle from the authorized catalog", () => {
    const entry = { id: "123e4567-e89b-42d3-a456-426614174000", slug: "fight-scene" };
    expect(
      resolveAddressSelection(
        { kind: "id", id: existingId },
        { status: "ready", entries: [entry, { id: "pending", slug: null }] },
      ),
    ).toEqual({ status: "resolved", value: entry });
  });
  it("reads the Work from the Work page or the query, independent of Chat", () => {
    expect(
      addressWorkSelection(
        address(
          "/p/550e8400-e29b-41d4-a716-446655440000/works/123e4567-e89b-42d3-a456-426614174000",
        ),
      ),
    ).toEqual({ kind: "id", id: "123e4567-e89b-42d3-a456-426614174000" });
    expect(
      addressWorkSelection(
        address(
          "/p/550e8400-e29b-41d4-a716-446655440000/editor/scratch/notes.md?work=123e4567-e89b-42d3-a456-426614174000",
        ),
      ),
    ).toEqual({ kind: "id", id: "123e4567-e89b-42d3-a456-426614174000" });
    expect(
      addressWorkSelection(
        address("/p/550e8400-e29b-41d4-a716-446655440000/editor/scratch/notes.md?work="),
      ),
    ).toEqual({ kind: "none" });
    expect(
      addressWorkSelection(
        address(
          "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/chapter.md?work=123e4567-e89b-42d3-a456-426614174000",
        ),
      ),
    ).toEqual({ kind: "id", id: "123e4567-e89b-42d3-a456-426614174000" });
  });
});

describe("optional query guard", () => {
  const ready = {
    status: "ready",
    entries: [
      { id: "123e4567-e89b-42d3-a456-426614174000" },
      { id: "550e8400-e29b-41d4-a716-446655440000" },
    ],
  } as const;
  it("clears missing selectors together without changing the document or auxiliary state", () => {
    const input = address(
      "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/chapter.md?work=123e4567-e89b-42d3-a456-426614174001&settings=general",
    );
    expect(guardProjectQuerySelections(input, { work: ready })).toEqual({
      ...input,

      work: { kind: "none" },
    });
  });
  it("removes invalid query values while pinning no selection on reload", () => {
    const repaired = guardProjectQuerySelections(
      address(
        "/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/chapter.md?work=123e4567-e89b-42d3-a456-426614174001",
      ),
      { work: ready },
    );
    const href = projectAddressHref(repaired);
    expect(href).toBe("/p/550e8400-e29b-41d4-a716-446655440000/editor/manuscript/chapter.md");
    const reloaded = parseProjectAddress(href, "", projectAddressState(repaired));
    expect(reloaded.kind === "valid" && reloaded.address).toEqual(repaired);
  });
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address(
      "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=123e4567-e89b-42d3-a456-426614174001",
    );
    expect(guardProjectQuerySelections(input, { work: { status } })).toBe(input);
  });
  it.each([
    "/p/550e8400-e29b-41d4-a716-446655440000/editor",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=123e4567-e89b-42d3-a456-426614174000",
    "/p/550e8400-e29b-41d4-a716-446655440000/works/123e4567-e89b-42d3-a456-426614174001",
    "/p/550e8400-e29b-41d4-a716-446655440000/chats/00000000-0000-4000-8000-000000000000",
    // A Work-owned resource's Work is its identity, even when that Work is missing.
    "/p/550e8400-e29b-41d4-a716-446655440000/editor/scratch/notes.md?work=123e4567-e89b-42d3-a456-426614174001",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor/browse/uploads?work=123e4567-e89b-42d3-a456-426614174001",
  ])("leaves valid, absent, empty and identity selections untouched: %s", (href) => {
    const input = address(href);
    expect(guardProjectQuerySelections(input, { work: ready })).toBe(input);
  });
  it("clears malformed optional values without waiting for catalogs", () => {
    const input = address("/p/550e8400-e29b-41d4-a716-446655440000/editor?work=bad%20work");
    expect(
      guardProjectQuerySelections(input, {
        work: { status: "error" },
      }),
    ).toEqual({
      ...input,

      work: { kind: "none" },
    });
  });
});

it("serializes No Work uniformly without changing project content URLs", () => {
  const noWorkId = "00000000-0000-4000-8000-000000000009";
  for (const [destination, workId, kind, suffix] of [
    [
      { kind: "document", scheme: "manuscript", path: "chapter.md" },
      noWorkId,
      "none",
      "/editor/manuscript/chapter.md",
    ],
    [
      { kind: "browse", scheme: "scratch", path: "" },
      noWorkId,
      "id",
      `/editor/browse/scratch?work=${noWorkId}`,
    ],
    [{ kind: "editor" }, undefined, "absent", "/editor"],
  ] as const) {
    const work = workSelectionFor(destination, workId, noWorkId);
    expect(work.kind).toBe(kind);
    expect(projectAddressHref({ projectId: "project", destination, work, results: false })).toBe(
      `/p/project${suffix}`,
    );
  }
});
