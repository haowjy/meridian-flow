/** ComponentCard — shared shell for inline component-block and draft-review cards. */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ComponentCardTone = "pending" | "resolved" | "reversible";

export type ComponentCardProps = {
  icon: LucideIcon;
  tone: ComponentCardTone;
  eyebrow?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function ComponentCard({
  icon: Icon,
  tone,
  eyebrow,
  title,
  hint,
  children,
  className,
}: ComponentCardProps) {
  return (
    <section
      className={cn(
        "surface-card mb-4 rounded-xl border border-border-subtle px-4 py-3 shadow-xs",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-subtle",
            tone === "pending" ? "text-primary" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <p className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <p className="text-sm font-medium text-foreground">{title}</p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </section>
  );
}

export type ComponentResolvedSummaryProps = {
  icon: LucideIcon;
  title: ReactNode;
  value: ReactNode;
  statusLabel: ReactNode;
  tone?: Extract<ComponentCardTone, "resolved" | "reversible">;
  className?: string;
};

export function ComponentResolvedSummary({
  icon,
  title,
  value,
  statusLabel,
  tone = "resolved",
  className,
}: ComponentResolvedSummaryProps) {
  return (
    <ComponentCard
      icon={icon}
      tone={tone}
      title={<span className="text-muted-foreground">{title}</span>}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-2 text-foreground text-sm">
        <span className="font-medium">{value}</span>
        <span className="status-pill">{statusLabel}</span>
      </div>
    </ComponentCard>
  );
}
