/**
 * TurnCard — the shared shell for writer-facing turn cards.
 *
 * One chrome for `ask_user` interrupts and spawn reports: an icon chip, a
 * title, an optional door (a name-like control that navigates, never a
 * full-row button), an optional hint, and the card body. The tone only tints
 * the icon; status words stay out of the card.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type TurnCardTone = "pending" | "running" | "resolved" | "failed" | "reversible";

export type TurnCardProps = {
  icon: LucideIcon;
  tone: TurnCardTone;
  title: ReactNode;
  door?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
};

const iconTone: Record<TurnCardTone, string> = {
  pending: "text-primary",
  running: "text-primary",
  resolved: "text-muted-foreground",
  failed: "text-destructive",
  reversible: "text-muted-foreground",
};

export function TurnCard({
  icon: Icon,
  tone,
  title,
  door,
  hint,
  children,
  className,
}: TurnCardProps) {
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
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted",
            iconTone[tone],
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm font-medium text-foreground">{title}</p>
            {door ? <div className="shrink-0">{door}</div> : null}
          </div>
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
  tone?: Extract<TurnCardTone, "resolved" | "reversible">;
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
    <TurnCard
      icon={icon}
      tone={tone}
      title={<span className="text-muted-foreground">{title}</span>}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-2 text-foreground text-sm">
        <span className="font-medium">{value}</span>
        <Badge variant="neutral">{statusLabel}</Badge>
      </div>
    </TurnCard>
  );
}
