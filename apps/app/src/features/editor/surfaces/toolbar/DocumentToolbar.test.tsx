// @vitest-environment jsdom
/**
 * The alignment menu is a surface the kernel knows about.
 *
 * A control that opens a Radix root of its own looks right and is invisible to
 * the Esc chain: nothing orders it against a deeper surface, and its close
 * hands focus back to the trigger instead of to the prose. So the assertion is
 * the kernel's layer list rather than the DOM — the menu that rendered without
 * registering is exactly the bypass this guards.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { getEditorChrome } from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
  msg: (strings: TemplateStringsArray) => strings.join(""),
}));

const { DocumentToolbar } = await import("./DocumentToolbar");

installJsdomLayout();

let editor: Editor;
let host: HTMLElement;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a sentence" }] }],
    },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  editor.destroy();
  host.remove();
});

it("registers the open alignment menu as a chrome layer", () => {
  act(() => root.render(<DocumentToolbar editor={editor} />));

  act(() => pressAlignment());

  expect(layerIds()).toEqual(["toolbar-alignment"]);
});

it("closes the alignment menu on one Escape and leaves the chain empty", () => {
  act(() => root.render(<DocumentToolbar editor={editor} />));
  act(() => pressAlignment());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();

  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(layerIds()).toEqual([]);
});

/** Layer ids without the per-instance suffix `useChromeLayer` adds. */
function layerIds(): string[] {
  const chrome = getEditorChrome(editor);
  if (!chrome) throw new Error("kernel did not mount");
  return chrome.layers.map((layer) => layer.id.replace(/#.*$/, ""));
}

/** The writer's own door: Enter on the focused control, which Radix opens on. */
function pressAlignment(): void {
  const trigger = container.querySelector<HTMLElement>('[aria-label="Block alignment"]');
  if (!trigger) throw new Error("the alignment control never rendered");
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}
