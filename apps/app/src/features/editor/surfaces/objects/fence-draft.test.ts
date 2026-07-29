// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Mapping } from "@tiptap/pm/transform";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { fenceRebaseAfter, fenceSourceTransaction, minimalTextPatch } from "./fence-draft";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

const SOURCE = "flowchart TD\n  A --> B";

function mount(): { editor: Editor; pos: number } {
  const element = document.createElement("div");
  document.body.append(element);
  const mounted = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        {
          type: "code_block",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: SOURCE }],
        },
      ],
    },
  });
  editor = mounted;

  let pos = -1;
  mounted.state.doc.descendants((node, at) => {
    if (node.type.name === "code_block") pos = at;
    return true;
  });
  return { editor: mounted, pos };
}

function fenceText(mounted: Editor): string {
  let text = "";
  mounted.state.doc.descendants((node) => {
    if (node.type.name === "code_block") text = node.textContent;
    return true;
  });
  return text;
}

/** Apply a patch the way `fenceSourceTransaction` does, to prove it reconstructs. */
function apply(current: string, patch: ReturnType<typeof minimalTextPatch>): string {
  if (!patch) return current;
  return current.slice(0, patch.from) + patch.text + current.slice(patch.to);
}

/** The pane's state right after it rendered `SOURCE`: no edits have landed yet. */
function freshRebase(pos: number) {
  return { source: SOURCE, start: pos + 1, mapping: new Mapping() };
}

describe("editing a fence from the source pane", () => {
  it("applies the writer's edit", () => {
    const { editor: mounted, pos } = mount();

    const transaction = fenceSourceTransaction(
      mounted.state,
      freshRebase(pos),
      SOURCE.replace("A --> B", "A --> BC"),
    );
    expect(transaction).not.toBeNull();
    if (transaction) mounted.view.dispatch(transaction);

    expect(fenceText(mounted)).toBe("flowchart TD\n  A --> BC");
  });

  it("keeps a collaborator's text that landed while the pane was open", () => {
    const { editor: mounted, pos } = mount();
    const rebase = freshRebase(pos);

    // A peer inserts a line at the top of the fence. The textarea still shows
    // what it rendered — the writer never saw this line.
    const remote = mounted.state.tr.insertText("  X --> Y\n", pos + 1);
    mounted.view.dispatch(remote);
    const rebased = fenceRebaseAfter(rebase, remote);

    // The writer, meanwhile, has typed a character at the end of their line.
    const transaction = fenceSourceTransaction(
      mounted.state,
      rebased,
      SOURCE.replace("A --> B", "A --> BC"),
    );
    expect(transaction).not.toBeNull();
    if (transaction) mounted.view.dispatch(transaction);

    const text = fenceText(mounted);
    expect(text).toContain("X --> Y");
    expect(text).toContain("A --> BC");
  });

  it("refuses to write when the fence is gone", () => {
    const { editor: mounted, pos } = mount();
    const rebase = freshRebase(pos);

    const node = mounted.state.doc.nodeAt(pos);
    if (!node) throw new Error("expected a fence");
    const removal = mounted.state.tr.delete(pos, pos + node.nodeSize);
    mounted.view.dispatch(removal);
    const rebased = fenceRebaseAfter(rebase, removal);

    expect(fenceSourceTransaction(mounted.state, rebased, `${SOURCE}C`)).toBeNull();
  });

  it("refuses to write into a block that stopped being a diagram", () => {
    const { editor: mounted, pos } = mount();
    const rebase = freshRebase(pos);

    const node = mounted.state.doc.nodeAt(pos);
    if (!node) throw new Error("expected a fence");
    const converted = mounted.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language: "typescript",
    });
    mounted.view.dispatch(converted);

    expect(
      fenceSourceTransaction(mounted.state, fenceRebaseAfter(rebase, converted), `${SOURCE}C`),
    ).toBeNull();
  });

  it("has nothing to do when the text is unchanged", () => {
    const { editor: mounted, pos } = mount();
    expect(fenceSourceTransaction(mounted.state, freshRebase(pos), SOURCE)).toBeNull();
  });
});

describe("minimal source patches", () => {
  const cases: ReadonlyArray<{ name: string; from: string; to: string }> = [
    {
      name: "a character typed mid-line",
      from: "flowchart TD\n  A --> B",
      to: "flowchart TD\n  A --> BC",
    },
    { name: "a character deleted", from: "flowchart TD", to: "flowchart T" },
    { name: "a label renamed", from: "A[Gate opens]", to: "A[Gate yields]" },
    { name: "a line inserted", from: "a\nb", to: "a\nmiddle\nb" },
    { name: "everything replaced", from: "graph TD", to: "sequenceDiagram" },
    { name: "emptied", from: "flowchart TD", to: "" },
    { name: "filled from empty", from: "", to: "flowchart TD" },
  ];

  for (const { name, from, to } of cases) {
    it(`reconstructs: ${name}`, () => {
      expect(apply(from, minimalTextPatch(from, to))).toBe(to);
    });
  }

  it("is null when nothing changed, so no transaction is dispatched", () => {
    expect(minimalTextPatch("flowchart TD", "flowchart TD")).toBeNull();
  });

  it("touches only what changed", () => {
    // The point of the whole function: a peer's caret inside the diagram
    // survives, and the change trail does not read as a rewrite.
    const before = "flowchart TD\n  A[Vault] --> B[Warden]\n  B --> C[Gate]";
    const after = before.replace("Warden", "Sentinel");
    const patch = minimalTextPatch(before, after);

    expect(patch).not.toBeNull();
    expect(patch && patch.to - patch.from).toBeLessThan(before.length / 2);
    expect(patch?.text).toBe("Sentinel");
  });

  it("keeps a repeated run from over-matching", () => {
    // Prefix and suffix scans must not cross each other on repetitive text.
    const patch = minimalTextPatch("aaaa", "aa");
    expect(patch).not.toBeNull();
    expect(apply("aaaa", patch)).toBe("aa");
  });
});
