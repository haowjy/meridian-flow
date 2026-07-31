// @vitest-environment jsdom
/**
 * The composer's `@`, where the keys are actually contested.
 *
 * Enter is the whole risk: the composer has sent a message on it since the day
 * it existed, and an open menu has to take it first or picking a chapter posts
 * the half-typed question instead. Escape is the same shape against a running
 * stream. The rest is the splice — the message stays a plain string, and a
 * shared title spells the URI rather than a name the resolver would refuse.
 */
import { act } from "react";
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

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector("textarea");
  if (!element) throw new Error("no composer textarea");
  return element;
}

/** Types into the controlled textarea the way a browser does. */
async function type(value: string, caret = value.length) {
  const element = textarea();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.selectionStart = caret;
  element.selectionEnd = caret;
  await act(async () => {
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  const element = textarea();
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

const rows = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent);

describe("the composer's @ menu", () => {
  beforeEach(() => {
    candidates = [document_("The Third Gate"), document_("Third Gate Aspirants")];
  });

  it("offers the project's documents, ranked, under an @ the writer just typed", async () => {
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("Rewrite @thi");

      // The catalog's ranking, unchanged by the host: a title that STARTS with
      // what was typed comes before one that carries it partway in.
      expect(rows()).toEqual(["Third Gate AspirantsChapters", "The Third GateChapters"]);
    });
  });

  it("stays out of an email address, which is what a lone @ usually is", async () => {
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("write to kael@thi");

      expect(rows()).toEqual([]);
    });
  });

  it("closes when nothing matches, leaving the writer alone with their @", async () => {
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("Rewrite @zzz");

      expect(rows()).toEqual([]);
    });
  });

  it("offers nothing at all outside a project", async () => {
    await withReactRoot(<Composer onSubmit={() => {}} />, async () => {
      await type("Rewrite @thi");

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
    await withReactRoot(<Composer onSubmit={onSubmit} projectId="project-1" />, async () => {
      await type("Rewrite @thi");
      await press("Enter");

      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea().value).toBe("Rewrite [[The Third Gate]] ");
      expect(rows()).toEqual([]);
    });
  });

  it("sends the message once the menu is closed", async () => {
    const onSubmit = vi.fn();
    await withReactRoot(<Composer onSubmit={onSubmit} projectId="project-1" />, async () => {
      await type("Rewrite the fight");
      await press("Enter");

      expect(onSubmit).toHaveBeenCalledWith("Rewrite the fight");
    });
  });

  it("keeps Shift+Enter a newline, which the menu never claimed", async () => {
    const onSubmit = vi.fn();
    await withReactRoot(<Composer onSubmit={onSubmit} projectId="project-1" />, async () => {
      await type("Rewrite @thi");
      await press("Enter", { shiftKey: true });

      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea().value).toBe("Rewrite @thi");
    });
  });

  it("moves the highlight with the arrows rather than the caret", async () => {
    candidates = [document_("The Third Gate"), document_("Third Gate Aspirants")];
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("Rewrite @thi");
      await press("ArrowDown");
      await press("Enter");

      expect(textarea().value).toBe("Rewrite [[The Third Gate]] ");
    });
  });
});

describe("who owns Escape", () => {
  beforeEach(() => {
    candidates = [document_("The Third Gate")];
  });

  it("dismisses the menu and leaves the text, without stopping the stream", async () => {
    const onStop = vi.fn();
    await withReactRoot(
      <Composer onSubmit={() => {}} onStop={onStop} streaming projectId="project-1" />,
      async () => {
        await type("Rewrite @thi");
        await press("Escape");

        expect(onStop).not.toHaveBeenCalled();
        expect(rows()).toEqual([]);
        expect(textarea().value).toBe("Rewrite @thi");
      },
    );
  });

  it("stops the stream when no menu is open", async () => {
    const onStop = vi.fn();
    await withReactRoot(
      <Composer onSubmit={() => {}} onStop={onStop} streaming projectId="project-1" />,
      async () => {
        await type("Rewrite the fight");
        await press("Escape");

        expect(onStop).toHaveBeenCalled();
      },
    );
  });
});

describe("what a pick writes", () => {
  it("names the exact document when two of them answer to one title", async () => {
    candidates = [
      document_("Notes", { documentId: "document-a", uri: "manuscript://chapters/a.md" }),
      document_("Notes", { documentId: "document-b", uri: "manuscript://scratch/b.md" }),
    ];
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("Look at @note");
      await press("Enter");

      expect(textarea().value).toBe("Look at manuscript://chapters/a.md ");
    });
  });

  it("splices mid-sentence and keeps the rest of it", async () => {
    candidates = [document_("The Third Gate")];
    await withReactRoot(<Composer onSubmit={() => {}} projectId="project-1" />, async () => {
      await type("Rewrite @thi to match the map", 12);
      await press("Enter");

      expect(textarea().value).toBe("Rewrite [[The Third Gate]] to match the map");
    });
  });
});
