/** Browser grammar contracts: explicit scope, exact filenames, and lossless raw query parsing. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";

describe("readable project addresses", () => {
  it("uses a UUID project root as the Chat landing and rejects slug aliases", () => {
    expect(parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000")).toMatchObject({
      kind: "valid",
      address: {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        destination: { kind: "chat-index" },
      },
      href: "/p/550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parseProjectAddress("/p/serial").kind).toBe("invalid");
    expect(parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/chats").kind).toBe(
      "invalid",
    );
  });

  it.each([
    "/p/550e8400-e29b-41d4-a716-446655440000",
    "/p/550e8400-e29b-41d4-a716-446655440000/chat/550e8400-e29b-41d4-a716-446655440000",
    "/p/550e8400-e29b-41d4-a716-446655440000/works",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/browse",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor",
    "/p/550e8400-e29b-41d4-a716-446655440000/browse",
    "/p/550e8400-e29b-41d4-a716-446655440000/browse/manuscript",
    "/p/550e8400-e29b-41d4-a716-446655440000/browse/manuscript/Volume%201",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/Volume%201/Chapter%20%231.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/kb/%E4%BF%AE%E7%82%BC.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/user/100%25.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/scratch/notes.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/scratch/notes.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/browse/uploads",
    "/p/550e8400-e29b-41d4-a716-446655440000/uploads/reference.pdf",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/literal%252F.md",
  ])("round trips %s", (path) => {
    const parsed = parseProjectAddress(path);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    expect(projectAddressHref(parsed.address)).toBe(path);
  });

  it.each([
    "/p/550e8400-e29b-41d4-a716-446655440000",
    "/p/550e8400-e29b-41d4-a716-446655440000/works",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/revision",
    "/p/550e8400-e29b-41d4-a716-446655440000",
    "/p/550e8400-e29b-41d4-a716-446655440000/editor",
  ])("departure selection state is stable after parsing %s", (href) => {
    const parsed = parseProjectAddress(href);
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    const state = projectAddressState({
      ...parsed.address,

      work: { kind: "none" },
    });
    const restored = parseProjectAddress(href, "", state);
    if (restored.kind !== "valid") throw new Error(restored.reason);
    expect(projectAddressState(restored.address, state)).toEqual(state);
  });

  it.each([
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/a%2Fb.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/a%5Cb.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/a\\b.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/%",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/%E0%A4",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/a%3Fb.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/..",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/%40draft.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript//leaf.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/manuscript/leaf.md",
    "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/browse/kb",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript",
    "/p/550e8400-e29b-41d4-a716-446655440000/chat",
    "/p/550e8400-e29b-41d4-a716-446655440000/chat/fight-scene",
    "/p/550e8400-e29b-41d4-a716-446655440000/chat/a/b",
    "/p/550e8400-e29b-41d4-a716-446655440000/chats",
    "/p/550e8400-e29b-41d4-a716-446655440000/chats/new",
    "/p/550e8400-e29b-41d4-a716-446655440000/agents",
    "/p/550e8400-e29b-41d4-a716-446655440000/publish",
    "/p/550e8400-e29b-41d4-a716-446655440000//",
    "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/%20trimmed.md",
    "/p//editor",
  ])("rejects invalid or unsupported primary %s", (path) => {
    expect(parseProjectAddress(path).kind).toBe("invalid");
  });

  it("normalizes only handles and trailing slash, never document case", () => {
    expect(
      parseProjectAddress(
        "/p/550E8400-E29B-41D4-A716-446655440000/work/ReVision/scratch/Chapter.md/",
      ),
    ).toMatchObject({
      kind: "valid",
      href: "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/scratch/Chapter.md",
    });
  });

  it("preserves absent, explicitly empty, and malformed secondary selections", () => {
    expect(parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/editor")).toMatchObject({
      address: { work: { kind: "absent" } },
    });
    expect(
      parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/editor", "?work="),
    ).toMatchObject({
      href: "/p/550e8400-e29b-41d4-a716-446655440000/editor",
      address: { work: { kind: "none" } },
    });
    expect(
      parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/editor", "?work=bad%2Fwork"),
    ).toMatchObject({
      address: {
        work: { kind: "malformed", value: "bad/work" },
      },
    });
  });

  it.each([
    "?work=a&work=",
    "?settings=profile&settings=usage",
    "?results=&results=1",
    "?unknown=%FE",
  ])("rejects raw query ambiguity %s", (search) => {
    expect(parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/editor", search).kind).toBe(
      "invalid",
    );
  });

  it("keeps document, chat, and independent Editor Work addresses distinct", () => {
    expect(
      parseProjectAddress(
        "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md",
        "?work=Revision&settings=usage&doc=ignored&unknown=1",
      ),
    ).toMatchObject({
      href: "/p/550e8400-e29b-41d4-a716-446655440000/manuscript/chapter.md?work=revision&settings=usage",
    });
    expect(
      parseProjectAddress(
        "/p/550e8400-e29b-41d4-a716-446655440000/chat/550e8400-e29b-41d4-a716-446655440000",
        "?work=revision&doc=ignored&results=&settings=profile",
      ),
    ).toMatchObject({
      href: "/p/550e8400-e29b-41d4-a716-446655440000/chat/550e8400-e29b-41d4-a716-446655440000?results=&settings=profile",
    });
  });

  it("path-owned Work cannot be overridden by query context", () => {
    const path = "/p/550e8400-e29b-41d4-a716-446655440000/work/revision/scratch/notes.md";
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
    expect(
      parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/scratch/notes.md", "?work="),
    ).toMatchObject({
      kind: "valid",
      href: "/p/550e8400-e29b-41d4-a716-446655440000/scratch/notes.md",
    });
    expect(
      parseProjectAddress(
        "/p/550e8400-e29b-41d4-a716-446655440000/scratch/notes.md",
        "?work=revision",
      ).kind,
    ).toBe("invalid");
  });
});
