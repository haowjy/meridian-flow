/**
 * Offers a refused rename's repair field once, as the refusal arrives. A failure
 * that was already there when the row mounted (a reload, or collapsing and expanding
 * a parent) is not offered again, and neither is one that lands while the writer
 * is typing elsewhere: the field never takes focus from another input. The failure
 * mark stays either way, and the Rename action opens the same field on request.
 */

import { useEffect } from "react";
import type { CatalogNode } from "@/client/query/context-catalog-projection";

const FRESH_MS = 5_000;
const offered = new Set<number>();

function anotherInputIsActive(): boolean {
  return Boolean(
    document.activeElement?.matches(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ),
  );
}

/** `failedAt` is when the refusal settled locally; undefined while nothing failed. */
export function useRepairOnFreshFailure(failedAt: number | undefined, openRepair: () => void) {
  useEffect(() => {
    if (failedAt === undefined || offered.has(failedAt)) return;
    offered.add(failedAt);
    if (Date.now() - failedAt > FRESH_MS || anotherInputIsActive()) return;
    openRepair();
  }, [failedAt, openRepair]);
}

/** All Files and Scratch rows distinguish move refusal from name-only repair. */
export function useEntryRenameRepair(entry: CatalogNode, openRepair: () => void, allowed = true) {
  useRepairOnFreshFailure(
    allowed && !entry.namespaceRepairMove ? entry.namespaceFailureAt : undefined,
    openRepair,
  );
}
