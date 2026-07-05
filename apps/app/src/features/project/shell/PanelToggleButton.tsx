/**
 * PanelToggleButton — the one collapse/expand control for every project rail
 * and panel (app sidebar, files column, chat dock, context rail).
 *
 * Purpose: a single source of size + spacing + hover treatment so every
 * "sidebar/panel" toggle is identical and lands on the same x across panes
 * (the collapse and its matching expand sit at the same spot — "click to open,
 * click to close without moving the mouse"). The caller supplies the icon
 * (open vs close) and the label; this owns the rest.
 */
import type { LucideIcon } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";

type PanelToggleButtonProps = {
  /** Direction glyph, e.g. `PanelLeftClose` (collapse) / `PanelLeftOpen` (expand). */
  icon: LucideIcon;
  /** Accessible name + native title (one string, i18n-ready). */
  label: string;
  onClick: () => void;
};

export function PanelToggleButton({ icon: Icon, label, onClick }: PanelToggleButtonProps) {
  return (
    <IconButton size="sm" aria-label={label} title={label} onClick={onClick}>
      <Icon className="size-4" aria-hidden />
    </IconButton>
  );
}
