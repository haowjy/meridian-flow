/** Browser grammar contracts: kind-first paths, exact filenames, owners only where the path is not enough. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, withoutReview } from "./project-address";

const P = "/p/550e8400-e29b-41d4-a716-446655440000";
const WORK = "123e4567-e89b-42d3-a456-426614174000";
const ROOT = "323e4567-e89b-42d3-a456-426614174000";

function parse(href: string) {
  const cut = href.indexOf("?");
  return cut < 0
    ? parseProjectAddress(href)
    : parseProjectAddress(href.slice(0, cut), href.slice(cut));
}

describe("readable project addresses", () => {
  it("round trips a stable change only inside a review address", () => {
    const href = `${P}/editor/manuscript/chapter.md?owner=work%3A${WORK}&item=draft-one&change=class%3Apart%2Ftwo`;
    const parsed = parse(href);
    expect(parsed).toMatchObject({ kind: "valid", href, address: { changeId: "class:part/two" } });
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    expect(projectAddressHref(parsed.address)).toBe(href);
    expect(parse(`${P}/editor/manuscript/chapter.md?change=gone`)).toMatchObject({
      href: `${P}/editor/manuscript/chapter.md`,
    });
    expect(parse(`${href}&change=other`)).toMatchObject({
      kind: "invalid",
      reason: "duplicate:change",
    });
  });

  it.each([
    [`${P}/editor/manuscript/literal%252F.md`, { kind: "document" }],
    // A Scratch document is named by its owner: a Work, or a No Work chat's lineage.
    [
      `${P}/editor/scratch/notes.md?owner=lineage%3A${ROOT}`,
      { kind: "document", scheme: "scratch" },
    ],
    [`${P}/editor/scratch/notes.md?owner=work%3A${WORK}`, { kind: "document", scheme: "scratch" }],
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
    `${P}/editor/scratch/notes.md?owner=lineage%3Afight-scene`,
    // The Work page and the browse addresses are gone, and an old `?work=` names no Scratch owner.
    `${P}/works`,
    `${P}/works/${WORK}`,
    `${P}/editor/browse/scratch`,
    `${P}/editor/scratch/notes.md?work=${WORK}`,
  ])("rejects %s", (href) => {
    expect(parse(href).kind).toBe("invalid");
  });

  it("a Scratch document requires its owner", () => {
    expect(parse(`${P}/editor/scratch/notes.md`)).toMatchObject({
      kind: "invalid",
      reason: "owner",
    });
  });

  it("a draft item requires its owner, and an owner is dropped where it names nothing", () => {
    expect(parse(`${P}/editor/manuscript/chapter.md?item=draft-one`)).toMatchObject({
      kind: "invalid",
      reason: "owner",
    });
    expect(parse(`${P}/editor/manuscript/chapter.md?owner=work%3A${WORK}`)).toMatchObject({
      kind: "valid",
      href: `${P}/editor/manuscript/chapter.md`,
    });
    expect(parse(`${P}/editor/manuscript/chapter.md?owner=${WORK}`)).toMatchObject({
      kind: "invalid",
      reason: "owner",
    });
  });

  it("round trips review identity only on an Editor document", () => {
    const href = `${P}/editor/manuscript/chapter.md?owner=lineage%3A${ROOT}&item=draft%2Fone`;
    expect(parse(href)).toMatchObject({
      kind: "valid",
      href,
      address: { itemKey: "draft/one", owner: `lineage:${ROOT}` },
    });
    const editor = parse(`${P}/editor?item=draft-one`);
    expect(editor).toMatchObject({ kind: "valid", href: `${P}/editor` });
    if (editor.kind !== "valid") throw new Error(editor.reason);
    expect(editor.address).not.toHaveProperty("itemKey");
    expect(parse(`${P}/chats?item=draft-one`)).toMatchObject({ href: `${P}/chats` });
    expect(parse(`${P}/editor/manuscript/chapter.md?item=a&item=b`)).toMatchObject({
      kind: "invalid",
      reason: "duplicate:item",
    });
  });

  it("dropping a review drops a draft's owner but keeps a Scratch document's", () => {
    const draft = parse(`${P}/editor/manuscript/chapter.md?owner=work%3A${WORK}&item=draft-one`);
    const scratch = parse(`${P}/editor/scratch/notes.md?owner=work%3A${WORK}&item=draft-one`);
    if (draft.kind !== "valid" || scratch.kind !== "valid") throw new Error("fixture");
    expect(projectAddressHref(withoutReview(draft.address))).toBe(
      `${P}/editor/manuscript/chapter.md`,
    );
    expect(projectAddressHref(withoutReview(scratch.address))).toBe(
      `${P}/editor/scratch/notes.md?owner=work%3A${WORK}`,
    );
  });

  it.each([
    `?owner=work%3A${WORK}&owner=`,
    "?unknown=%FE",
  ])("rejects raw query ambiguity %s", (search) => {
    expect(parseProjectAddress(`${P}/editor`, search).kind).toBe("invalid");
  });
});
