/**
 * An archived Work is view-only. This is the one test every surface reads:
 * the Work page, its title tab, a chat bound to it, and its files in the Editor.
 */
import type { Work } from "@meridian/contracts/works";

export function isWorkReadOnly(work: Pick<Work, "archivedAt"> | null | undefined): boolean {
  return work?.archivedAt != null;
}
