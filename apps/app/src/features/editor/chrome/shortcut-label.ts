/**
 * Keyboard shortcuts as the writer's own keyboard spells them.
 *
 * ProseMirror's `Mod-k` is Cmd on macOS and Ctrl everywhere else (§4), so a
 * surface that printed one spelling would be wrong for half the writers. Every
 * menu that shows a shortcut reads it from here: the formatting menu and the
 * link menu sit one rung apart in the same claim ladder, and a writer who saw
 * `⌘X` in one and `Ctrl+X` in the other would be reading two editors.
 *
 * Read from the browser rather than configured: the shortcut is the OS's, not
 * the document's.
 */

const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/;
const APPLE_KEYS: Readonly<Record<string, string>> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };

function onApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return APPLE_PLATFORM.test(navigator.platform || navigator.userAgent);
}

/** `"Mod+K"` reads as `⌘K` on macOS and `Ctrl+K` elsewhere. */
export function shortcutLabel(spelling: string): string {
  const keys = spelling.split("+");
  if (!onApplePlatform()) return keys.map((key) => (key === "Mod" ? "Ctrl" : key)).join("+");
  return keys.map((key) => APPLE_KEYS[key] ?? key).join("");
}
