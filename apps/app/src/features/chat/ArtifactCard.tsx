/**
 * ArtifactCard — the shared chrome for a writer-facing artifact (see
 * `tool-kind.ts`): the card-shaped half of the turn, opposite the collapsed
 * Thinking process.
 *
 * One shell for `ask_user` interrupts, spawn reports, and child Returns: an
 * icon chip, a title, an optional door (a name-like control that navigates,
 * never a full-row button), an optional hint, and the card body. The tone only
 * tints the icon; status words stay out of the card.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ArtifactCardTone = "pending" | "running" | "resolved" | "failed" | "reversible";

export type ArtifactCardProps = {
  icon: LucideIcon;
  tone: ArtifactCardTone;
  /** The card's heading, rendered above the body. */
  title?: ReactNode;
  door?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
};

const iconTone: Record<ArtifactCardTone, string> = {
  pending: "text-primary",
  running: "text-primary",
  resolved: "text-muted-foreground",
  failed: "text-destructive",
  reversible: "text-muted-foreground",
};

export function ArtifactCard({
  icon: Icon,
  tone,
  title,
  door,
  hint,
  children,
  className,
}: ArtifactCardProps) {
  return (
    <section
      className={cn(
        "surface-card rounded-xl border border-border-subtle px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] shadow-xs",
        className,
      )}
    >
      <div className="flex items-start gap-[var(--chat-space-inline)]">
        <div
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted",
            iconTone[tone],
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-[var(--chat-space-block)]">
            {title ? (
              <p className="min-w-0 text-sm font-medium text-foreground">{title}</p>
            ) : (
              <span />
            )}
            {door ? <div className="shrink-0">{door}</div> : null}
          </div>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {children ? <div className="mt-[var(--chat-space-block)]">{children}</div> : null}
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
  tone?: Extract<ArtifactCardTone, "resolved" | "reversible">;
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
    <ArtifactCard
      icon={icon}
      tone={tone}
      title={<span className="text-muted-foreground">{title}</span>}
      className={className}
    >
      <div className="flex flex-wrap items-center gap-[var(--chat-space-inline)] text-foreground text-sm">
        <span className="font-medium">{value}</span>
        <Badge variant="neutral">{statusLabel}</Badge>
      </div>
    </ArtifactCard>
  );
}
