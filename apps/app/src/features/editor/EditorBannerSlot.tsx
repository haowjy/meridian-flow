/**
 * EditorBannerSlot — the editor's single-occupancy strip below the toolbar.
 * Tenants are ordered from highest to lowest priority; the first tenant with
 * content owns the surface and every lower-priority tenant yields.
 */
import type { ReactNode } from "react";

export type EditorBannerTenant = {
  name: string;
  content: ReactNode;
};

export type EditorBannerSlotProps = {
  /** Highest priority first. A nullish content value means the tenant is inactive. */
  tenants: readonly EditorBannerTenant[];
};

export function EditorBannerSlot({ tenants }: EditorBannerSlotProps) {
  const occupant = tenants.find((tenant) => tenant.content != null);
  return occupant?.content ?? null;
}
