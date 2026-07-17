/**
 * EditorBannerSlot — the editor's single-occupancy strip below the toolbar.
 * Tenants are ordered from highest to lowest priority; the first tenant with
 * content owns the surface and every lower-priority tenant yields.
 */
import { Fragment, type ReactElement } from "react";

export type EditorBannerContent = ReactElement | null;

export type EditorBannerTenant = {
  name: string;
  content: EditorBannerContent;
};

export type EditorBannerSlotProps = {
  /** Highest priority first. React-empty content means the tenant is inactive. */
  tenants: readonly EditorBannerTenant[];
};

export function EditorBannerSlot({ tenants }: EditorBannerSlotProps) {
  const occupant = tenants.find((tenant) => Boolean(tenant.content));
  return occupant ? <Fragment key={occupant.name}>{occupant.content}</Fragment> : null;
}
