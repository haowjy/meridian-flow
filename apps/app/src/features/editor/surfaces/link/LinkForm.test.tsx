// @vitest-environment jsdom
/**
 * The link form hangs its destination suggestions below the whole form, so
 * they never cover Save (gate probe 10). Pinned at the form, where dropping
 * the anchor is the regression.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLinkSurface, openLinkForm } from "@/core/editor/links";
import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";

import { LinkForm } from "./LinkForm";

const closedSnapshot = { open: false, items: [], activeIndex: -1, anchorRect: null, label: "" };
const closedMenu = { subscribe: () => () => {}, snapshot: () => closedSnapshot };
const transports: { anchorRect?: () => DOMRect | null; input: HTMLInputElement }[] = [];

vi.mock("@/core/completion", async (original) => ({
  ...(await original<typeof import("@/core/completion")>()),
  createDomInputSuggestionTransport: (options: {
    anchorRect?: () => DOMRect | null;
    input: HTMLInputElement;
  }) => {
    transports.push(options);
    return { sync: () => {}, destroy: () => {} };
  },
  createReferenceBrowserController: () => ({ menu: closedMenu }),
}));
const catalog = { port: {}, openContext: () => null, label: "Link a file" };
vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => catalog,
}));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;
let standalone: StandaloneEditor;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  transports.length = 0;
  standalone = createStandaloneEditor({ content: "<p>Ask Kael</p>" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  standalone.destroy();
});

describe("LinkForm", () => {
  it("anchors destination suggestions to the whole form, not the caret", () => {
    const { editor } = standalone;
    editor.commands.setTextSelection({ from: 5, to: 9 });
    openLinkForm(editor);
    const surface = getLinkSurface(editor);
    const form = surface?.state.form;
    if (!surface || !form) throw new Error("link form did not open");

    act(() => root.render(<LinkForm editor={editor} surface={surface} form={form} />));

    const transport = transports.at(-1);
    const element = document.querySelector("form");
    expect(transport?.anchorRect).toBeTypeOf("function");
    expect(element).not.toBeNull();
    const formRect = element?.getBoundingClientRect();
    expect(transport?.anchorRect?.()).toEqual(formRect);
  });
});
