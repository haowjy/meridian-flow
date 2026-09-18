/** Catalog errors, omission, and explicit unavailability remain separate route facts. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";
import {
  addressChatSelection,
  addressWorkSelection,
  chatCatalogIssue,
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
        address(
          "/p/serial/work/revision/scratch/notes.md?chat=550e8400-e29b-41d4-a716-446655440000",
        ),
      ),
    ).toEqual({ kind: "slug", slug: "revision" });
    expect(
      addressWorkSelection(
        address("/p/serial/scratch/notes.md?chat=550e8400-e29b-41d4-a716-446655440000"),
      ),
    ).toEqual({
      kind: "none",
    });
    expect(
      addressWorkSelection(
        address(
          "/p/serial/manuscript/chapter.md?chat=550e8400-e29b-41d4-a716-446655440000&work=revision",
        ),
      ),
    ).toEqual({ kind: "slug", slug: "revision" });
    expect(
      addressChatSelection(address("/p/serial/chat/550e8400-e29b-41d4-a716-446655440000")),
    ).toEqual({
      kind: "slug",
      slug: "550e8400-e29b-41d4-a716-446655440000",
    });
  });
  it("does not overlay a path chat missing from the primary catalog", () => {
    const childId = "8d67b6b1-a47d-4cc2-86ec-7304666fd560";
    const miss = resolveAddressSelection(
      { kind: "slug", slug: childId },
      { status: "ready", entries: [{ slug: "550e8400-e29b-41d4-a716-446655440000" }] },
    );
    expect(miss).toEqual({ status: "unavailable", slug: childId });
    expect(chatCatalogIssue({ kind: "chat", chatId: childId }, miss)).toBeUndefined();
  });
  it("still overlays a missing query chat against the primary catalog", () => {
    const miss = resolveAddressSelection(
      { kind: "slug", slug: "00000000-0000-4000-8000-000000000000" },
      { status: "ready", entries: [{ slug: "550e8400-e29b-41d4-a716-446655440000" }] },
    );
    expect(chatCatalogIssue({ kind: "editor" }, miss)).toBe("unavailable");
  });
});

describe("optional query guard", () => {
  const ready = {
    status: "ready",
    entries: [{ slug: "valid" }, { slug: "550e8400-e29b-41d4-a716-446655440000" }],
  } as const;
  it("clears missing selectors together without changing the document or auxiliary state", () => {
    const input = address(
      "/p/serial/manuscript/chapter.md?work=missing&chat=00000000-0000-4000-8000-000000000000&settings=general",
    );
    expect(guardProjectQuerySelections(input, { chat: ready, work: ready })).toEqual({
      ...input,
      chat: { kind: "none" },
      work: { kind: "none" },
    });
  });
  it("removes invalid query values while pinning no selection on reload", () => {
    const repaired = guardProjectQuerySelections(
      address(
        "/p/serial/manuscript/chapter.md?work=missing&chat=00000000-0000-4000-8000-000000000000",
      ),
      { chat: ready, work: ready },
    );
    const href = projectAddressHref(repaired);
    expect(href).toBe("/p/serial/manuscript/chapter.md");
    const reloaded = parseProjectAddress(href, "", projectAddressState(repaired));
    expect(reloaded.kind === "valid" && reloaded.address).toEqual(repaired);
  });
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address(
      "/p/serial/editor?work=missing&chat=00000000-0000-4000-8000-000000000000",
    );
    expect(guardProjectQuerySelections(input, { chat: { status }, work: { status } })).toBe(input);
  });
  it.each([
    "/p/serial/editor",
    "/p/serial/editor?work=&chat=",
    "/p/serial/editor?work=valid&chat=550e8400-e29b-41d4-a716-446655440000",
    "/p/serial/work/missing",
    "/p/serial/chat/00000000-0000-4000-8000-000000000000",
    "/p/serial/work/missing/scratch/notes.md",
  ])("leaves valid, absent, empty and required path identities untouched: %s", (href) => {
    const input = address(href);
    expect(guardProjectQuerySelections(input, { chat: ready, work: ready })).toBe(input);
  });
  it("clears malformed optional values without waiting for catalogs", () => {
    const input = address("/p/serial/editor?work=bad%20work&chat=bad%20chat");
    expect(
      guardProjectQuerySelections(input, {
        chat: { status: "loading" },
        work: { status: "error" },
      }),
    ).toEqual({
      ...input,
      chat: { kind: "none" },
      work: { kind: "none" },
    });
  });
});
