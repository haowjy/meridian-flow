/**
 * The line over a trashed chat's draft, wherever it is open, with Restore: the chat-owned
 * counterpart of the archived Work's notice. Every chat of the lineage is in Trash, so the
 * server takes no text or Apply on its drafts, only a whole Discard.
 * Restore brings back the lineage's first chat. The drafts stay read-only until the server
 * has restored it and the draft list says so: thawing first would let the writer type into a
 * room that still drops their text. A refusal shows here. The restore goes through the project's
 * chat deletes, so a "Deleted" notice for the same chat ends with it.
 */
import { Trans } from "@lingui/react/macro";
import { parseDraftOwnerKey } from "@meridian/contracts/branches";
import { ArchiveRestore } from "lucide-react";
import { useState } from "react";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { useChatDeletes } from "@/features/project/shell/sidebar/ChatDeleteProvider";
import { cn } from "@/lib/utils";

export function TrashedChatNotice({
  ownerKey,
  className,
}: {
  /** The frozen lineage's owner key. */
  ownerKey: string;
  className?: string;
}) {
  const deletes = useChatDeletes();
  const [state, setState] = useState<"idle" | "restoring" | "failed">("idle");
  const rootThreadId = parseDraftOwnerKey(ownerKey)?.id;
  const restore = () => {
    if (!rootThreadId || state === "restoring") return;
    setState("restoring");
    void deletes
      .restore(rootThreadId)
      .then((outcome) => setState(outcome.status === "success" ? "idle" : "failed"));
  };
  return (
    <div className={cn("min-w-0", className)}>
      <DocumentNotice
        icon={<ArchiveRestore className="size-4" aria-hidden />}
        action={
          <Button size="sm" variant="outline" disabled={state === "restoring"} onClick={restore}>
            <Trans>Restore</Trans>
          </Button>
        }
      >
        <Trans>This chat is in Trash. Restore it to edit or apply its drafts.</Trans>
      </DocumentNotice>
      {state === "failed" ? (
        <InlineErrorRow
          message={<Trans>Couldn't restore the chat. Try again.</Trans>}
          className="px-0 pt-2 pb-0"
        />
      ) : null}
    </div>
  );
}
