/** SafetyNoticeReceipt — document-scoped receipt for destructive concurrent merges. */
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { IconButton } from "@/components/ui/icon-button";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";

const WRITER_RECEIPT_KINDS = new Set(["late_sweep", "checkpoint_sweep"]);

export function SafetyNoticeReceipt({ session }: { session: DocumentSession }) {
  const [snapshot, setSnapshot] = useState<DocumentSessionSnapshot>(() => session.getSnapshot());

  useEffect(() => session.subscribe(setSnapshot), [session]);

  const notice = snapshot.safetyNotice;
  if (!notice || !WRITER_RECEIPT_KINDS.has(notice.kind)) return null;

  return (
    <section
      className="surface-card flex min-w-0 shrink-0 items-center gap-3 border-border-subtle border-b px-4 py-2"
      data-safety-notice-receipt
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0 flex-1 truncate text-foreground text-sm">
        <Trans>Content was modified, including the writer's edits.</Trans>
      </span>
      <IconButton
        type="button"
        aria-label="Dismiss content change receipt"
        onClick={() => session.dismissSafetyNotice()}
      >
        <X aria-hidden />
      </IconButton>
    </section>
  );
}
