/** Browser grammar contracts: explicit scope, exact filenames, and lossless raw query parsing. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref } from "./project-address";

describe("readable project addresses", () => {
  it.each([
    "/p/serial",
    "/p/serial/chats",
    "/p/serial/chats/new",
    "/p/serial/chat/editor",
    "/p/serial/works",
    "/p/serial/work/browse",
    "/p/serial/editor",
    "/p/serial/browse",
    "/p/serial/browse/manuscript",
    "/p/serial/browse/manuscript/Volume%201",
    "/p/serial/manuscript/Volume%201/Chapter%20%231.md",
    "/p/serial/kb/%E4%BF%AE%E7%82%BC.md",
    "/p/serial/user/100%25.md",
    "/p/serial/work/revision/scratch/notes.md",
    "/p/serial/scratch/notes.md",
    "/p/serial/work/revision/browse/uploads",
    "/p/serial/uploads/reference.pdf",
    "/p/serial/manuscript/literal%252F.md",
  ])("round trips %s", (path) => {
    const parsed = parseProjectAddress(path);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    expect(projectAddressHref(parsed.address)).toBe(path);
  });

  it.each([
    "/p/serial/manuscript/a%2Fb.md",
    "/p/serial/manuscript/a%5Cb.md",
    "/p/serial/manuscript/a\\b.md",
    "/p/serial/manuscript/%",
    "/p/serial/manuscript/%E0%A4",
    "/p/serial/manuscript/a%3Fb.md",
    "/p/serial/manuscript/..",
    "/p/serial/manuscript/%40draft.md",
    "/p/serial/manuscript//leaf.md",
    "/p/serial/work/revision/manuscript/leaf.md",
    "/p/serial/work/revision/browse/kb",
    "/p/serial/manuscript",
    "/p/serial/chat",
    "/p/serial/chat/a/b",
    "/p/serial/agents",
    "/p/serial/publish",
    "/p/serial//",
    "/p/serial/manuscript/%20trimmed.md",
    "/p//editor",
  ])("rejects invalid or unsupported primary %s", (path) => {
    expect(parseProjectAddress(path).kind).toBe("invalid");
  });

  it("normalizes only handles and trailing slash, never document case", () => {
    expect(parseProjectAddress("/p/Silver-Moon/work/ReVision/scratch/Chapter.md/")).toMatchObject({
      kind: "valid",
      href: "/p/silver-moon/work/revision/scratch/Chapter.md",
    });
  });

  it("preserves absent, explicitly empty, and malformed secondary selections", () => {
    expect(parseProjectAddress("/p/serial/editor")).toMatchObject({
      address: { chat: { kind: "absent" }, work: { kind: "absent" } },
    });
    expect(parseProjectAddress("/p/serial/editor", "?chat=&work=")).toMatchObject({
      href: "/p/serial/editor",
      address: { chat: { kind: "none" }, work: { kind: "none" } },
    });
    expect(
      parseProjectAddress("/p/serial/editor", "?chat=not+a+slug&work=bad%2Fwork"),
    ).toMatchObject({
      address: {
        chat: { kind: "malformed", value: "not a slug" },
        work: { kind: "malformed", value: "bad/work" },
      },
    });
  });

  it.each([
    "?chat=a&chat=b",
    "?chat=&ch%61t=a",
    "?work=a&work=",
    "?settings=profile&settings=usage",
    "?results=&results=1",
    "?chat=%",
    "?unknown=%FE",
  ])("rejects raw query ambiguity %s", (search) => {
    expect(parseProjectAddress("/p/serial/editor", search).kind).toBe("invalid");
  });

  it("keeps document, chat, and independent Editor Work addresses distinct", () => {
    expect(
      parseProjectAddress(
        "/p/serial/manuscript/chapter.md",
        "?work=Revision&chat=Fight-Scene&settings=usage&doc=ignored&unknown=1",
      ),
    ).toMatchObject({
      href: "/p/serial/manuscript/chapter.md?chat=fight-scene&work=revision&settings=usage",
    });
    expect(
      parseProjectAddress(
        "/p/serial/chat/fight-scene",
        "?chat=other&work=revision&doc=ignored&results=&settings=profile",
      ),
    ).toMatchObject({ href: "/p/serial/chat/fight-scene?results=&settings=profile" });
  });

  it("path-owned Work cannot be overridden by query context", () => {
    const path = "/p/serial/work/revision/scratch/notes.md";
    expect(parseProjectAddress(path, "?work=Revision")).toMatchObject({
      kind: "valid",
      href: path,
    });
    expect(parseProjectAddress(path, "?work=")).toMatchObject({
      kind: "invalid",
      reason: "conflicting-work",
    });
    expect(parseProjectAddress(path, "?work=other")).toMatchObject({
      kind: "invalid",
      reason: "conflicting-work",
    });
    expect(parseProjectAddress("/p/serial/scratch/notes.md", "?work=")).toMatchObject({
      kind: "valid",
      href: "/p/serial/scratch/notes.md",
    });
    expect(parseProjectAddress("/p/serial/scratch/notes.md", "?work=revision").kind).toBe(
      "invalid",
    );
  });
});
