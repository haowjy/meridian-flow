// @vitest-environment jsdom
/**
 * The composer's physics, against a real (headless) TipTap editor.
 *
 * What these hold down is the divergence 1h shipped: a pick inserts one
 * atomic token instead of splicing text, backspace at the token's edge is
 * detach, hand-typed spellings never become tokens, and serialization is the
 * one door between the structural draft and the plain string the wire has
 * always carried.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import type { ReferenceCandidate, ReferenceCatalog } from "@/core/references";

import { createComposerExtensions } from "./composer-extensions";
import { getComposerReferenceMenu } from "./composer-reference-suggestion";
import { serializeComposerText } from "./composer-serialization";
import { composerReferenceTokens, REFERENCE_TOKEN_NODE } from "./reference-token";

const live: Editor[] = [];

afterEach(() => {
  for (const instance of live.splice(0)) instance.destroy();
});

function document_(title: string, overrides: Partial<ReferenceCandidate> = {}): ReferenceCandidate {
  return {
    kind: "document",
    title,
    location: "Chapters",
    documentId: `document-${title}`,
    uri: `manuscript://chapters/${title}.md`,
    ...overrides,
  } as ReferenceCandidate;
}

function mount(candidates: ReferenceCandidate[] = [document_("The Third Gate")]) {
  let catalog: ReferenceCatalog | null = { label: "Reference a document", candidates };
  const editor = new Editor({
    extensions: createComposerExtensions({
      catalog: () => catalog,
      placeholder: () => "Chat away",
    }),
  });
  live.push(editor);
  return {
    editor,
    withdraw() {
      catalog = null;
    },
  };
}

/**
 * Types, then lets the microtask queue drain: `@tiptap/suggestion` resolves
 * `items()` through its async request manager even when the answer is a plain
 * array, so the menu's first painted state arrives one tick after the input.
 */
async function type(editor: Editor, text: string) {
  editor.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const menu = (editor: Editor) => {
  const found = getComposerReferenceMenu(editor);
  if (!found) throw new Error("no composer reference menu");
  return found;
};

const rows = (editor: Editor) =>
  menu(editor)
    .snapshot()
    .items.map((item) => item.name);

const tokens = (editor: Editor) => composerReferenceTokens(editor.state.doc);

describe("what a pick writes", () => {
  it("inserts one atomic token carrying identity and spelling, never spliced text", async () => {
    const { editor } = mount();
    await type(editor, "Rewrite @thi");

    expect(rows(editor)).toEqual(["The Third Gate"]);
    menu(editor).chooseActive();

    expect(tokens(editor)).toEqual([
      {
        kind: "document",
        documentId: "document-The Third Gate",
        uri: "manuscript://chapters/The Third Gate.md",
        label: "The Third Gate",
        spelling: "[[The Third Gate]]",
      },
    ]);
    expect(serializeComposerText(editor.state.doc)).toBe("Rewrite [[The Third Gate]] ");
    // The `@thi` the writer typed is consumed; nothing of the query survives.
    expect(editor.state.doc.textContent).toBe("Rewrite  ");
  });

  it("spells the canonical URI when two documents answer to one title", async () => {
    const { editor } = mount([
      document_("Notes", { documentId: "document-a", uri: "manuscript://chapters/a.md" }),
      document_("Notes", { documentId: "document-b", uri: "manuscript://scratch/b.md" }),
    ]);
    await type(editor, "Look at @note");
    menu(editor).chooseActive();

    expect(tokens(editor)[0]?.spelling).toBe("manuscript://chapters/a.md");
    expect(serializeComposerText(editor.state.doc)).toBe("Look at manuscript://chapters/a.md ");
  });

  it("keeps the sentence's own space instead of doubling it mid-sentence", async () => {
    const { editor } = mount();
    await type(editor, "Rewrite @thi to match the map");
    // The caret goes back to just after `@thi`, where the writer was typing.
    editor.commands.setTextSelection("Rewrite @thi".length + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    menu(editor).chooseActive();

    expect(serializeComposerText(editor.state.doc)).toBe(
      "Rewrite [[The Third Gate]] to match the map",
    );
  });
});

describe("token physics", () => {
  it("backspace at the token's boundary deletes the whole token — that is detach", async () => {
    const { editor } = mount();
    await type(editor, "Rewrite @thi");
    menu(editor).chooseActive();
    expect(tokens(editor)).toHaveLength(1);

    // The caret hard against the pill's right edge, where a writer lands after
    // backspacing over the trailing space. (Deleting a plain character is the
    // browser's native edit, which a headless view does not emulate.)
    let boundary = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === REFERENCE_TOKEN_NODE) boundary = pos + node.nodeSize;
      return true;
    });
    editor.commands.setTextSelection(boundary);
    editor.commands.keyboardShortcut("Backspace");

    expect(tokens(editor)).toHaveLength(0);
    expect(serializeComposerText(editor.state.doc)).toBe("Rewrite  ");
  });

  it("hand-typed spellings stay plain text: only picks create tokens", async () => {
    const { editor } = mount();
    await type(editor, "See [[The Third Gate]] and manuscript://chapters/x.md");

    expect(tokens(editor)).toHaveLength(0);
    expect(serializeComposerText(editor.state.doc)).toBe(
      "See [[The Third Gate]] and manuscript://chapters/x.md",
    );
  });
});

describe("where @ opens", () => {
  it("stays out of an email address, which is what a lone @ usually is", async () => {
    const { editor } = mount();
    await type(editor, "write to kael@thi");

    expect(menu(editor).snapshot().open).toBe(false);
  });

  it("declines a query that opens with a space — that @ is the writer's own sentence", async () => {
    const { editor } = mount();
    await type(editor, "meet @ noo");

    expect(menu(editor).snapshot().open).toBe(false);
  });

  it("closes when nothing matches, leaving the writer alone with their @", async () => {
    const { editor } = mount();
    await type(editor, "Rewrite @zzz");

    expect(menu(editor).snapshot().open).toBe(false);
  });

  it("offers nothing once the catalog is withdrawn", async () => {
    const { editor, withdraw } = mount();
    withdraw();
    await type(editor, "Rewrite @thi");

    expect(menu(editor).snapshot().open).toBe(false);
  });
});

describe("serialization", () => {
  it("reads text verbatim, a hard break as a newline, and paragraphs joined on newlines", () => {
    const { editor } = mount();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first line" },
            { type: "hard_break" },
            { type: "text", text: "second line" },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "then " },
            {
              type: REFERENCE_TOKEN_NODE,
              attrs: {
                kind: "document",
                documentId: "document-1",
                uri: "manuscript://chapters/gate.md",
                label: "The Third Gate",
                spelling: "[[The Third Gate]]",
              },
            },
          ],
        },
      ],
    });

    expect(serializeComposerText(editor.state.doc)).toBe(
      "first line\nsecond line\nthen [[The Third Gate]]",
    );
  });

  it("pastes as plain text: formatting has nowhere to live in this schema", () => {
    const { editor } = mount();
    const marked = editor.schema.marks;
    // The message box carries no marks and no block structure beyond
    // paragraphs — pasted HTML has nothing to become but text.
    expect(Object.keys(marked)).toEqual([]);
    expect(Object.keys(editor.schema.nodes).sort()).toEqual([
      "doc",
      "hard_break",
      "paragraph",
      REFERENCE_TOKEN_NODE,
      "text",
    ]);
  });
});
