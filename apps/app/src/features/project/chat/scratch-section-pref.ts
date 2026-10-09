/**
 * Whether the rail's Scratch section is expanded, remembered per viewer on this
 * device (never synced), like the current Work and chat. Collapsed by default.
 */
const KEY = "meridian:scratch-section-expanded";

export function readScratchExpanded(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeScratchExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(KEY, expanded ? "1" : "0");
  } catch {
    // Remembering the choice is best-effort when storage is unavailable.
  }
}
