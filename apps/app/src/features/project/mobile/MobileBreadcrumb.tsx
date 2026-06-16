/**
 * MobileBreadcrumb — tappable location trail for the phone context screen
 * (a lone root crumb at the Files root, deeper trails when drilled in).
 *
 * Mount-point agnostic on purpose: today it sits left-aligned inside the
 * MobileTopBar (right after the drawer trigger), but it may move to its own
 * row later, so it renders no bar chrome of its own. Ancestor segments navigate (44px-tall touch targets);
 * the last segment is the current location — non-interactive and visually
 * dominant. Deep trails middle-truncate (`first › … › parent › current`) via
 * `collapseBreadcrumbSegments`; long labels truncate per segment with the
 * current segment getting the leftover width.
 */
import { t } from "@lingui/core/macro";
import { ChevronRight } from "lucide-react";

import { collapseBreadcrumbSegments } from "./context-location";

export type MobileBreadcrumbSegment = {
  label: string;
  /** Navigates to this ancestor. Omitted on the last (current) segment. */
  onSelect?: () => void;
};

/**
 * Display-list entry. `key` is the segment's position in the *original*
 * trail (stable identity — labels may repeat, e.g. `/a/a/a`); the elision
 * marker renders as `…` between leading and trailing runs.
 */
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
    <nav aria-label={t`Breadcrumb`} className="flex min-w-0 items-center">
      {/* Separators live INSIDE each <li> — an <ol> only permits <li>
          children. Width priority is deliberately asymmetric: the last
          segment is what the user is looking at, so ancestors shrink first
          (flex-shrink 3, ~36px floor) while the current segment shrinks
          reluctantly (factor 1). Symmetric shrinking crushed the document
          name to a few characters on deep trails while ancestors kept their
          full 96px caps. */}
      <ol className="flex min-w-0 items-center">
        {items.map((item, index) => {
          const separator =
            index > 0 ? (
              <ChevronRight aria-hidden className="size-3 shrink-0 text-ink-subtle" />
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
              <li aria-current="page" key={item.key} className="flex min-w-0 items-center">
                {separator}
                <span className="block truncate text-sm font-semibold text-foreground">
                  {item.segment.label}
                </span>
              </li>
            );
          }
          return (
            <li key={item.key} className="flex min-w-9 shrink-[3] items-center">
              {separator}
              <button
                type="button"
                onClick={item.segment.onSelect}
                className="focus-ring flex h-11 min-w-0 max-w-24 items-center rounded-md px-1 text-sm text-muted-foreground active:scale-[0.98]"
              >
                <span className="truncate">{item.segment.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
