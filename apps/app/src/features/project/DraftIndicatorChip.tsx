/** DraftIndicatorChip — additive thread-list badge for pending AI drafts. */
import { FileText } from "lucide-react";

import { draftIndicatorDisplay } from "./lifecycle";

export function DraftIndicatorChip({ count }: { count: number }) {
  const display = draftIndicatorDisplay(count);
  if (!display) return null;
  return (
    <span className={display.className} role="img" aria-label={display.label} title={display.label}>
      <FileText className={display.iconClassName} aria-hidden />
      <span>{count}</span>
    </span>
  );
}
