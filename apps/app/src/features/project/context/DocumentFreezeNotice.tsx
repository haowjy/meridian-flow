/** The one line over a frozen document, worded for what froze it, with the way back. */
import { TrashedChatNotice } from "@/features/draft-review/TrashedChatNotice";
import { ArchivedWorkNotice } from "../work/ArchivedWorkNotice";
import type { DocumentFreeze } from "./use-document-freeze";

export function DocumentFreezeNotice({
  projectId,
  freeze,
  className,
}: {
  projectId: string;
  freeze: DocumentFreeze;
  className?: string;
}) {
  return freeze.kind === "work" ? (
    <ArchivedWorkNotice projectId={projectId} work={freeze.work} className={className} />
  ) : (
    <TrashedChatNotice ownerKey={freeze.ownerKey} className={className} />
  );
}
