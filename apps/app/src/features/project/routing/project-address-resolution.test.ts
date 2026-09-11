/** Catalog errors, omission, and explicit unavailability remain separate route facts. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress } from "./project-address";
import {
  addressChatSelection,
  addressWorkSelection,
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
