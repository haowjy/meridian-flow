// @vitest-environment jsdom
/**
 * A link copied between documents keeps pointing at the same document: the
 * clipboard records each internal link's address, and every paste target
 * spells it for itself.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { createStandaloneEditorExtensions } from "../config";
import { getLinkResolution } from "./LinkSurfaceExtension";
import { LINK_ADDRESS_ATTRIBUTE } from "./link-clipboard";

const SOURCE = "manuscript://serial/volume-1/chapter-2.md";

const link = (text: string, href: string): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: "link", attrs: { href } }],
});

const COPIED: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        link("same", "chapter-1.md"),
        { type: "text", text: " " },
        link("parent", "../volume-2/chapter-1.md"),
        { type: "text", text: " " },
        link("area", "kb://cast/Lin Feng.md"),
        { type: "text", text: " " },
        link("scene", "chapter-1.md#scene-2"),
        { type: "text", text: " " },
        link("web", "https://example.com/"),
      ],
    },
  ],
};

const live: Editor[] = [];
const pairs: CollabPair[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
  for (const pair of pairs.splice(0)) pair.destroy();
});

function editor(holderUri: string | null, content: JSONContent | string = "<p></p>"): Editor {
  const created = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  live.push(created);
  getLinkResolution(created)?.registerResolver(async () => null, { baseUri: holderUri });
  return created;
}

function copy(from: Editor) {
  return from.view.serializeForClipboard(from.state.doc.slice(0, from.state.doc.content.size));
}

function hrefs(target: Editor): Record<string, string> {
  const out: Record<string, string> = {};
  target.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (mark && node.text) out[node.text] = mark.attrs.href;
  });
  return out;
}

function pasteInto(holderUri: string | null, html: string): Record<string, string> {
  const target = editor(holderUri);
  // jsdom has no ClipboardEvent; the paste path only reads its type.
  target.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
  return hrefs(target);
}

describe("copying links", () => {
  it("records each internal link's address beside the href as written", () => {
    const { dom } = copy(editor(SOURCE, COPIED));
    const recorded = [...dom.querySelectorAll("a")].map((a) => [
      a.textContent,
      a.getAttribute("data-meridian-link"),
      a.getAttribute(LINK_ADDRESS_ATTRIBUTE),
    ]);
    expect(recorded).toEqual([
      ["same", "chapter-1.md", "manuscript://serial/volume-1/chapter-1.md"],
      ["parent", "../volume-2/chapter-1.md", "manuscript://serial/volume-2/chapter-1.md"],
      ["area", "kb://cast/Lin Feng.md", "kb://cast/Lin Feng.md"],
      ["scene", "chapter-1.md#scene-2", "manuscript://serial/volume-1/chapter-1.md#scene-2"],
      ["web", null, null],
    ]);
  });

  it("writes plain text with full addresses, so it means the same thing anywhere", () => {
    expect(copy(editor(SOURCE, COPIED)).text).toBe(
      "[same](manuscript://serial/volume-1/chapter-1.md) [parent](manuscript://serial/volume-2/chapter-1.md) [area](<kb://cast/Lin Feng.md>) [scene](manuscript://serial/volume-1/chapter-1.md#scene-2) [web](https://example.com/)",
    );
  });

  it("records nothing it cannot resolve: a relative link with no holder", () => {
    const { dom, text } = copy(editor(null, COPIED));
    expect(dom.querySelector("a")?.hasAttribute(LINK_ADDRESS_ATTRIBUTE)).toBe(false);
    expect(text).toContain("[same](chapter-1.md)");
  });
});

describe("pasting links into an Editor", () => {
  const copied = () => copy(editor(SOURCE, COPIED)).dom.innerHTML;

  it("keeps the same folder relative", () => {
    expect(pasteInto("manuscript://serial/volume-1/chapter-3.md", copied())).toEqual({
      same: "chapter-1.md",
      parent: "../volume-2/chapter-1.md",
      area: "kb://cast/Lin Feng.md",
      scene: "chapter-1.md#scene-2",
      web: "https://example.com/",
    });
  });

  it("re-spells for another folder so each link reaches the same document", () => {
    expect(pasteInto("manuscript://serial/notes/plan.md", copied())).toEqual({
      same: "../volume-1/chapter-1.md",
      parent: "../volume-2/chapter-1.md",
      area: "kb://cast/Lin Feng.md",
      scene: "../volume-1/chapter-1.md#scene-2",
      web: "https://example.com/",
    });
  });

  it("uses full addresses in another area", () => {
    expect(pasteInto("scratch://@revision/plan.md", copied())).toEqual({
      same: "manuscript://serial/volume-1/chapter-1.md",
      parent: "manuscript://serial/volume-2/chapter-1.md",
      area: "kb://cast/Lin Feng.md",
      scene: "manuscript://serial/volume-1/chapter-1.md#scene-2",
      web: "https://example.com/",
    });
  });

  it("uses full addresses in a document with no address yet", () => {
    expect(pasteInto(null, copied())).toMatchObject({
      same: "manuscript://serial/volume-1/chapter-1.md",
      area: "kb://cast/Lin Feng.md",
    });
  });

  it("keeps an href with no recorded address unchanged", () => {
    expect(
      pasteInto(
        "manuscript://serial/notes/plan.md",
        '<p><a data-meridian-link="../cast/Kael.md">Kael</a> <a href="https://example.com/">web</a></p>',
      ),
    ).toEqual({ Kael: "../cast/Kael.md", web: "https://example.com/" });
  });

  it("ignores a recorded address that is not a document address", () => {
    expect(
      pasteInto(
        "manuscript://serial/notes/plan.md",
        `<p><a data-meridian-link="chapter-1.md" ${LINK_ADDRESS_ATTRIBUTE}="javascript:alert(1)">x</a></p>`,
      ),
    ).toEqual({ x: "chapter-1.md" });
  });

  it("survives the app editor's paste sanitizer, which runs first", () => {
    const pair = createCollabPair({ type: "doc", content: [{ type: "paragraph" }] });
    pairs.push(pair);
    getLinkResolution(pair.local)?.registerResolver(async () => null, {
      baseUri: "manuscript://serial/notes/plan.md",
    });
    pair.local.view.pasteHTML(copied(), new Event("paste") as ClipboardEvent);
    expect(hrefs(pair.local)).toMatchObject({
      same: "../volume-1/chapter-1.md",
      parent: "../volume-2/chapter-1.md",
    });
  });

  it("keeps a `#` or `%` in a filename part of the document's name", () => {
    const special: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            link("hash", "ch%233.md"),
            { type: "text", text: " " },
            link("pct", "100%25.md#intro"),
          ],
        },
      ],
    };
    const { dom, text } = copy(editor("manuscript://a/b.md", special));
    expect(
      [...dom.querySelectorAll("a")].map((a) => a.getAttribute(LINK_ADDRESS_ATTRIBUTE)),
    ).toEqual(["manuscript://a/ch%233.md", "manuscript://a/100%25.md#intro"]);
    expect(text).toBe("[hash](manuscript://a/ch%233.md) [pct](manuscript://a/100%25.md#intro)");
    expect(pasteInto("manuscript://a/q.md", dom.innerHTML)).toEqual({
      hash: "ch%233.md",
      pct: "100%25.md#intro",
    });
    expect(pasteInto("manuscript://z/q.md", dom.innerHTML)).toEqual({
      hash: "../a/ch%233.md",
      pct: "../a/100%25.md#intro",
    });
  });

  it("records a contextual Scratch link with its holder's Work", () => {
    const scratch: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [link("plan", "scratch://plan.md")] }],
    };
    const { dom } = copy(editor("scratch://@revision/notes/a.md", scratch));
    expect(dom.querySelector("a")?.getAttribute(LINK_ADDRESS_ATTRIBUTE)).toBe(
      "scratch://@revision/plan.md",
    );
    expect(pasteInto("scratch://@second-pass/b.md", dom.innerHTML)).toEqual({
      plan: "scratch://@revision/plan.md",
    });
    expect(pasteInto("scratch://@revision/b.md", dom.innerHTML)).toEqual({ plan: "plan.md" });
  });
});
