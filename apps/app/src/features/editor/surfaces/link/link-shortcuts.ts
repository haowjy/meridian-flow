/**
 * Keyboard shortcuts as the writer's own keyboard spells them.
 *
 * ProseMirror's `Mod-k` is Cmd on macOS and Ctrl everywhere else, so a menu
 * that printed one spelling would be wrong for half the writers. Lives with
 * the link surface until a second lane needs it; it belongs in the shared
 * chrome primitives the moment one does.
 */

const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/;

function onApplePlatform(): boolean {
  return typeof navigator !== "undefined" && APPLE_PLATFORM.test(navigator.userAgent);
}

const APPLE_KEYS: Readonly<Record<string, string>> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };

/** `"Mod+K"` reads as `⌘K` on macOS and `Ctrl+K` elsewhere. */
export function shortcutLabel(spelling: string): string {
  const keys = spelling.split("+");
  if (!onApplePlatform()) return keys.map((key) => (key === "Mod" ? "Ctrl" : key)).join("+");
  return keys.map((key) => APPLE_KEYS[key] ?? key).join("");
}
