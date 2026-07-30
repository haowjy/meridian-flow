// @vitest-environment jsdom
/**
 * Which editor's chrome is on screen.
 *
 * The desktop context host keeps several editors mounted and hides the
 * inactive ones with `hidden`. That works for the manuscript, which is in the
 * hidden element, and does nothing at all for chrome, which portals to the
 * body — so the host itself has to say who is visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

vi.mock("./chrome-surfaces", () => ({
  EDITOR_CHROME_SURFACES: [{ id: "probe", render: () => <div data-testid="probe-surface" /> }],
}));

const { EditorChromeHost } = await import("./EditorChromeHost");

let page: ReactEditorFixture;

beforeEach(() => {
  page = createReactEditorFixture({ content: { type: "doc", content: [{ type: "paragraph" }] } });
});

afterEach(() => {
  page.destroy();
});

describe("EditorChromeHost", () => {
  it("mounts every registered surface for the editor the writer is reading", () => {
    page.render(<EditorChromeHost editor={page.editor} />);
    expect(page.container.querySelector("[data-testid='probe-surface']")).not.toBeNull();
  });

  it("mounts nothing for an editor kept warm behind the visible one", () => {
    page.render(<EditorChromeHost editor={page.editor} active={false} />);
    expect(page.container.querySelector("[data-testid='probe-surface']")).toBeNull();
  });

  it("mounts nothing before an editor exists", () => {
    page.render(<EditorChromeHost editor={null} />);
    expect(page.container.querySelector("[data-testid='probe-surface']")).toBeNull();
  });
});
