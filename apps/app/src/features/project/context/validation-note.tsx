/**
 * ValidationNote — the one input-validation look: a bordered note in
 * destructive tones. Every input error in the context feature renders this,
 * so they all read the same: the tree's floating rename overlay
 * (`InlineValidationOverlay`) and inline hosts like the save bar's location
 * browser.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ContextEntryNameSeverity } from "./context-entry-name";

export function ValidationNote({
  severity,
  action,
  className,
}: {
  severity: ContextEntryNameSeverity;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={severity.level === "error" ? "alert" : "status"}
      className={cn(
        "rounded-sm border bg-background px-1.5 py-1 text-meta leading-snug",
        severity.level === "error"
          ? "border-destructive text-destructive"
          : "border-destructive-border text-foreground",
        className,
      )}
    >
      {severity.message}
      {action}
    </div>
  );
}
