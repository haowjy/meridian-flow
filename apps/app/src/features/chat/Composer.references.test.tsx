// @vitest-environment jsdom
/**
 * The composer's `@`, where the keys are actually contested.
 *
 * Enter is the whole risk: the composer has sent a message on it since the day
 * it existed, and an open menu has to take it first or picking a chapter posts
 * the half-typed question instead. Escape is the same shape against a running
 * stream, and Shift+Enter against both. The rest is the wire contract: a doc
 * that now carries atomic tokens still leaves as the one plain string
 * `onSubmit` has always received.
 */
import type { Editor } from "@tiptap/core";
import { act, createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReferenceCandidate } from "@/core/references";
import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Ask anything" }));

let candidates: ReferenceCandidate[] = [];
vi.mock("@/features/project/context/useReferenceCandidates", () => ({
  useReferenceCandidates: () => ({ candidates, revision: "r1" }),
}));

const { Composer } = await import("./Composer");
const { composerReferenceTokens, serializeComposerText } = await import("./composer-input");
type ComposerHandle = import("./Composer").ComposerHandle;

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

/** The mounted editor, which exists one effect after the composer renders. */
function editorOf(handle: { current: ComposerHandle | null }): Editor {
  const editor = handle.current?.editor;
  if (!editor) throw new Error("no composer editor");
  return editor;
}

/**
 * Types through a real transaction, then lets the microtask queue drain:
 * `@tiptap/suggestion` resolves `items()` through its async request manager
 * even when the answer is a plain array.
 */
async function type(editor: Editor, text: string) {
  await act(async () => {
    editor.commands.insertContent(text);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A key the way the browser delivers one: at the contenteditable, bubbling. */
async function press(editor: Editor, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    editor.view.dom.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function blur(editor: Editor) {
  await act(async () => {
    editor.view.dom.dispatchEvent(new window.FocusEvent("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const rows = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent);

const text = (editor: Editor) => serializeComposerText(editor.state.doc);

describe("the composer's @ menu", () => {
  beforeEach(() => {
    candidates = [document_("The Third Gate"), document_("Third Gate Aspirants")];
  });

  it("offers the project's documents, ranked, under an @ the writer just typed", async () => {
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");

        // The catalog's ranking, unchanged by the host: a title that STARTS
        // with what was typed comes before one that carries it partway in.
        expect(rows()).toEqual(["Third Gate AspirantsChapters", "The Third GateChapters"]);
      },
    );
  });

  it("stays out of an email address, which is what a lone @ usually is", async () => {
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "write to kael@thi");

        expect(rows()).toEqual([]);
      },
    );
  });

  it("takes the menu down when the writer stops typing in the composer", async () => {
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");
        expect(rows()).not.toEqual([]);

        await blur(editorOf(handle));

        expect(rows()).toEqual([]);
      },
    );
  });

  it("offers nothing at all outside a project", async () => {
    const handle = createRef<ComposerHandle>();
    await withReactRoot(<Composer ref={handle} onSubmit={() => {}} />, async () => {
      await type(editorOf(handle), "Rewrite @thi");

      expect(rows()).toEqual([]);
    });
  });
});

describe("who owns Enter", () => {
  beforeEach(() => {
    candidates = [document_("The Third Gate")];
  });

  it("picks the highlighted document instead of sending the message", async () => {
    const onSubmit = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={onSubmit} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");
        await press(editorOf(handle), "Enter");

        expect(onSubmit).not.toHaveBeenCalled();
        expect(text(editorOf(handle))).toBe("Rewrite [[The Third Gate]] ");
        expect(composerReferenceTokens(editorOf(handle).state.doc)).toHaveLength(1);
        expect(rows()).toEqual([]);
      },
    );
  });

  it("sends the serialized message — token spelling and all — once the menu is closed", async () => {
    const onSubmit = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={onSubmit} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");
        await press(editorOf(handle), "Enter"); // picks
        await press(editorOf(handle), "Enter"); // sends

        expect(onSubmit).toHaveBeenCalledWith("Rewrite [[The Third Gate]]");
        // A successful submit clears the draft.
        expect(text(editorOf(handle))).toBe("");
      },
    );
  });

  it("keeps Shift+Enter a hard break, which the menu never claimed", async () => {
    const onSubmit = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={onSubmit} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "first");
        await press(editorOf(handle), "Enter", { shiftKey: true });
        await type(editorOf(handle), "second");
        await press(editorOf(handle), "Enter");

        expect(onSubmit).toHaveBeenCalledWith("first\nsecond");
      },
    );
  });

  it("is inert while a turn is streaming — no send, and no newline sneaking in", async () => {
    const onSubmit = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={onSubmit} streaming projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "hold this thought");
        await press(editorOf(handle), "Enter");

        expect(onSubmit).not.toHaveBeenCalled();
        expect(text(editorOf(handle))).toBe("hold this thought");
      },
    );
  });

  it("moves the highlight with the arrows rather than the caret", async () => {
    candidates = [document_("The Third Gate"), document_("Third Gate Aspirants")];
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");
        await press(editorOf(handle), "ArrowDown");
        await press(editorOf(handle), "Enter");

        expect(text(editorOf(handle))).toBe("Rewrite [[The Third Gate]] ");
      },
    );
  });
});

describe("who owns Escape", () => {
  beforeEach(() => {
    candidates = [document_("The Third Gate")];
  });

  it("dismisses the menu and leaves the text, without stopping the stream", async () => {
    const onStop = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} onStop={onStop} streaming projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite @thi");
        await press(editorOf(handle), "Escape");

        expect(onStop).not.toHaveBeenCalled();
        expect(rows()).toEqual([]);
        expect(text(editorOf(handle))).toBe("Rewrite @thi");
      },
    );
  });

  it("stops the stream when no menu is open", async () => {
    const onStop = vi.fn();
    const handle = createRef<ComposerHandle>();
    await withReactRoot(
      <Composer ref={handle} onSubmit={() => {}} onStop={onStop} streaming projectId="project-1" />,
      async () => {
        await type(editorOf(handle), "Rewrite the fight");
        await press(editorOf(handle), "Escape");

        expect(onStop).toHaveBeenCalled();
      },
    );
  });
});

describe("the draft", () => {
  it("survives a streaming flip, which re-renders everything around the editor", async () => {
    candidates = [document_("The Third Gate")];
    const handle = createRef<ComposerHandle>();
    let flip: ((streaming: boolean) => void) | null = null;
    function Host() {
      const [streaming, setStreaming] = useState(false);
      flip = setStreaming;
      return (
        <Composer ref={handle} onSubmit={() => {}} streaming={streaming} projectId="project-1" />
      );
    }
    await withReactRoot(<Host />, async () => {
      await type(editorOf(handle), "Rewrite @thi");
      await press(editorOf(handle), "Enter"); // picks a token into the draft

      // ChatView flips `streaming` the moment a turn starts; the draft —
      // tokens included — must ride through the re-render untouched.
      await act(async () => flip?.(true));
      await act(async () => flip?.(false));

      expect(text(editorOf(handle))).toBe("Rewrite [[The Third Gate]] ");
      expect(composerReferenceTokens(editorOf(handle).state.doc)).toHaveLength(1);
    });
  });
});
