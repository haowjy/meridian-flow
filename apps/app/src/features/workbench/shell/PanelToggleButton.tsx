// @ts-nocheck
/**
 * PanelToggleButton — the one collapse/expand control for every workbench rail
 * and panel (app sidebar, files column, chat dock, context rail).
 *
 * Purpose: a single source of size + spacing + hover treatment so every
 * "sidebar/panel" toggle is identical and lands on the same x across panes
 * (the collapse and its matching expand sit at the same spot — "click to open,
 * click to close without moving the mouse"). The caller supplies the icon
 * (open vs close) and the label; this owns the rest.
 */
import type { LucideIcon } from "lucide-react";

export type PanelToggleButtonProps = {
  /** Direction glyph, e.g. `PanelLeftClose` (collapse) / `PanelLeftOpen` (expand). */
  icon: LucideIcon;
  /** Accessible name + native title (one string, i18n-ready). */
  label: string;
  onClick: () => void;
};

export function PanelToggleButton({ icon: Icon, label, onClick }: PanelToggleButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="focus-ring grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
