import type { KeyboardEvent } from "react";

const TEXT_FIELD = "input, textarea, [contenteditable='true']";

export function handleListKeys(event: KeyboardEvent<HTMLElement>): void {
  const target = event.target as HTMLElement;
  if (event.defaultPrevented || !event.currentTarget.contains(target)) return;
  const inField = target.matches(TEXT_FIELD);
  if (inField && !target.matches("[data-list-item]")) return;

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (inField) return;
    const row = target.closest<HTMLElement>("[data-list-row]");
    const buttons = [...(row?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const next = buttons[buttons.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1)];
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
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-list-item]")].filter(
    (item) => !item.matches(":disabled"),
  );
  if (items.length === 0) return;
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
