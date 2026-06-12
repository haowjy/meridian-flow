// @ts-nocheck
/**
 * SidebarSectionLabel — the canonical workbench section label.
 *
 * One tiny component so every section label ("Chats", "Context", "Files")
 * renders at the same weight/tracking/tone — the left-sidebar "Chats" label
 * is the reference. Children are the already-i18n'd label text.
 */
import type { ReactNode } from "react";

export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-meta font-normal uppercase tracking-section-label text-muted-foreground">
      {children}
    </span>
  );
}
