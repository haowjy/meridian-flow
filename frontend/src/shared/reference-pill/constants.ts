/**
 * Reference Pill Constants
 *
 * Shared class names and config used by CM6 Mark, CM6 Widget, and React
 * consumers. Single source of truth — change once, applies everywhere.
 */

// CSS class names (defined in pill.css via @layer components)
export const PILL_CLASS = "ref-pill";
export const PILL_MARK_CLASS = "ref-pill--mark";
export const PILL_BROKEN_CLASS = "ref-pill--broken";
export const PILL_FOLDER_CLASS = "ref-pill--mark-folder";
export const PILL_ICON_CLASS = "ref-pill-icon";
export const PILL_NAME_CLASS = "ref-pill-name";
export const PILL_REMOVE_CLASS = "ref-pill-remove";

// Width of the icon/remove area — used by click handlers to detect
// whether a click was on the icon vs the text
export const ICON_AREA_WIDTH = 16;
