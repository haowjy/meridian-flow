/** Browser grammar contracts: screen-first paths, exact filenames, and lossless raw query parsing. */
import { describe, expect, it } from "vitest";
import { parseProjectAddress, projectAddressHref, projectAddressState } from "./project-address";

const P = "/p/550e8400-e29b-41d4-a716-446655440000";
const WORK = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_WORK = "223e4567-e89b-42d3-a456-426614174000";
const CHAT = "00000000-0000-4000-8000-000000000000";
const ROOT = "323e4567-e89b-42d3-a456-426614174000";

function parse(href: string) {
  const cut = href.indexOf("?");
  return cut < 0
    ? parseProjectAddress(href)
    : parseProjectAddress(href.slice(0, cut), href.slice(cut));
}

describe("readable project addresses", () => {
  it("parses the bare project as the chat index whose canonical href names the screen", () => {
    expect(parse(P)).toMatchObject({
      kind: "valid",
      address: {
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        destination: { kind: "chat-index" },
      },
      href: `${P}/chats`,
    });
    expect(parse(`${P}/`)).toMatchObject({ kind: "valid", href: `${P}/chats` });
    expect(parse("/p/serial").kind).toBe("invalid");
  });

  it.each([
    [`${P}/chats`, { kind: "chat-index" }],
    [`${P}/chats/${CHAT}`, { kind: "chat", chatId: CHAT }],
    [`${P}/works`, { kind: "works" }],
    [`${P}/works?view=archived`, { kind: "works" }],
    [`${P}/works/new`, { kind: "works-new" }],
    [`${P}/works/${WORK}`, { kind: "work", workId: WORK }],
    [`${P}/works/${WORK}?view=files`, { kind: "work", workId: WORK }],
    [`${P}/editor`, { kind: "editor" }],
    [`${P}/editor/manuscript/Volume%201/Chapter%20%231.md`, { kind: "document" }],
    [`${P}/editor/manuscript/chapter.md?work=${WORK}`, { kind: "document" }],
    [`${P}/editor/kb/%E4%BF%AE%E7%82%BC.md`, { kind: "document" }],
    [`${P}/editor/user/100%25.md`, { kind: "document" }],
    [`${P}/editor/unfiled/draft.md`, { kind: "document" }],
    [`${P}/editor/manuscript/literal%252F.md`, { kind: "document" }],
    [`${P}/editor/scratch/notes.md?work=${WORK}`, { kind: "document", scheme: "scratch" }],
    [`${P}/editor/scratch/notes.md?chat=${ROOT}`, { kind: "document", scheme: "scratch" }],
    [`${P}/editor/browse/scratch/duel?chat=${ROOT}`, { kind: "browse", scheme: "scratch" }],
    [`${P}/editor/uploads/cover.png?work=`, { kind: "document", scheme: "uploads" }],
    [`${P}/editor/uploads/cover.png?work=${WORK}`, { kind: "document", scheme: "uploads" }],
    [`${P}/editor/browse`, { kind: "browse", scheme: null, path: "" }],
    [`${P}/editor/browse/manuscript`, { kind: "browse", scheme: "manuscript", path: "" }],
    [`${P}/editor/browse/manuscript/Volume%201`, { kind: "browse", path: "Volume 1" }],
  ])("round trips %s", (href, destination) => {
    const parsed = parse(href);
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    expect(parsed.address.destination).toMatchObject(destination);
    expect(parsed.href).toBe(href);
    expect(projectAddressHref(parsed.address)).toBe(href);
  });

  it.each([
    // Representative obsolete shapes: no alias, no redirect.
    `${P}/manuscript/chapter.md`,
    `${P}/works/${WORK}/scratch/notes.md`,
    `${P}/chat/${CHAT}`,
    `${P}/works/@revision`,
    // Unknown screens and malformed documents.
    `${P}/settings`,
    `${P}/editor/manuscript`,
    `${P}/editor/nope/leaf.md`,
    `${P}/editor/manuscript/a%2Fb.md`,
    `${P}/editor/manuscript/a%5Cb.md`,
    `${P}/editor/manuscript/a\\b.md`,
    `${P}/editor/manuscript/%`,
    `${P}/editor/manuscript/a%3Fb.md`,
    `${P}/editor/manuscript/..`,
    `${P}/editor/manuscript/%40draft.md`,
    `${P}/editor/manuscript//leaf.md`,
    `${P}/editor/manuscript/%20trimmed.md`,
  ])("rejects %s", (href) => {
    expect(parse(href).kind).toBe("invalid");
  });

  it.each([
    `${P}/editor/scratch/notes.md`,
    `${P}/editor/uploads/cover.png`,
    `${P}/editor/browse/scratch`,
    `${P}/editor/scratch/notes.md?work=`,
    `${P}/editor/scratch/notes.md?chat=fight-scene`,
    `${P}/editor/scratch/notes.md?work=${WORK}&chat=${ROOT}`,
    `${P}/editor/scratch/notes.md?work=fight-scene`,
    `${P}/editor/browse/uploads?work=%40revision`,
  ])("a Work-owned resource requires its Work: rejects %s", (href) => {
    expect(parse(href)).toMatchObject({ kind: "invalid", reason: "work" });
  });

  it("names a Work-owned resource's Work in the query, including No Work", () => {
    expect(parse(`${P}/editor/scratch/notes.md?work=${WORK.toUpperCase()}`)).toMatchObject({
      address: { destination: { kind: "document", scheme: "scratch" }, work: { id: WORK } },
      href: `${P}/editor/scratch/notes.md?work=${WORK}`,
    });
    expect(parse(`${P}/editor/uploads/cover.png?work=`)).toMatchObject({
      address: { work: { kind: "none" } },
      href: `${P}/editor/uploads/cover.png?work=`,
    });
    // The same path under two Works is two addresses.
    expect(parse(`${P}/editor/scratch/notes.md?work=${OTHER_WORK}`)).toMatchObject({
      href: `${P}/editor/scratch/notes.md?work=${OTHER_WORK}`,
    });
  });

  it("names a chat's Scratch by its lineage in `?chat=`, never a Work", () => {
    const parsed = parse(`${P}/editor/scratch/duel/beats.md?chat=${ROOT.toUpperCase()}`);
    expect(parsed).toMatchObject({
      kind: "valid",
      address: { lineage: ROOT, work: { kind: "absent" } },
      href: `${P}/editor/scratch/duel/beats.md?chat=${ROOT}`,
    });
    // Only Scratch has a lineage; other schemes ignore the parameter and never write it.
    expect(parse(`${P}/editor/manuscript/chapter.md?chat=${ROOT}`)).toMatchObject({
      kind: "valid",
      href: `${P}/editor/manuscript/chapter.md`,
    });
  });

  it("normalizes UUID case and trailing slash, never document case", () => {
    expect(parse(`${P.toUpperCase().replace("/P/", "/p/")}/editor/kb/Chapter.md/`)).toMatchObject({
      kind: "valid",
      href: `${P}/editor/kb/Chapter.md`,
    });
  });

  it("owns the Work page and list views in the URL and omits their defaults", () => {
    expect(parse(`${P}/works/${WORK}?view=chats`)).toMatchObject({ href: `${P}/works/${WORK}` });
    expect(parse(`${P}/works?view=active`)).toMatchObject({ href: `${P}/works` });
    // Each view value belongs to one destination.
    expect(parse(`${P}/works?view=files`)).toMatchObject({ href: `${P}/works` });
    expect(parse(`${P}/works/${WORK}?view=deleted`)).toMatchObject({
      href: `${P}/works/${WORK}`,
    });
    expect(parse(`${P}/works/${WORK}?view=files&view=chats`).kind).toBe("invalid");
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

  it.each([
    `${P}/chats`,
    `${P}/editor`,
  ])("departure selection state is stable after parsing %s", (href) => {
    const parsed = parse(href);
    if (parsed.kind !== "valid") throw new Error(parsed.reason);
    const state = projectAddressState({ ...parsed.address, work: { kind: "none" } });
    const restored = parseProjectAddress(href, "", state);
    if (restored.kind !== "valid") throw new Error(restored.reason);
    expect(projectAddressState(restored.address, state)).toEqual(state);
  });

  it.each([
    `?work=${WORK}&work=`,
    "?settings=profile&settings=usage",
    "?results=&results=1",
    "?unknown=%FE",
  ])("rejects raw query ambiguity %s", (search) => {
    expect(parseProjectAddress(`${P}/editor`, search).kind).toBe("invalid");
  });

  it("keeps each query key to the screens it belongs to", () => {
    expect(
      parse(
        `${P}/editor/manuscript/chapter.md?work=${WORK.toUpperCase()}&settings=usage&doc=ignored&unknown=1`,
      ),
    ).toMatchObject({ href: `${P}/editor/manuscript/chapter.md?work=${WORK}&settings=usage` });
    expect(
      parse(`${P}/chats/${CHAT}?work=${WORK}&doc=ignored&results=&settings=profile`),
    ).toMatchObject({ href: `${P}/chats/${CHAT}?results=&settings=profile` });
    expect(parse(`${P}/works/${WORK}?work=${OTHER_WORK}&results=`)).toMatchObject({
      href: `${P}/works/${WORK}`,
    });
  });
});
