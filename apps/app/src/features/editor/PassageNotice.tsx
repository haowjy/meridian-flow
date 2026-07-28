/**
 * What a search-match door says when the passage it promised has moved on.
 *
 * Floats over the top of the document rather than pushing a strip into the
 * layout: the writer arrived to read, and a notice that shoves the page down
 * and then lets it snap back costs more attention than it gives. It blocks
 * nothing and never claims to know where the passage went.
 *
 * Purely presentational. When the notice goes is `passage-notice-store`'s
 * business, because it outlives whichever document happens to be on screen.
 */
import { Trans } from "@lingui/react/macro";

import { usePassageNotice } from "@/core/editor/passage-notice-store";

export function PassageNotice({ documentId }: { documentId: string | null }) {
  if (!usePassageNotice(documentId)) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <p
        role="status"
        className="animate-in rounded-full border border-border bg-card px-3 py-1 text-caption text-ink-muted shadow-card fade-in-0 slide-in-from-top-1"
      >
        <Trans>That passage changed after this search.</Trans>
      </p>
    </div>
  );
}
