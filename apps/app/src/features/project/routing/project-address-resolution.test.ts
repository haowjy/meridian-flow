/** Catalog errors, omission, and explicit unavailability remain separate route facts. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";
import {
  addressWorkSelection,
  guardProjectQuerySelections,
  resolveAddressSelection,
} from "./project-address-resolution";

function address(href: string) {
  const [path, query] = href.split("?");
  const parsed = parseProjectAddress(path, query);
  if (parsed.kind !== "valid") throw new Error(parsed.reason);
  return parsed.address;
}

describe("authorized address resolution", () => {
  it.each([
    "loading",
    "error",
    "ready",
  ] as const)("does not load defaults for an empty selection when catalog is %s", (status) => {
    const catalog =
      status === "ready" ? { status, entries: [{ id: "other", slug: "other" }] } : { status };
    expect(resolveAddressSelection({ kind: "none" }, catalog)).toEqual({ status: "none" });
    expect(resolveAddressSelection({ kind: "absent" }, catalog)).toEqual({ status: "absent" });
    expect(resolveAddressSelection({ kind: "malformed", value: "bad work" }, catalog)).toEqual({
      status: "malformed",
      value: "bad work",
    });
    expect(resolveAddressSelection({ kind: "slug", slug: "missing" }, catalog)).toEqual({
      status: status === "ready" ? "unavailable" : status,
      slug: "missing",
    });
  });
  it("returns only the exact persisted handle from the authorized catalog", () => {
    const entry = { id: "internal-id", slug: "fight-scene" };
    expect(
      resolveAddressSelection(
        { kind: "slug", slug: "fight-scene" },
        { status: "ready", entries: [entry, { id: "pending", slug: null }] },
      ),
    ).toEqual({ status: "resolved", value: entry });
  });
  it("keeps path authority independent from Chat and secondary Work", () => {
    expect(
      addressWorkSelection(
        address("/p/550e8400-e29b-41d4-a716-446655440000/work/revision/scratch/notes.md"),
      ),
    ).toEqual({ kind: "slug", slug: "revision" });
    expect(
      addressWorkSelection(address("/p/550e8400-e29b-41d4-a716-446655440000/scratch/notes.md")),
    ).toEqual({
      kind: "none",
    });
    expect(
      addressWorkSelection(
        address("/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md?work=revision"),
      ),
    ).toEqual({ kind: "slug", slug: "revision" });
  });
});

describe("optional query guard", () => {
  const ready = {
    status: "ready",
    entries: [{ slug: "valid" }, { slug: "550e8400-e29b-41d4-a716-446655440000" }],
  } as const;
  it("clears missing selectors together without changing the document or auxiliary state", () => {
    const input = address(
      "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md?work=missing&settings=general",
    );
    expect(guardProjectQuerySelections(input, { work: ready })).toEqual({
      ...input,

      work: { kind: "none" },
    });
  });
  it("removes invalid query values while pinning no selection on reload", () => {
    const repaired = guardProjectQuerySelections(
      address("/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md?work=missing"),
      { work: ready },
    );
    const href = projectAddressHref(repaired);
    expect(href).toBe("/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md");
    const reloaded = parseProjectAddress(href, "", projectAddressState(repaired));
    expect(reloaded.kind === "valid" && reloaded.address).toEqual(repaired);
  });
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address("/p/550e8400-e29b-41d4-a716-446655440000/editor?work=missing");
    expect(guardProjectQuerySelections(input, { work: { status } })).toBe(input);
  });
  it.each([
    "/p/550e8400-e29b-41d4-a716-446655440000/editor",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor?work=valid",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/missing",
    "/p/550e8400-e29b-41d4-a716-446655440000/chat/00000000-0000-4000-8000-000000000000",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/missing/scratch/notes.md",
  ])("leaves valid, absent, empty and required path identities untouched: %s", (href) => {
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
