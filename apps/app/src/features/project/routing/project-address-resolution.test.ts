/** Catalog errors, omission, and explicit unavailability remain separate route facts. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";
import {
  addressChatSelection,
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
      addressWorkSelection(address("/p/serial/work/revision/scratch/notes.md?chat=fight")),
    ).toEqual({ kind: "slug", slug: "revision" });
    expect(addressWorkSelection(address("/p/serial/scratch/notes.md?chat=fight"))).toEqual({
      kind: "none",
    });
    expect(
      addressWorkSelection(address("/p/serial/manuscript/chapter.md?chat=fight&work=revision")),
    ).toEqual({ kind: "slug", slug: "revision" });
    expect(addressChatSelection(address("/p/serial/chat/fight"))).toEqual({
      kind: "slug",
      slug: "fight",
    });
  });
});

describe("optional query guard", () => {
  const ready = { status: "ready", entries: [{ slug: "valid" }] } as const;
  it("clears missing selectors together without changing the document or auxiliary state", () => {
    const input = address(
      "/p/serial/manuscript/chapter.md?work=missing&chat=missing&settings=general",
    );
    expect(guardProjectQuerySelections(input, { chat: ready, work: ready })).toEqual({
      ...input,
      chat: { kind: "none" },
      work: { kind: "none" },
    });
  });
  it("removes invalid query values while pinning no selection on reload", () => {
    const repaired = guardProjectQuerySelections(
      address("/p/serial/manuscript/chapter.md?work=missing&chat=missing"),
      { chat: ready, work: ready },
    );
    const href = projectAddressHref(repaired);
    expect(href).toBe("/p/serial/manuscript/chapter.md");
    const reloaded = parseProjectAddress(href, "", projectAddressState(repaired));
    expect(reloaded.kind === "valid" && reloaded.address).toEqual(repaired);
  });
  it.each(["loading", "error"] as const)("preserves unresolved values during %s", (status) => {
    const input = address("/p/serial/editor?work=missing&chat=missing");
    expect(guardProjectQuerySelections(input, { chat: { status }, work: { status } })).toBe(input);
  });
  it.each([
    "/p/serial/editor",
    "/p/serial/editor?work=&chat=",
    "/p/serial/editor?work=valid&chat=valid",
    "/p/serial/work/missing",
    "/p/serial/chat/missing",
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
