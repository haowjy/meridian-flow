/** Browser grammar contracts: screen-first paths, exact filenames, and lossless raw query parsing. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";

const P = "/p/550e8400-e29b-41d4-a716-446655440000";
const WORK = "123e4567-e89b-42d3-a456-426614174000";

function parse(href: string) {
  const cut = href.indexOf("?");
  return cut < 0
    ? parseProjectAddress(href)
    : parseProjectAddress(href.slice(0, cut), href.slice(cut));
}

describe("readable project addresses", () => {
  it.each([
    [`${P}/editor/manuscript/literal%252F.md`, { kind: "document" }],
  ])("round trips %s", (href, destination) => {
    const parsed = parse(href);
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    expect(parsed.address.destination).toMatchObject(destination);
    expect(parsed.href).toBe(href);
    expect(projectAddressHref(parsed.address)).toBe(href);
  });

  it.each([
    `${P}/editor/nope/leaf.md`,
    `${P}/editor/manuscript/a%2Fb.md`,
    `${P}/editor/manuscript/..`,
  ])("rejects %s", (href) => {
    expect(parse(href).kind).toBe("invalid");
  });

  it.each([
    `${P}/editor/scratch/notes.md`,
  ])("a Work-owned resource requires its Work: rejects %s", (href) => {
    expect(parse(href)).toMatchObject({ kind: "invalid", reason: "work" });
  });

  it("round trips review identity only on an Editor document", () => {
    const href = `${P}/editor/manuscript/chapter.md?work=${WORK}&draft=draft%2Fone`;
    expect(parse(href)).toMatchObject({
      kind: "valid",
      href,
      address: { draftId: "draft/one" },
    });
    const editor = parse(`${P}/editor?draft=draft-one`);
    expect(editor).toMatchObject({ kind: "valid", href: `${P}/editor` });
    if (editor.kind !== "valid") throw new Error(editor.reason);
    expect(editor.address).not.toHaveProperty("draftId");
    expect(parse(`${P}/chats?draft=draft-one`)).toMatchObject({ href: `${P}/chats` });
    expect(parse(`${P}/editor/manuscript/chapter.md?draft=a&draft=b`)).toMatchObject({
      kind: "invalid",
      reason: "duplicate:draft",
    });
  });

  it("states No Work on a review address so a copied link opens its own Work's draft", () => {
    // A live No Work document keeps a clean URL (history state pins it); a review address is
    // shared, so it names its Work itself. `?work=` reads back as No Work, never as absent.
    const live = parse(`${P}/editor/manuscript/chapter.md?work=`);
    if (live.kind !== "valid") throw new Error(live.reason);
    const review = { ...live.address, draftId: "draft-one" };
    expect(projectAddressHref(review)).toBe(
      `${P}/editor/manuscript/chapter.md?work=&draft=draft-one`,
    );
    expect(parse(projectAddressHref(review))).toMatchObject({
      kind: "valid",
      address: { work: { kind: "none" }, draftId: "draft-one" },
    });
    // The address already says No Work, so no history-state pin repeats it (and no write is needed).
    expect(projectAddressState(review)).toMatchObject({ meridianProjectEmptySelection: undefined });
    expect(projectAddressState(live.address).meridianProjectEmptySelection).toBeDefined();
    expect(projectAddressHref({ ...live.address, work: { kind: "none" } })).toBe(
      `${P}/editor/manuscript/chapter.md`,
    );
  });

  it("preserves absent, explicitly empty, and malformed editing contexts", () => {
    expect(parse(`${P}/editor`)).toMatchObject({ address: { work: { kind: "absent" } } });
    expect(parse(`${P}/editor?work=`)).toMatchObject({
      href: `${P}/editor`,
      address: { work: { kind: "none" } },
    });
    expect(parse(`${P}/editor/kb/a.md?work=`)).toMatchObject({
      href: `${P}/editor/kb/a.md`,
      address: { work: { kind: "none" } },
    });
    expect(parse(`${P}/editor?work=revision`)).toMatchObject({
      address: { work: { kind: "malformed", value: "revision" } },
    });
    expect(parse(`${P}/editor?work=bad%2Fwork`)).toMatchObject({
      address: { work: { kind: "malformed", value: "bad/work" } },
    });
  });

  it.each([`?work=${WORK}&work=`, "?unknown=%FE"])("rejects raw query ambiguity %s", (search) => {
    expect(parseProjectAddress(`${P}/editor`, search).kind).toBe("invalid");
  });
});
