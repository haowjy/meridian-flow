/**
 * Keyboard shortcuts as the writer's own keyboard spells them.
 *
 * ProseMirror's `Mod-k` is Cmd on macOS and Ctrl everywhere else, so a menu
 * that printed one spelling would be wrong for half the writers. Every surface
 * that prints a shortcut reads it from here: three lanes each grew their own
 * platform test, and they disagreed about which navigator field to ask.
 */

const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

const APPLE_KEYS: Readonly<Record<string, string>> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };

/**
 * `userAgentData.platform` is the modern answer and spells it `macOS`, while
 * the user-agent string spells it `Macintosh` — hence the case-insensitive
 * match rather than the `/Mac/` one three lanes were carrying.
 */
function onApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return APPLE_PLATFORM.test(platform ?? navigator.userAgent);
}

/** `"Mod+K"` reads as `⌘K` on macOS and `Ctrl+K` elsewhere. */
export function shortcutLabel(spelling: string): string {
  const keys = spelling.split("+");
  if (!onApplePlatform()) return keys.map((key) => (key === "Mod" ? "Ctrl" : key)).join("+");
  return keys.map((key) => APPLE_KEYS[key] ?? key).join("");
}
