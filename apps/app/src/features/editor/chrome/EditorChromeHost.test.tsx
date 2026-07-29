// @vitest-environment jsdom
/**
 * Which editor's chrome is on screen.
 *
 * The desktop context host keeps several editors mounted and hides the
 * inactive ones with `hidden`. That works for the manuscript, which is in the
 * hidden element, and does nothing at all for chrome, which portals to the
 * body — so the host itself has to say who is visible.
 */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

vi.mock("./chrome-surfaces", () => ({
  EDITOR_CHROME_SURFACES: [{ id: "probe", render: () => <div data-testid="probe-surface" /> }],
}));

const { EditorChromeHost } = await import("./EditorChromeHost");

let editor: Editor | null = null;
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
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editor?.destroy();
  editor = null;
  root = null;
  container = null;
});

describe("EditorChromeHost", () => {
  it("mounts every registered surface for the editor the writer is reading", () => {
    act(() => root?.render(<EditorChromeHost editor={editor} />));
    expect(container?.querySelector("[data-testid='probe-surface']")).not.toBeNull();
  });

  it("mounts nothing for an editor kept warm behind the visible one", () => {
    act(() => root?.render(<EditorChromeHost editor={editor} active={false} />));
    expect(container?.querySelector("[data-testid='probe-surface']")).toBeNull();
  });

  it("mounts nothing before an editor exists", () => {
    act(() => root?.render(<EditorChromeHost editor={null} />));
    expect(container?.querySelector("[data-testid='probe-surface']")).toBeNull();
  });
});
