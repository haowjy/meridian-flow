// @vitest-environment jsdom
/**
 * The href field's completion offer: offered while the writer could mean a
 * document, aside the moment they unambiguously mean a URL, and never in the
 * way of the form's own commit.
 *
 * The keys travel the real route: the chrome kernel's document listener runs
 * the open menu's layer bindings, which is what keeps Enter-picks from
 * submitting the form and Escape from taking the form down with the menu. The
 * suite dispatches real keydowns for exactly that reason — a unit call into
 * the store would pass with the kernel wiring broken.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { createLinkSurface, type LinkSurface } from "@/core/editor/links";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";
import { EditorScopeProvider } from "../../editor-scope";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

vi.mock("@/features/project/context/useReferenceCandidates", () => ({
  useReferenceCandidates: () => ({
    candidates: [
      {
        kind: "document",
        title: "The Second Gate",
        location: "Book One",
        documentId: "doc-gate",
        uri: "manuscript://book-one/the-second-gate.md",
      },
      {
        kind: "document",
        title: "The Second Vault",
        location: "Book One",
        documentId: "doc-vault",
        uri: "manuscript://book-one/the-second-vault.md",
      },
      {
        kind: "asset",
        name: "second-map.png",
        location: "Book One",
        assetDocumentId: "doc-map",
        path: "/book-one/second-map.png",
        fileType: "image/png",
        uri: "manuscript://assets/book-one/second-map.png",
      },
    ],
    revision: "fixture",
  }),
}));

const { LinkForm } = await import("./LinkForm");

let page: ReactEditorFixture;
let surface: LinkSurface;
let closeForm: Mock<() => void>;

beforeEach(async () => {
  page = createReactEditorFixture({
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Kael read the notice" }] }],
    },
  });
  // A selection, so the form asks for a URL alone: Mod-K's power path.
  page.editor.commands.setTextSelection({ from: 11, to: 21 });
  surface = createLinkSurface();
  closeForm = vi.fn(() => surface.closeForm());

  await page.render(
    <EditorScopeProvider projectId="project-1" workId="work-1">
      <LinkForm
        editor={page.editor}
        surface={{ ...surface, closeForm }}
        form={{ at: { x: 24, y: 24 }, seq: 1 }}
      />
    </EditorScopeProvider>,
  );
});

afterEach(() => {
  page.destroy();
  surface.destroy();
  vi.restoreAllMocks();
});

function hrefInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[inputmode="url"]');
  if (!input) throw new Error("no href field in the page");
  return input;
}

/** Types the whole value, the way a controlled input hears it. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setValue) throw new Error("no value setter on HTMLInputElement");
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A real keydown, so the kernel's document listener is the thing that answers. */
async function press(input: HTMLInputElement, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}

function menuRows(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (row) => row.textContent?.trim() ?? "",
  );
}

describe("the offer", () => {
  it("offers documents for three letters, and only documents", async () => {
    await type(hrefInput(), "Sec");

    const rows = menuRows();
    expect(rows.some((row) => row.includes("The Second Gate"))).toBe(true);
    expect(rows.some((row) => row.includes("The Second Vault"))).toBe(true);
    // Scope is ["document"]: the picture standing beside them is not an href.
    expect(rows.some((row) => row.includes("second-map.png"))).toBe(false);
  });

  it("offers nothing over an empty field, where Enter means remove the link", async () => {
    await type(hrefInput(), "Sec");
    await type(hrefInput(), "");

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("never offers the create row: a form field is not a place to conjure documents", async () => {
    await type(hrefInput(), "A Chapter Nobody Wrote");

    // The engine would offer creation for this query; filtered here, the empty
    // list closes the menu instead.
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("reads the placeholder's own [[spelling]] as a query", async () => {
    await type(hrefInput(), "[[Sec");

    expect(menuRows().some((row) => row.includes("The Second Gate"))).toBe(true);
  });
});

describe("stepping aside", () => {
  it("closes the moment the writer unambiguously starts a URL", async () => {
    await type(hrefInput(), "Sec");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await type(hrefInput(), "https://sec");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("stays offered for a bare word, which normalizeLinkHref would call external", async () => {
    // The design's own boundary: a bare word upgrades to https:// at commit
    // time, and a menu using that reading would die on the third letter of a
    // title. The step-aside test is intent, not the commit-time answer.
    await type(hrefInput(), "The");

    expect(menuRows().length).toBeGreaterThan(0);
  });

  it("closes when the field loses focus", async () => {
    const input = hrefInput();
    await type(input, "Sec");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      input.blur();
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("keys while the menu is open", () => {
  it("Enter picks and fills the canonical URI, not [[Title]], and does not submit", async () => {
    const input = hrefInput();
    await type(input, "Sec");

    const enter = await press(input, "Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe("manuscript://book-one/the-second-gate.md");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(closeForm).not.toHaveBeenCalled();
  });

  it("ArrowDown moves the highlight, so Enter takes the second row", async () => {
    const input = hrefInput();
    await type(input, "Sec");

    await press(input, "ArrowDown");
    await press(input, "Enter");

    expect(input.value).toBe("manuscript://book-one/the-second-vault.md");
  });

  it("Escape dismisses the menu and leaves the form standing", async () => {
    const input = hrefInput();
    await type(input, "Sec");

    const escapeKey = await press(input, "Escape");

    expect(escapeKey.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(closeForm).not.toHaveBeenCalled();
    // Typing again is a new query, and the offer comes back.
    await type(input, "Seco");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("a click on a row fills the same URI", async () => {
    const input = hrefInput();
    await type(input, "Vault");

    const row = document.querySelector<HTMLButtonElement>('[role="option"]');
    if (!row) throw new Error("no row to click");
    await act(async () => {
      row.click();
    });

    expect(input.value).toBe("manuscript://book-one/the-second-vault.md");
  });
});

describe("keys while the menu is closed", () => {
  it("leaves Enter to the form, which commits the filled URI as the link", async () => {
    const input = hrefInput();
    await type(input, "Sec");
    await press(input, "Enter");

    // The pick closed the menu; the second Enter is the form's. jsdom performs
    // no implicit submission, so the unclaimed key is asserted directly and
    // the submit itself is dispatched.
    const enter = await press(input, "Enter");
    expect(enter.defaultPrevented).toBe(false);

    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(page.editor.getHTML()).toContain('href="manuscript://book-one/the-second-gate.md"');
    expect(closeForm).toHaveBeenCalled();
  });

  it("leaves Escape to the form's own dismissal", async () => {
    const input = hrefInput();
    await type(input, "https://example.com");

    await press(input, "Escape");

    expect(closeForm).toHaveBeenCalled();
  });
});
