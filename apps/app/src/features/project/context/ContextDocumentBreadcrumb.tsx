// @ts-nocheck
/**
 * Shared path-breadcrumb for a context document — used by the live editor
 * header (TRACKED tabs) and the viewer chrome. Drops the leaf because the
 * editor/viewer header already shows the file name as the title.
 */
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export function ContextDocumentBreadcrumb({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  const ancestors = segments.slice(0, -1);
  if (ancestors.length === 0) return null;
  return (
    <nav
      aria-label="Document path"
      className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-fine text-ink-subtle"
    >
      {ancestors.map((segment, idx) => {
        const key = `${ancestors.slice(0, idx + 1).join("/")}|${segment}`;
        return (
          <span key={key} className="flex items-center gap-1">
            <span className="truncate">{segment}</span>
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-ink-subtle/60")} />
          </span>
        );
      })}
    </nav>
  );
}
