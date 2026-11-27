import { t } from "@lingui/core/macro";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { collapseBreadcrumbSegments } from "./context-location";

export type MobileBreadcrumbSegment = {
  label: string;
  onSelect?: () => void;
  current?: ReactNode;
};

type BreadcrumbItem =
  | { kind: "segment"; key: string; segment: MobileBreadcrumbSegment }
  | { kind: "ellipsis"; key: string };

function breadcrumbItems(segments: MobileBreadcrumbSegment[]): BreadcrumbItem[] {
  const { leading, elided, trailing } = collapseBreadcrumbSegments(segments);
  const items: BreadcrumbItem[] = leading.map((segment, position) => ({
    kind: "segment",
    key: `segment-${position}`,
    segment,
  }));
  if (elided) items.push({ kind: "ellipsis", key: "ellipsis" });
  const trailingStart = segments.length - trailing.length;
  trailing.forEach((segment, offset) => {
    items.push({ kind: "segment", key: `segment-${trailingStart + offset}`, segment });
  });
  return items;
}

export function MobileBreadcrumb({ segments }: { segments: MobileBreadcrumbSegment[] }) {
  if (segments.length === 0) return null;
  const items = breadcrumbItems(segments);
  const lastIndex = items.length - 1;

  return (
    <nav aria-label={t`Breadcrumb`} className="flex min-w-0 flex-1 items-center">
      {/* Separators live INSIDE each <li> — an <ol> only permits <li>
          children. Width priority is deliberately asymmetric: the last
          segment is what the user is looking at, so ancestors shrink first
          (flex-shrink 3, ~36px floor) while the current segment shrinks
          reluctantly (factor 1). Symmetric shrinking crushed the document
          name to a few characters on deep trails while ancestors kept their
          full 96px caps. */}
      <ol className="flex min-w-0 flex-1 items-center">
        {items.map((item, index) => {
          const separator =
            index > 0 ? (
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            ) : null;
          if (item.kind === "ellipsis") {
            return (
              <li
                aria-hidden
                key={item.key}
                className="flex shrink-0 items-center text-sm text-muted-foreground"
              >
                {separator}
                <span className="px-0.5">…</span>
              </li>
            );
          }
          if (index === lastIndex) {
            return (
              <li aria-current="page" key={item.key} className="flex min-w-0 flex-1 items-center">
                {separator}
                {item.segment.current ? (
                  <div className="-my-3 flex min-w-0 flex-1 items-center">
                    {item.segment.current}
                  </div>
                ) : (
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {item.segment.label}
                  </span>
                )}
              </li>
            );
          }
          return (
            <li key={item.key} className="flex min-w-9 shrink-[3] items-center">
              {separator}
              {item.segment.onSelect ? (
                <button
                  type="button"
                  onClick={item.segment.onSelect}
                  className="focus-ring -my-3 flex h-11 min-w-0 max-w-24 items-center rounded-md px-1 text-sm text-muted-foreground active:scale-[0.98]"
                >
                  <span className="truncate">{item.segment.label}</span>
                </button>
              ) : (
                <span className="flex min-w-0 max-w-24 items-center px-1 text-sm text-muted-foreground">
                  <span className="truncate">{item.segment.label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
