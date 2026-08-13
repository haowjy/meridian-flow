/** Canonical project navigation registry. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));

import { SCREENS, screenLabel } from "./screens";

describe("project screens", () => {
  it("keeps the canonical Home, Work, Chat, Editor order", () => {
    expect(SCREENS.map(({ key }) => key)).toEqual(["home", "work", "chat", "context"]);
    expect(SCREENS.map(({ key }) => screenLabel(key))).toEqual(["Home", "Work", "Chat", "Editor"]);
  });
});
