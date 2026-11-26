import { t } from "@lingui/core/macro";

import { usePassageNotice } from "@/core/editor/passage-notice-store";
import { EditorNoticePill } from "./chrome/EditorNotice";

export function PassageNotice({ documentId }: { documentId: string | null }) {
  if (!usePassageNotice(documentId)) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <EditorNoticePill
        notice={{ tone: "done", message: t`Passage changed` }}
        className="slide-in-from-top-1"
      />
    </div>
  );
}
