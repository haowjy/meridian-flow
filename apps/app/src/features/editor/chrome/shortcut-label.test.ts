// @vitest-environment jsdom
/**
 * The Apple branch is the one no local browser run exercises, and it is where
 * the three lanes that each owned a copy of this disagreed: one asked
 * `userAgentData.platform`, which spells it `macOS` and never matched `/Mac/`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { shortcutLabel } from "./shortcut-label";

afterEach(() => {
  vi.unstubAllGlobals();
});

function onPlatform(navigatorFields: Record<string, unknown>) {
  vi.stubGlobal("navigator", { userAgent: "", ...navigatorFields });
}

describe("shortcutLabel", () => {
  it("joins with plus signs and spells Mod as Ctrl off Apple", () => {
    onPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });

    expect(shortcutLabel("Mod+K")).toBe("Ctrl+K");
    expect(shortcutLabel("Alt+↑")).toBe("Alt+↑");
    expect(shortcutLabel("Alt+Enter")).toBe("Alt+Enter");
  });

  it("uses the Apple glyphs, unseparated, on a Mac user agent", () => {
    onPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });

    expect(shortcutLabel("Mod+K")).toBe("⌘K");
    expect(shortcutLabel("Alt+↓")).toBe("⌥↓");
    expect(shortcutLabel("Mod+Shift+V")).toBe("⌘⇧V");
  });

  it("reads userAgentData first, where macOS is spelled without a capital M", () => {
    onPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      userAgentData: { platform: "macOS" },
    });

    expect(shortcutLabel("Mod+X")).toBe("⌘X");
  });

  it("trusts userAgentData over a user agent that lies about the platform", () => {
    onPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      userAgentData: { platform: "Windows" },
    });

    expect(shortcutLabel("Mod+X")).toBe("Ctrl+X");
  });
});
