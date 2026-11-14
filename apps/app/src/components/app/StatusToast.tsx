import { t } from "@lingui/core/macro";
import { useEffect } from "react";

/** What a toast says; `undo` adds an Undo. A new `id` shows it again. */
export type StatusToastNotice = { id: number; text: string; undo?: () => void };

/**
 * A short status line at the foot of the window for an act whose result shows elsewhere (a
 * restore, a sidebar Undo): it says what happened and goes by itself, later when it offers Undo.
 */
export function StatusToast({
  notice,
  onDismiss,
}: {
  notice: StatusToastNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, notice.undo ? 8_000 : 4_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      role="status"
      className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-md bg-foreground px-3 py-1.5 text-background text-xs shadow-float"
    >
      <span>{notice.text}</span>
      {notice.undo ? (
        <button
          type="button"
          className="font-semibold underline underline-offset-2"
          onClick={() => {
            notice.undo?.();
            onDismiss();
          }}
        >
          {t`Undo`}
        </button>
      ) : null}
    </div>
  );
}
