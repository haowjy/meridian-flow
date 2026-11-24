import type { KeyboardEvent } from "react";

export function tabListKeys<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (value: T) => void,
) {
  const tabStop = values.includes(value) ? value : values[0];
  return {
    tabIndex: (tab: T) => (tab === tabStop ? 0 : -1),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const at = values.indexOf(value);
      const last = values.length - 1;
      const next =
        event.key === "ArrowRight"
          ? at >= last
            ? 0
            : at + 1
          : event.key === "ArrowLeft"
            ? at <= 0
              ? last
              : at - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? last
                : null;
      const target = next === null ? undefined : values[next];
      if (target === undefined) return;
      event.preventDefault();
      onChange(target);
      event.currentTarget
        .querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(target)}"]`)
        ?.focus();
    },
  };
}
