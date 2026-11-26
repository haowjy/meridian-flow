import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PanelToggleSpacer } from "./PanelToggleButton";

export type PaneHeaderRailToggle = { open: boolean };

export type PaneHeaderProps = {
  title: ReactNode;
  left?: PaneHeaderRailToggle;
  right?: PaneHeaderRailToggle;
  actions?: ReactNode;
  leading?: ReactNode;
  notice?: ReactNode;
};

export function PaneHeader({ title, left, right, actions, leading, notice }: PaneHeaderProps) {
  const leftToggle = left && !left.open;
  return (
    <div className="tab-band shrink-0">
      <header className="flex h-full items-center gap-x-1 pr-2">
        {leftToggle ? <PanelToggleSpacer /> : null}
        {leading ? (
          <div className={cn("-mr-1 flex shrink-0 self-stretch", leftToggle && "-ml-0.5")}>
            {leading}
          </div>
        ) : null}

        <div className="relative flex min-w-0 flex-1 items-center self-stretch">{title}</div>

        <div className="ml-auto flex shrink-0 items-center gap-1 self-stretch">
          {actions}
          {right && !right.open ? <PanelToggleSpacer /> : null}
        </div>
      </header>
      {notice ? (
        <div className="absolute inset-x-2 top-full z-20 mt-1 rounded-md border border-border bg-card shadow-float">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
