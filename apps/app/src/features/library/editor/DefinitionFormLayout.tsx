/**
 * DefinitionFormLayout — shared label/control rows for Library definition editors.
 *
 * Matches the settings dialog field treatment: desktop label column + control,
 * stacked on narrow detail panes.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function DefinitionSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-meta text-muted-foreground">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function DefinitionField({
  label,
  hint,
  children,
  emphasized = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border-subtle px-3 py-2",
        emphasized ? "bg-muted" : "bg-card",
      )}
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      {hint ? <span className="text-meta text-muted-foreground">{hint}</span> : null}
      {children}
    </div>
  );
}
