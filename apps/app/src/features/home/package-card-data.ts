import type { MessageDescriptor } from "@lingui/core";
import type { LucideIcon } from "lucide-react";

/**
 * Static metadata for an "Agent Package" shown on the Home screen.
 *
 * Phase 1 has no package install — clicking a card creates a plain project
 * with the package's name as the initial title. When the package system
 * lands, this contract widens with `slug` + install hooks.
 */
export type PackageCardData = {
  /** Stable identifier used as React key + future install lookup. */
  id: string;
  /** Display name (Lingui descriptor — resolved at render time). */
  name: MessageDescriptor;
  /** One-line description (Lingui descriptor). */
  description: MessageDescriptor;
  /** Lucide icon for the card. */
  icon: LucideIcon;
};
