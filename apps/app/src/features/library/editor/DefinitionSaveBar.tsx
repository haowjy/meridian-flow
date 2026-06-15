/**
 * DefinitionSaveBar — explicit save affordance and inline save-state feedback.
 */
import { Trans } from "@lingui/react/macro";

import { cn } from "@/lib/utils";

export type DefinitionSaveState = "pristine" | "dirty" | "saving" | "saved" | "error" | "disabled";

export function DefinitionSaveBar({
  state,
  errorMessage,
  onSave,
}: {
  state: DefinitionSaveState;
  errorMessage?: string | null;
  onSave: () => void;
}) {
  const canSave = state === "dirty" || state === "error";

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle bg-background px-6 py-3">
      <div className="flex items-center justify-between gap-3">
        <SaveStatus state={state} />
        <button
          type="button"
          disabled={!canSave}
          onClick={onSave}
          className={cn(
            "focus-ring rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            canSave
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "cursor-not-allowed bg-surface-subtle text-muted-foreground",
          )}
        >
          {state === "saving" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </button>
      </div>
      {state === "error" && errorMessage ? (
        <p className="text-meta text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}

function SaveStatus({ state }: { state: DefinitionSaveState }) {
  switch (state) {
    case "pristine":
      return (
        <span className="text-meta text-muted-foreground">
          <Trans>All changes saved</Trans>
        </span>
      );
    case "dirty":
      return (
        <span className="text-meta text-muted-foreground">
          <Trans>Unsaved changes</Trans>
        </span>
      );
    case "saving":
      return (
        <span className="text-meta text-muted-foreground">
          <Trans>Saving…</Trans>
        </span>
      );
    case "saved":
      return (
        <span className="text-meta text-muted-foreground">
          <Trans>Saved</Trans>
        </span>
      );
    case "error":
      return (
        <span className="text-meta text-destructive">
          <Trans>Could not save</Trans>
        </span>
      );
    case "disabled":
      return (
        <span className="text-meta text-muted-foreground">
          <Trans>Read-only</Trans>
        </span>
      );
  }
}
