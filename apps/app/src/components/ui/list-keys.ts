import type { KeyboardEvent } from "react";

const TEXT_FIELD = "input, textarea, [contenteditable='true']";

/**
 * The keyboard of every picker list, as one keydown handler for the element that
 * holds the list:
 *
 * - Up and Down move between the `[data-list-item]` stops and wrap at the ends.
 * - Home and End jump to the first and last stop, except in a text field, where they
 *   move the caret.
 * - Left and Right move between the buttons of one `[data-list-row]` (a row and the
 *   actions beside it), except in a text field. A list beside other focusable content
 *   can route keys by this attribute, so a row carries it even with no actions.
 * - Enter presses the focused stop.
 *
 * A search field can be a stop too, so Down leaves it for the first row. Escape
 * stays with the surface that owns closing. The rows' focus fill comes from
 * `focus-visible`, which only keyboard navigation turns on.
 */
export function handleListKeys(event: KeyboardEvent<HTMLElement>): void {
  const target = event.target as HTMLElement;
  const inField = target.matches(TEXT_FIELD);

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (inField) return;
    const row = target.closest<HTMLElement>("[data-list-row]");
    const stops = [...(row?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const next = stops[stops.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    return;
  }

  if (event.key === "Enter") {
    if (inField || !target.matches("[data-list-item]")) return;
    event.preventDefault();
    target.click();
    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (inField && (event.key === "Home" || event.key === "End")) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-list-item]:not(:disabled)"),
  ];
  if (items.length === 0) return;
  // A row's own action counts as its row.
  const current = items.findIndex((item) =>
    (item.closest("[data-list-row]") ?? item).contains(target),
  );
  const last = items.length - 1;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : event.key === "ArrowDown"
          ? current >= last
            ? 0
            : current + 1
          : current <= 0
            ? last
            : current - 1;
  event.preventDefault();
  items[next]?.focus();
}
