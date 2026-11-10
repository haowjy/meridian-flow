/**
 * What a search-match door says when the passage it promised has moved on.
 *
 * Floats over the top of the document rather than pushing a strip into the
 * layout: the writer arrived to read, and a notice that shoves the page down
 * and then lets it snap back costs more attention than it gives. It blocks
 * nothing and never claims to know where the passage went.
 *
 * When the notice goes is `passage-notice-store`'s business, because it
 * outlives whichever document happens to be on screen.
 */
import { t } from "@lingui/core/macro";

import { usePassageNotice } from "@/core/editor/passage-notice-store";
import { EditorNoticePill } from "./chrome/EditorNotice";

export function PassageNotice({ documentId }: { documentId: string | null }) {
  if (!usePassageNotice(documentId)) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <EditorNoticePill
        notice={{ tone: "done", message: t`That passage changed after this search.` }}
        className="slide-in-from-top-1"
      />
    </div>
  );
}
