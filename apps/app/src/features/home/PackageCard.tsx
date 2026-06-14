// @ts-nocheck
import type { MouseEventHandler } from "react";

import { i18n } from "@/lib/i18n";

import type { PackageCardData } from "./package-card-data";

export type PackageCardProps = {
  pkg: PackageCardData;
  onSelect: (pkg: PackageCardData) => void;
};

/**
 * Compact horizontal card for the Home "Agent Packages" row.
 * Click → optimistic project create (handled by the parent).
 */
export function PackageCard({ pkg, onSelect }: PackageCardProps) {
  const Icon = pkg.icon;
  const name = i18n._(pkg.name);
  const description = i18n._(pkg.description);

  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    onSelect(pkg);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={name}
      className="surface-card focus-ring flex min-w-[200px] max-w-[280px] cursor-pointer flex-col gap-2 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted/40"
    >
      <Icon className="size-6 text-foreground" aria-hidden />
      <div className="text-sm font-medium text-foreground">{name}</div>
      <div className="line-clamp-2 text-xs text-muted-foreground">{description}</div>
    </button>
  );
}
