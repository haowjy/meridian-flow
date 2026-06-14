// @ts-nocheck
/**
 * SpikeRailSurface — a "cheap" rail surface containing a REAL Radix dropdown
 * (DropdownMenu / DropdownMenuRadioGroup / DropdownMenuRadioItem), used by
 * Gate #5 to prove the same portal path works for ALL surfaces — not just the
 * heavyweight editor.
 *
 * The dropdown MUST open from inside the reverse-portal and position
 * correctly. Radix's Portal lives off the React tree but uses the trigger's
 * DOM position; since react-reverse-portal moves the actual DOM node into the
 * target slot, the Radix portal coordinates resolve against the new location.
 *
 * Theme / Query / Router context must also resolve — Radix wrappers reach for
 * the design tokens via CSS variables, which are inherited through the DOM,
 * not React, so this works for free.
 */
import { Layers } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type GroupBy = "work" | "date" | "flat";

export function SpikeRailSurface({ onMount }: { onMount?: () => void }) {
  useEffect(() => {
    onMount?.();
  }, []);

  const [groupBy, setGroupBy] = useState<GroupBy>("work");
  const [filter, setFilter] = useState("");

  const items = [
    { id: "a", label: "Thread alpha", group: "Recent work" },
    { id: "b", label: "Thread beta", group: "Recent work" },
    { id: "c", label: "Thread gamma", group: "Recent work" },
    { id: "d", label: "Thread delta", group: "Archived" },
    { id: "e", label: "Thread epsilon", group: "Archived" },
    { id: "f", label: "Thread zeta", group: "Archived" },
  ].filter((it) => (filter ? it.label.toLowerCase().includes(filter.toLowerCase()) : true));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 text-meta text-muted-foreground">
        <span className="uppercase tracking-wide">Rail</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Group by: ${groupBy}`}
              className="relative size-7 shrink-0 border-border-subtle bg-card p-0"
              data-spike-rail-dropdown-trigger
            >
              <Layers className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
              <DropdownMenuRadioItem value="work">Work</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="date">Date</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="flat">Flat</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="shrink-0 border-b border-border bg-card px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="focus-ring w-full rounded-md border border-border bg-background px-2 py-1 text-meta text-foreground placeholder:text-muted-foreground"
          data-spike-rail-filter
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        <ul className="flex flex-col gap-0.5">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="focus-ring w-full rounded-md px-2 py-1.5 text-left text-body text-foreground transition-colors hover:bg-muted"
              >
                <span className="block truncate">{it.label}</span>
                <span className="block text-meta text-muted-foreground">
                  {it.group} · grouped by {groupBy}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
