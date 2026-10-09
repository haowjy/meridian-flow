/** One group of the Work Files tab (Changes to review, Scratch), with its placeholders. */
import { t } from "@lingui/core/macro";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { GroupLabel } from "../RuledList";

export function WorkFileGroup({
  label,
  actions,
  children,
}: {
  label: string;
  /** Controls for the whole group, on the label's line. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 pb-2 [section+&]:pt-5" aria-label={label}>
      {actions ? (
        <div className="flex min-h-6 items-center gap-2 pb-2">
          <GroupLabel as="h2" className="min-w-0 flex-1 pb-0">
            {label}
          </GroupLabel>
          {actions}
        </div>
      ) : (
        <GroupLabel as="h2">{label}</GroupLabel>
      )}
      {children}
    </section>
  );
}

export function WorkFileGroupLoading() {
  return (
    <div role="status" aria-label={t`Loading`} className="space-y-3 py-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

export function WorkFileGroupNote({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}
