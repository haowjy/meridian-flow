import { Check, AlertTriangle, Minus, X, LucideIcon } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { DialogFooter } from "@/shared/components/ui/dialog";
import { Label } from "@/shared/components/ui/label";
import { ImportResponse } from "@/core/lib/api";

/**
 * Configuration for action status icons.
 * Extensible: add new actions here when backend adds new action types.
 */
const ACTION_CONFIG: Record<string, { icon: LucideIcon; className: string }> = {
  created: { icon: Check, className: "text-success" },
  updated: { icon: AlertTriangle, className: "text-warning" },
  skipped: { icon: Minus, className: "text-muted-foreground" },
  failed: { icon: X, className: "text-destructive" },
} as const;

interface ImportResultsProps {
  results: ImportResponse;
  onClose: () => void;
  onImportMore: () => void;
}

export function ImportResults({
  results,
  onClose,
  onImportMore,
}: ImportResultsProps) {
  const { summary, documents, errors } = results;

  return (
    <>
      <div className="grid gap-3 py-2">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <StatBadge
            label="Created"
            value={summary.created}
            variant="success"
          />
          <StatBadge
            label="Updated"
            value={summary.updated}
            variant="default"
          />
          <StatBadge label="Skipped" value={summary.skipped} variant="muted" />
          <StatBadge label="Failed" value={summary.failed} variant="error" />
        </div>

        {/* Documents List */}
        {documents.length > 0 && (
          <div className="space-y-2">
            <Label>Results</Label>
            <div className="border-border bg-muted/20 max-h-48 space-y-1 overflow-y-auto rounded border p-3">
              {documents.map((doc, idx) => (
                <div
                  key={doc.id || idx}
                  className="flex items-center gap-2 text-sm"
                >
                  <ActionIcon action={doc.action} />
                  <span className="flex-1 truncate font-mono text-xs break-all whitespace-normal">
                    {doc.path || doc.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error List */}
        {errors.length > 0 && (
          <div className="space-y-2">
            <Label className="text-destructive">Failed Imports</Label>
            <div className="border-destructive/30 bg-destructive/5 max-h-32 space-y-2 overflow-y-auto rounded border p-3">
              {errors.map((err, idx) => (
                <div key={idx} className="space-y-0.5 text-sm">
                  <div className="text-destructive font-medium break-all">
                    {err.file}
                  </div>
                  <div className="text-muted-foreground text-xs break-words">
                    {err.error}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onImportMore}>
          Import More
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

// Helper component for action icons - uses ACTION_CONFIG for extensibility
function ActionIcon({ action }: { action: string }) {
  const config = (ACTION_CONFIG[action] ?? ACTION_CONFIG.failed)!;
  const Icon = config.icon;
  return <Icon className={`size-4 shrink-0 ${config.className}`} />;
}

// Helper component for stat badges
function StatBadge({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "success" | "error" | "muted" | "default";
}) {
  const colorClass =
    variant === "success"
      ? "text-primary"
      : variant === "error"
        ? "text-destructive"
        : variant === "muted"
          ? "text-muted-foreground"
          : "text-foreground";

  return (
    <div>
      <div className={`text-2xl font-semibold ${colorClass}`}>{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}
