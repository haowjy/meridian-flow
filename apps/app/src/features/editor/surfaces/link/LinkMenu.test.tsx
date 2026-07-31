// @vitest-environment jsdom
/**
 * What Copy link address does when the clipboard says no.
 *
 * The menu is the only thing on screen when the writer presses it, so it is the
 * only thing that can carry the answer. A row that fired an unobserved promise
 * and closed reported success by disappearing: the writer walked away believing
 * they had the address (law 5's silent rejection, in its most convincing form).
 * So a refusal keeps the menu open, greys the row, and says why on it.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  anchorLinkRange,
  createLinkSurface,
  type LinkMenuRequest,
  type LinkSurface,
  linkAt,
} from "@/core/editor/links";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

const { LinkMenu } = await import("./LinkMenu");

installJsdomLayout();

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

let editor: Editor | null = null;
let surface: LinkSurface | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: '<p>Kael read <a href="https://example.test/lanterns">the notice</a> twice</p>',
  });
  surface = createLinkSurface();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editor?.destroy();
  surface?.destroy();
  editor = null;
  surface = null;
  root = null;
  container = null;
  document.body.replaceChildren();
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

/** A clipboard with only the parts the test cares about, as a browser exposes it. */
function stubClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

function openMenu(): { closeMenu: ReturnType<typeof vi.fn> } {
  if (!editor || !surface) throw new Error("no editor");
  const instance = editor;
  const link = linkAt(instance.state, 12);
  if (!link) throw new Error("no link in the fixture");

  const menu: LinkMenuRequest = {
    anchor: anchorLinkRange(instance.state, { from: link.from, to: link.to }),
    href: String(link.attributes.href),
    target: null,
    identity: link.identity,
    at: { x: 0, y: 0 },
    seq: 1,
  };
  const closeMenu = vi.fn();
  const watched: LinkSurface = { ...surface, closeMenu };

  act(() => {
    root?.render(<LinkMenu editor={instance} surface={watched} menu={menu} />);
  });
  return { closeMenu };
}

function row(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no menu row for ${label}`);
  return found;
}

describe("Copy link address", () => {
  it("puts the address on the clipboard and closes on a copy that happened", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const { closeMenu } = openMenu();

    await act(async () => row("Copy link address").click());

    expect(writeText).toHaveBeenCalledWith("https://example.test/lanterns");
    expect(closeMenu).toHaveBeenCalled();
  });

  it("stays open and greys the row when the browser refuses the write", async () => {
    stubClipboard({
      writeText: vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError")),
    });
    const { closeMenu } = openMenu();

    await act(async () => row("Copy link address").click());

    // The whole point: nothing was copied, so nothing may close.
    expect(closeMenu).not.toHaveBeenCalled();
    expect(row("Copy link address").getAttribute("aria-disabled")).toBe("true");
  });

  it("says why the writer cannot copy, on the row they are standing on", async () => {
    stubClipboard({
      writeText: vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError")),
    });
    openMenu();

    await act(async () => row("Copy link address").click());
    await act(async () => row("Copy link address").focus());

    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "will not let the page write to the clipboard",
    );
  });

  it("greys from the start in a browser that never offered the page a clipboard", () => {
    stubClipboard({});
    openMenu();

    expect(row("Copy link address").getAttribute("aria-disabled")).toBe("true");
  });
});
