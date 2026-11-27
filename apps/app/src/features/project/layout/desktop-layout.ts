import type { SlotDefinition } from "./types";

export const DESKTOP_PROJECT_SLOTS: SlotDefinition[] = [
  { id: "rail-l", className: "relative bg-chrome" },
  { id: "center", className: "chrome-field" },
  { id: "side", className: "relative bg-chrome" },
];

export function getDesktopGridTemplate(): {
  areas: string;
  columns: string;
  rows?: string;
} {
  return {
    areas: '"rail-l left-resize center side-resize side"',
    columns:
      "var(--project-left-width) var(--project-left-handle-width) minmax(0, 1fr) var(--project-side-handle-width) min(var(--project-side-width), calc((100% - var(--project-left-width)) / 2))",
  };
}
