/**
 * What counts as a reference in a message, and what deliberately does not.
 *
 * The transform runs over prose an LLM or a writer typed, so the false
 * positives are the interesting cases: a bracket pair inside a code fence, a
 * URL on a scheme the app has never heard of, and a reference already sitting
 * inside a link. The `manuscript://` arm has one more trap of its own — a URI
 * at the end of a sentence ends in a full stop, and the full stop is not part
 * of it.
 */

import { describe, expect, it } from "vitest";

import {
  REFERENCE_TAG,
  REFERENCE_TARGET_PROPERTY,
  remarkInternalReferences,
} from "./internal-references";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

/** The paragraph as `text` runs and `target→display` references. */
function read(children: Node[]): string[] {
  return children.map((child) =>
    child.data?.hName === REFERENCE_TAG
      ? `→${child.data.hProperties?.[REFERENCE_TARGET_PROPERTY]}=${child.children?.[0]?.value}`
      : String(child.value),
  );
}

function paragraph(...children: Node[]): Node {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function text(value: string): Node {
  return { type: "text", value };
}

function transformed(node: Node): string[] {
  remarkInternalReferences()(node);
  return read(node.children?.[0]?.children ?? []);
}

describe("what becomes a reference", () => {
  it("reads a wikilink out of the middle of a sentence", () => {
    expect(transformed(paragraph(text("Rewrite [[The Third Gate]] to match.")))).toEqual([
      "Rewrite ",
      "→[[The Third Gate]]=The Third Gate",
      " to match.",
    ]);
  });

  it("reads a scheme URI, and keeps it spelled the way it was sent", () => {
    expect(transformed(paragraph(text("See manuscript://chapters/a.md for it")))).toEqual([
      "See ",
      "→manuscript://chapters/a.md=manuscript://chapters/a.md",
      " for it",
    ]);
  });

  it("leaves the full stop that ended the sentence out of the URI", () => {
    expect(transformed(paragraph(text("It is in work://w1/notes.md.")))).toEqual([
      "It is in ",
      "→work://w1/notes.md=work://w1/notes.md",
      ".",
    ]);
  });

  it("reads several out of one run", () => {
    expect(transformed(paragraph(text("[[One]] and [[Two]]")))).toEqual([
      "→[[One]]=One",
      " and ",
      "→[[Two]]=Two",
    ]);
  });

  it("normalizes the target the way the resolver reads it", () => {
    expect(transformed(paragraph(text("[[  Warden Ilsever  ]]")))).toEqual([
      "→[[Warden Ilsever]]=  Warden Ilsever  ",
    ]);
  });
});

describe("what stays prose", () => {
  it("leaves a message with no reference in it entirely alone", () => {
    const tree = paragraph(text("Rewrite the fight scene"));
    expect(transformed(tree)).toEqual(["Rewrite the fight scene"]);
  });

  it("leaves a URL that leaves the app to the ordinary link renderer", () => {
    expect(transformed(paragraph(text("See https://example.com/a for it")))).toEqual([
      "See https://example.com/a for it",
    ]);
  });

  it("never looks inside code, which is source rather than prose", () => {
    const tree: Node = {
      type: "root",
      children: [
        { type: "inlineCode", value: "[[The Third Gate]]" },
        { type: "code", value: "[[The Third Gate]]" },
      ],
    };
    remarkInternalReferences()(tree);

    expect(tree.children?.map((child) => child.value)).toEqual([
      "[[The Third Gate]]",
      "[[The Third Gate]]",
    ]);
  });

  it("never puts a reference inside a link that already points somewhere", () => {
    const tree = paragraph({
      type: "link",
      children: [text("[[The Third Gate]]")],
    });
    remarkInternalReferences()(tree);

    expect(read(tree.children?.[0]?.children?.[0]?.children ?? [])).toEqual(["[[The Third Gate]]"]);
  });

  it("refuses the aliased spelling this dialect does not carry", () => {
    expect(transformed(paragraph(text("[[Kael|the warden]]")))).toEqual(["[[Kael|the warden]]"]);
  });
});
